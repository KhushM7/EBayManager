import type { Env } from "../env";
import { DEFAULT_PARAMS, fitParams, outcomesFromSnapshots, type Outcome } from "./model";

// Step 7 of the pricing engine (docs/pricing-engine.md): learn how price-sensitive buyers are (tau) and how
// well listings convert (alpha), per category group, from what actually happened:
// - competitors' listings seen in one daily snapshot and gone a few days later (probably sold), or still there;
// - K's own priced listings: sold after t days, or not yet.
// Parameters are shrunk toward the global fit, which is shrunk toward the defaults, so thin data can't swing them.

const DAY = 86_400_000;

/** Pairs of snapshots of the same search, 3 to 21 days apart, from the last 120 days. */
async function snapshotOutcomes(env: Env, since: number): Promise<Map<string, Outcome[]>> {
  const { results } = await env.DB.prepare(
    "SELECT key, taken_at, item_id, total, grp, market, share FROM market_snapshots WHERE taken_at > ? ORDER BY key, taken_at",
  )
    .bind(since)
    .all<{ key: string; taken_at: number; item_id: string; total: number; grp: string; market: number; share: number }>();
  const byKey = new Map<string, Map<number, typeof results>>();
  for (const r of results) {
    const snaps = byKey.get(r.key) ?? new Map();
    snaps.set(r.taken_at, [...(snaps.get(r.taken_at) ?? []), r]);
    byKey.set(r.key, snaps);
  }
  const byGroup = new Map<string, Outcome[]>();
  for (const snaps of byKey.values()) {
    const times = [...snaps.keys()].sort((a, b) => a - b);
    // Non-overlapping pairs: each snapshot is the "before" of the next one at least 3 days later.
    let i = 0;
    while (i < times.length) {
      const j = times.findIndex((t) => t - times[i] >= 3 * DAY);
      if (j < 0) break;
      const days = (times[j] - times[i]) / DAY;
      if (days <= 21) {
        const before = snaps.get(times[i])!;
        const after = snaps.get(times[j])!;
        const { grp, market, share } = before[0];
        const out = outcomesFromSnapshots(
          before.map((b) => ({ itemId: b.item_id, total: b.total })),
          after.map((a) => ({ itemId: a.item_id })),
          days,
          market,
          share,
        );
        byGroup.set(grp, [...(byGroup.get(grp) ?? []), ...out]);
      }
      i = j;
    }
  }
  return byGroup;
}

/** K's own priced listings: did they sell (an order for the item after the decision), and when? */
async function ownOutcomes(env: Env, since: number): Promise<Map<string, Outcome[]>> {
  const { results } = await env.DB.prepare(
    `SELECT d.item_id, d.at, d.grp, d.total, d.market_price, d.result,
            (SELECT MIN(o.created_at) FROM order_items i JOIN orders o ON o.order_id = i.order_id WHERE i.item_id = d.item_id AND o.created_at > d.at) AS sold_at
     FROM price_decisions d WHERE d.at > ? AND d.item_id IS NOT NULL AND d.total IS NOT NULL AND d.market_price > 0`,
  )
    .bind(since)
    .all<{ item_id: string; at: number; grp: string; total: number; market_price: number; result: string; sold_at: number | null }>();
  const byGroup = new Map<string, Outcome[]>();
  for (const r of results) {
    const m = JSON.parse(r.result)?.components?.[0]?.market;
    const share = m ? Math.max(m.demand28, m.demand91) / (m.supply + 1) : 0;
    if (!share) continue;
    const days = ((r.sold_at ?? Date.now()) - r.at) / DAY;
    if (days < 1) continue;
    byGroup.set(r.grp, [...(byGroup.get(r.grp) ?? []), { rel: r.total / r.market_price, days, sold: r.sold_at != null, share }]);
  }
  return byGroup;
}

export async function learnParams(env: Env, now = Date.now()): Promise<{ groups: number; outcomes: number }> {
  const since = now - 120 * DAY;
  const groups = await snapshotOutcomes(env, since);
  // K's own outcomes count 5 times: they're the listings being priced, and there are far fewer of them.
  for (const [g, out] of await ownOutcomes(env, since)) groups.set(g, [...(groups.get(g) ?? []), ...out.flatMap((o) => Array(5).fill(o))]);

  const all = [...groups.values()].flat();
  const global = fitParams(all, DEFAULT_PARAMS);
  const rows: [string, { tau: number; alpha: number; n: number }][] = [["all", global]];
  for (const [g, out] of groups) if (g !== "all") rows.push([g, fitParams(out, global)]);
  if (all.length)
    await env.DB.batch(
      rows.map(([g, p]) =>
        env.DB.prepare("INSERT OR REPLACE INTO pricing_params (grp, tau, alpha, n, updated_at) VALUES (?, ?, ?, ?, ?)").bind(g, p.tau, p.alpha, p.n, now),
      ),
    );
  // Snapshots older than 180 days aren't used again.
  await env.DB.prepare("DELETE FROM market_snapshots WHERE taken_at < ?").bind(now - 180 * DAY).run();
  return { groups: rows.length, outcomes: all.length };
}
