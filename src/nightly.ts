import type { Env } from "./env";
import { MODELS, runAgent } from "./claude";
import { getRecentOrders, getTraffic7d } from "./ebay/sell";
import { healthFlags, type Flag, type ListingFacts } from "./health";
import { AUDIT_TOOLS } from "./jobs";
import { push } from "./notify";
import { expireStale } from "./proposals";
import { snapshotListings } from "./snapshot";
import { learnParams } from "./pricing/learn";
import { bundleAdvice } from "./pricing/bundles";
import { reviewPrices, type ReviewOut } from "./pricing/review";
import { fileHealthTodos, fileOwnPriceReminders, filePriceQuestions, lastSentence } from "./todos";
import { reviewPromotions } from "./promotion";
import { auditDone, runFirstDayAudit } from "./firstday";

// The 02:00 run: read eBay, score listing health by rule, and send only flagged listings to Haiku, which may
// file proposals for K. Each step runs on its own, so one failure (Sandbox has no traffic data, say) doesn't
// stop the rest. The outcome is kept in settings.last_nightly for the Metrics screen.

const MAX_TRIAGED_PER_NIGHT = 5;
/** A change proposed this recently (waiting, approved, agreed as a dry run, or applied) isn't redone by triage. */
export const REVISE_QUIET_DAYS = 7;

/**
 * Listings with a recent listing edit: triage mustn't propose another. While changes are off an approved dry
 * run doesn't change eBay, so triage would otherwise read the old listing and undo K's approved edit (2026-11-05:
 * a review removed unsupported specifics from the Maono listing and the same night's triage put them back).
 */
export async function recentlyRevised(env: Env, now: number, kind: "revise" | "price" = "revise"): Promise<Set<string>> {
  const rows = await env.store.proposals.listWhere([
    { f: "kind", op: "=", v: kind },
    { f: "status", op: "in", v: ["pending", "approved", "agreed", "applied"] },
    { f: "created_at", op: ">", v: now - REVISE_QUIET_DAYS * 86_400_000 },
  ]);
  return new Set(rows.map((p) => p.item_id).filter((x): x is string => Boolean(x)));
}

