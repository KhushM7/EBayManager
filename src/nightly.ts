import type { Env } from "./env";
import { MODELS, runAgent } from "./claude";
import { getRecentOrders, getTraffic7d } from "./ebay/sell";
import { healthFlags, type Flag, type ListingFacts } from "./health";
import { AUDIT_TOOLS } from "./jobs";
import { push } from "./notify";
import { expireStale } from "./proposals";
import { snapshotListings } from "./snapshot";

// The 02:00 run: read eBay, score listing health by rule, and send only flagged listings to Haiku, which may
// file proposals for K. Each step runs on its own, so one failure (Sandbox has no traffic data, say) doesn't
// stop the rest. The outcome is kept in settings.last_nightly for the Metrics screen.

const MAX_TRIAGED_PER_NIGHT = 5;

export const TRIAGE_SYSTEM = `A nightly rule check flagged one of K's eBay UK listings. Decide whether one small change would help it sell, and if so propose it. You cannot change eBay: propose_* tools record proposals that K approves or rejects.

K's rules, also enforced in code: price at the lower end of comparable sold prices, adjusted for condition (search_active_comps gives asking prices, which run above sold prices); returns accepted with the buyer paying return postage; never invent facts about the item.

Guide by flag:
- stale (no watchers after 30 days): the title or price is usually the problem. Check comps; propose a better title, or a price step if comps are clearly lower.
- watched_not_selling: the price is slightly high. Propose a price step of 5 to 10% if comps support it.
- low_views: the title and item specifics aren't matching searches. Propose a clearer title and missing specifics.
- low_click_through: the price or main photo looks wrong in search. Check the price against comps; mention the photo in your note.

Make at most one proposal, or none if nothing clearly helps. End with one sentence for K.`;

export interface NightlyResult {
  at: number;
  steps: Record<string, string>;
  flagged: { itemId: string; flags: Flag[] }[];
  triaged: number;
  proposals: number;
}

async function step(steps: Record<string, string>, name: string, fn: () => Promise<string>) {
  try {
    steps[name] = await fn();
  } catch (e) {
    steps[name] = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }
}

export async function listingFacts(env: Env): Promise<ListingFacts[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.item_id, s.title, s.price, s.watch_count, s.start_time,
            (SELECT views_7d FROM listing_traffic t WHERE t.item_id = s.item_id ORDER BY taken_at DESC LIMIT 1) AS views_7d,
            (SELECT impressions_7d FROM listing_traffic t WHERE t.item_id = s.item_id ORDER BY taken_at DESC LIMIT 1) AS impressions_7d,
            (SELECT COUNT(*) FROM proposals p WHERE p.item_id = s.item_id AND p.status IN ('pending', 'approved')) AS pending,
            (SELECT MAX(decided_at) FROM proposals p WHERE p.item_id = s.item_id AND p.kind = 'price' AND p.status = 'applied') AS last_price_change
     FROM listing_snapshots s WHERE s.taken_at = (SELECT MAX(taken_at) FROM listing_snapshots)`,
  ).all<any>();
  return results.map((r) => ({
    itemId: r.item_id,
    title: r.title,
    price: r.price,
    watchCount: r.watch_count ?? 0,
    startTime: r.start_time,
    views7d: r.views_7d,
    impressions7d: r.impressions_7d,
    pendingProposals: r.pending,
    lastPriceChangeAt: r.last_price_change,
  }));
}

export async function runNightly(env: Env): Promise<NightlyResult> {
  const at = Date.now();
  const steps: Record<string, string> = {};

  await step(steps, "snapshot", async () => `${(await snapshotListings(env)).count} listings`);
  await step(steps, "expire", async () => (await expireStale(env), "done"));
  await step(steps, "orders", async () => {
    const orders = await getRecentOrders(env);
    const stmts = orders.flatMap((o) => [
      env.DB.prepare(
        `INSERT INTO orders (order_id, created_at, total, fees, currency, status) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET total = excluded.total, fees = excluded.fees, status = excluded.status`,
      ).bind(o.orderId, o.createdAt, o.total, o.fees, o.currency, o.status),
      ...o.items.map((i) =>
        env.DB.prepare("INSERT OR REPLACE INTO order_items (order_id, item_id, title, quantity, price) VALUES (?, ?, ?, ?, ?)").bind(
          o.orderId,
          i.itemId,
          i.title,
          i.quantity,
          i.price,
        ),
      ),
    ]);
    if (stmts.length) await env.DB.batch(stmts);
    return `${orders.length} orders`;
  });
  await step(steps, "traffic", async () => {
    const rows = await getTraffic7d(env);
    if (rows.length)
      await env.DB.batch(
        rows.map((r) =>
          env.DB.prepare("INSERT OR REPLACE INTO listing_traffic (item_id, taken_at, views_7d, impressions_7d) VALUES (?, ?, ?, ?)").bind(
            r.itemId,
            at,
            r.views,
            r.impressions,
          ),
        ),
      );
    return `${rows.length} listings`;
  });

  const flagged: NightlyResult["flagged"] = [];
  await step(steps, "health", async () => {
    for (const l of await listingFacts(env)) {
      const flags = healthFlags(l, at);
      if (flags.length) flagged.push({ itemId: l.itemId, flags });
    }
    if (flagged.length)
      await env.DB.batch(
        flagged.flatMap((f) =>
          f.flags.map((fl) =>
            env.DB.prepare("INSERT OR REPLACE INTO health_flags (item_id, checked_at, flag, detail) VALUES (?, ?, ?, ?)").bind(
              f.itemId,
              at,
              fl.flag,
              fl.detail,
            ),
          ),
        ),
      );
    return `${flagged.length} flagged`;
  });

  let triaged = 0;
  await step(steps, "triage", async () => {
    if (!env.ANTHROPIC_API_KEY) return "skipped: no ANTHROPIC_API_KEY";
    for (const f of flagged.slice(0, MAX_TRIAGED_PER_NIGHT)) {
      await runAgent(env, {
        job: `triage:${f.itemId}`,
        model: MODELS.triage,
        system: TRIAGE_SYSTEM,
        prompt: `Listing ${f.itemId} was flagged:\n${f.flags.map((x) => `- ${x.flag}: ${x.detail}`).join("\n")}`,
        toolNames: AUDIT_TOOLS,
        maxTurns: 6,
        effort: "low",
      });
      triaged++;
    }
    return `${triaged} of ${flagged.length} triaged`;
  });

  const made = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE created_at >= ?").bind(at).first<{ n: number }>();
  const result: NightlyResult = { at, steps, flagged, triaged, proposals: made?.n ?? 0 };
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_nightly', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(result))
    .run();
  if (result.proposals) await push(env, `Nightly check: ${result.proposals} to review`, `${flagged.length} listings flagged.`, undefined, "nightly");
  return result;
}
