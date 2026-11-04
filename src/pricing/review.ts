import type { Env } from "../env";
import { tools } from "../tools";
import { priceListing } from "./engine";

// Nightly price review (docs/pricing-engine.md): the engine re-prices a few of K's listings each night, oldest
// check first, and files a price proposal where the market supports a change. No Claude agent decides the
// number: it is the engine's, through the same propose_price_change tool (floor, step and engine checks).

const DAY = 86_400_000;
/** Listings re-priced per night: keeps sold-data searches well inside the monthly caps. */
export const PRICED_PER_NIGHT = 5;
/** A change smaller than this isn't worth a proposal. */
export const MIN_CHANGE = 0.05;
/** Below this confidence the engine's price is shown on a check, but not proposed. */
export const MIN_CONFIDENCE = 0.3;

/**
 * Prices listings with the engine and proposes changes the market supports. Nightly: a few a night, oldest
 * check first. With `all` (the first-day audit): every listing, however recently checked, up to `limit`.
 * Only a pending price change holds a listing back; a pending listing edit doesn't.
 */
export async function reviewPrices(env: Env, now = Date.now(), opts: { all?: boolean; limit?: number } = {}): Promise<string> {
  // The latest snapshot set, minus listings with a pending price change (unless all) or one applied in the
  // last 7 days, oldest engine check first.
  const priceProposals = await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "price" }]);
  const held = new Set(priceProposals.filter((p) => !opts.all && (p.status === "pending" || p.status === "approved")).map((p) => p.item_id));
  const recentlyChanged = new Set(priceProposals.filter((p) => p.status === "applied" && (p.decided_at ?? 0) > now - 7 * DAY).map((p) => p.item_id));
  const lastCheck = new Map((await env.store.pricing.latestDecisions()).map((d) => [d.item_id, d.at]));
  const results = (await env.store.listings.latestSet())
    .filter((s) => !held.has(s.item_id) && !recentlyChanged.has(s.item_id))
    .map((s) => ({ item_id: s.item_id, price: s.price, last_check: lastCheck.get(s.item_id) ?? null }))
    .sort((a, b) => (a.last_check ?? 0) - (b.last_check ?? 0));
  const due = results.filter((r) => opts.all || !r.last_check || now - r.last_check > 6 * DAY).slice(0, opts.limit ?? PRICED_PER_NIGHT);
  const propose = tools.find((t) => t.name === "propose_price_change")!;
  let proposed = 0;
  let asked = 0;
  const failed: string[] = [];
  for (const l of due) {
    try {
      const r = await priceListing(env, l.item_id);
      const d = r.decision;
      if (d.strategy === "ask" || d.price == null) {
        asked++;
        continue;
      }
      if (Math.abs(d.price - l.price) / l.price < MIN_CHANGE || d.confidence < MIN_CONFIDENCE) continue;
      const o = d.options;
      await propose.run(env, {
        item_id: l.item_id,
        new_price: d.price,
        reason:
          `${d.strategy[0].toUpperCase()}${d.strategy.slice(1)}: ${d.why} ` +
          `Options: £${o[0].price.toFixed(2)} (about ${o[0].daysToSell} days), £${o[1].price.toFixed(2)} (about ${o[1].daysToSell} days), £${o[2].price.toFixed(2)} (about ${o[2].daysToSell} days). Confidence ${Math.round(d.confidence * 100)}%.`,
      });
      proposed++;
    } catch (e) {
      failed.push(`${l.item_id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
  }
  return `${due.length} priced, ${proposed} proposed, ${asked} need your answer${failed.length ? `; failed ${failed.join("; ")}` : ""}`;
}
