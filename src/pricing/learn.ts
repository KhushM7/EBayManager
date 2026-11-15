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

/** How much one of K's own listings counts against a competitor's seen in a snapshot. */
export const OWN_WEIGHT = 3;

/**
 * K's own listings: one observation for each stretch a listing spent at one price, sold or not. The engine
 * records a decision on every price check, so counting decisions counted one listing (and its one sale) many
 * times over; a stretch starts when the price changes by more than 1% and ends at the sale, the next price, or now.
 */
async function ownOutcomes(env: Env, since: number, now: number): Promise<Map<string, Outcome[]>> {
  const sales = new Map<string, number[]>();
  for (const l of orderLines(await env.store.orders.all())) sales.set(l.item_id, [...(sales.get(l.item_id) ?? []), l.created_at]);
  const byItem = new Map<string, Awaited<ReturnType<Env["store"]["pricing"]["decisionsSince"]>>>();
  for (const d of await env.store.pricing.decisionsSince(since)) if (d.item_id && d.total && d.market_price) byItem.set(d.item_id, [...(byItem.get(d.item_id) ?? []), d]);
  const byGroup = new Map<string, Outcome[]>();
  for (const [itemId, decisions] of byItem) {
    const sorted = decisions.sort((a, b) => a.at - b.at);
    const starts = sorted.filter((d, i) => i === 0 || Math.abs(d.total! - sorted[i - 1].total!) / sorted[i - 1].total! > 0.01);
    starts.forEach((d, i) => {
      const end = starts[i + 1]?.at ?? now;
      const soldAt = (sales.get(itemId) ?? []).find((t) => t > d.at && t <= end) ?? null;
      const m = JSON.parse(d.result)?.components?.[0]?.market;
      const share = m ? Math.max(m.demand28, m.demand91) / (m.supply + 1) : 0;
      const days = ((soldAt ?? end) - d.at) / DAY;
      if (!share || days < 1) return;
      byGroup.set(d.grp, [...(byGroup.get(d.grp) ?? []), { rel: d.total! / d.market_price!, days, sold: soldAt != null, share, weight: OWN_WEIGHT }]);
    });
  }
  return byGroup;
}

export async function learnParams(env: Env, now = Date.now()): Promise<{ groups: number; outcomes: number }> {
  const since = now - 120 * DAY;
  const groups = await snapshotOutcomes(env, since);
  // K's own count more in the fit (they're the listings being priced), but each is still one observation.
  for (const [g, out] of await ownOutcomes(env, since, now)) groups.set(g, [...(groups.get(g) ?? []), ...out]);

  const all = [...groups.values()].flat();
  const global = fitParams(all, DEFAULT_PARAMS);
  const rows: [string, { tau: number; alpha: number; n: number }][] = [["all", global]];
  for (const [g, out] of groups) if (g !== "all") rows.push([g, fitParams(out, global)]);
  if (all.length) await env.store.pricing.saveParams(rows, now);
  // Snapshots older than 180 days expire on their own (the market container's TTL).
  return { groups: rows.length, outcomes: all.length };
}