export const TRIAGE_SYSTEM = `A nightly rule check flagged one of K's eBay UK listings. Decide whether one small change would help it sell, and if so propose it. You cannot change eBay: propose_* tools record proposals that K approves or rejects.

K's rules, also enforced in code: prices come from price_check (the pricing engine), never from asking prices alone; propose its price only if it differs by 5% or more and its confidence is at least 0.3, with its strategy and why as the reason; if it says ask, put its question in your note. Returns accepted with the buyer paying return postage; never invent facts about the item.

Guide by flag:
- stale (no watchers after 30 days): the title or price is usually the problem. Run price_check; propose a better title, or its price if the market supports a change.
- watched_not_selling: the price is slightly high. Run price_check and propose its price if it supports a change.
- low_views: the title and item specifics aren't matching searches. Propose a clearer title and missing specifics.
- low_click_through: the price or main photo looks wrong in search. Run price_check; mention the photo in your note.

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
  const open = await env.store.proposals.listWhere([{ f: "status", op: "in", v: ["pending", "approved"] }]);
  const appliedPrices = await env.store.proposals.listWhere([
    { f: "kind", op: "=", v: "price" },
    { f: "status", op: "=", v: "applied" },
  ]);
  const results = (await env.store.listings.latestSet()).map((l) => ({
    ...l,
    pending: open.filter((p) => p.item_id === l.item_id).length,
    last_price_change: appliedPrices.filter((p) => p.item_id === l.item_id).reduce<number | null>((m, p) => (p.decided_at != null && (m == null || p.decided_at > m) ? p.decided_at : m), null),
  }));
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
    await env.store.orders.upsertFromApi(orders);
    return `${orders.length} orders`;
  });
  await step(steps, "traffic", async () => {
    const rows = await getTraffic7d(env);
    await env.store.listings.writeTraffic(at, rows);
    return `${rows.length} listings`;
  });

  const flagged: NightlyResult["flagged"] = [];
  await step(steps, "health", async () => {
    for (const l of await listingFacts(env)) {
      const flags = healthFlags(l, at);
      if (flags.length) flagged.push({ itemId: l.itemId, flags });
    }
    if (flagged.length)
      await env.store.jobs.recordHealthFlags(
        at,
        flagged.flatMap((f) => f.flags.map((fl) => ({ item_id: f.itemId, flag: fl.flag, detail: fl.detail }))),
      );
    return `${flagged.length} flagged`;
  });

  // The pricing engine re-prices a few listings and proposes changes the market supports, before triage,
  // so triage sees those proposals as pending and doesn't repeat them.
  // Its questions become Inbox to-dos for the listings it priced (src/todos.ts).
  const review: ReviewOut = { priced: [], asked: [] };
  await step(steps, "prices", async () => {
    if (!env.TRAWL_API_KEY && !env.COMPSAPI_KEY) return "skipped: no sold-data provider keys";
    const out = await reviewPrices(env, at, { out: review });
    await filePriceQuestions(env, review.priced, review.asked, at);
    return out;
  });

  // Promotion research on the listings the engine has a market picture for (docs/pricing-and-promotion.md).
  await step(steps, "promotion", async () => reviewPromotions(env));

  let triaged = 0;
  const triageNotes = new Map<string, string>();
  await step(steps, "triage", async () => {
    if (!env.ANTHROPIC_API_KEY) return "skipped: no ANTHROPIC_API_KEY";
    const revised = await recentlyRevised(env, at);
    const repriced = await recentlyRevised(env, at, "price");
    for (const f of flagged.slice(0, MAX_TRIAGED_PER_NIGHT)) {
      const noEdit = revised.has(f.itemId);
      const noPrice = repriced.has(f.itemId);
      const r = await runAgent(env, {
        job: `triage:${f.itemId}`,
        model: MODELS.triage,
        system: TRIAGE_SYSTEM,
        prompt:
          `Listing ${f.itemId} was flagged:\n${f.flags.map((x) => `- ${x.flag}: ${x.detail}`).join("\n")}` +
          (noEdit ? "\nA listing edit for it was proposed in the last week: don't propose another." : "") +
          (noPrice ? "\nA price change for it was proposed in the last week: don't propose another." : ""),
        toolNames: AUDIT_TOOLS.filter((t) => !(noEdit && t === "propose_listing_revision") && !(noPrice && t === "propose_price_change")),
        maxTurns: 6,
        effort: "low",
      });
      const note = lastSentence(r.text);
      if (note) triageNotes.set(f.itemId, note);
      triaged++;
    }
    return `${triaged} of ${flagged.length} triaged`;
  });

  // Flagged listings that didn't end in a label become Inbox to-dos; to-dos for ended listings close.
  await step(steps, "todos", async () => {
    const rows = await env.store.listings.latestSet();
    const live = rows.map((l) => ({ itemId: l.item_id, title: l.title }));
    if (!live.length) return "skipped: no listings read";
    const open = await env.store.proposals.listWhere([{ f: "status", op: "in", v: ["pending", "approved"] }]);
    const labelled = new Set(open.map((p) => p.item_id));
    const r = await fileHealthTodos(env, live, flagged, triageNotes, (id) => labelled.has(id), at);
    // Listings on K's own price get a reminder after 30 days unsold.
    const own = await fileOwnPriceReminders(
      env,
      rows.map((l) => ({ itemId: l.item_id, title: l.title, price: l.price, watchers: l.watch_count ?? 0, views7d: l.views_7d ?? null })),
      await env.store.listings.settingsAll(),
      at,
    );
    return `${r.opened + own.opened} opened, ${r.resolved + own.resolved} resolved`;
  });

  // The pricing engine learns from what sold (docs/pricing-engine.md, step 7), then looks for bundles.
  await step(steps, "learn", async () => {
    const r = await learnParams(env, at);
    return `${r.outcomes} outcomes, ${r.groups} groups`;
  });
  await step(steps, "bundles", async () => (env.ANTHROPIC_API_KEY ? bundleAdvice(env, at) : "skipped: no ANTHROPIC_API_KEY"));

  // The first-day audit runs once, on the first night after the account connects (or K runs it from the app).
  await step(steps, "first_day_audit", async () => {
    if (await auditDone(env)) return "already done";
    const r = await runFirstDayAudit(env);
    return `${r.findings.length} findings, ${r.proposals.length} proposals`;
  });

  const made = (await env.store.proposals.listWhere([{ f: "created_at", op: ">=", v: at }])).length;
  const result: NightlyResult = { at, steps, flagged, triaged, proposals: made };
  await env.store.kv.setJson("last_nightly", result);
  if (result.proposals) await push(env, `Nightly check: ${result.proposals} to review`, `${flagged.length} listings flagged.`, undefined, "nightly");
  return result;
}
