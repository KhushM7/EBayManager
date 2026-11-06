import type { Env } from "../env";
import { orderLines } from "../store";
import { DEFAULT_PARAMS, fitParams, outcomesFromSnapshots, type Outcome } from "./model";

// Step 7 of the pricing engine (docs/pricing-engine.md): learn how price-sensitive buyers are (tau) and how
// well listings convert (alpha), per category group, from what actually happened:
// - competitors' listings seen in one daily snapshot and gone a few days later (probably sold), or still there;
// - K's own priced listings: sold after t days, or not yet.
// Parameters are shrunk toward the global fit, which is shrunk toward the defaults, so thin data can't swing them.

const DAY = 86_400_000;

/** Pairs of snapshots of the same search, 3 to 21 days apart, from the last 120 days. */
async function snapshotOutcomes(env: Env, since: number): Promise<Map<string, Outcome[]>> {
  const results = await env.store.pricing.marketSince(since);
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
  // For each decision: the first order for that item after it (the old correlated MIN subquery), built in JS.
  const sales = new Map<string, number[]>();
  for (const l of orderLines(await env.store.orders.all())) sales.set(l.item_id, [...(sales.get(l.item_id) ?? []), l.created_at]);
  const results = (await env.store.pricing.decisionsSince(since)).map((d) => {
    const after = (sales.get(d.item_id!) ?? []).filter((t) => t > d.at);
    return { ...d, item_id: d.item_id!, total: d.total!, market_price: d.market_price!, sold_at: after.length ? Math.min(...after) : null };
  });
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
  if (all.length) await env.store.pricing.saveParams(rows, now);
  // Snapshots older than 180 days expire on their own (the market container's TTL).
  return { groups: rows.length, outcomes: all.length };
}
