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

export async function reviewPrices(env: Env, now = Date.now()): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT s.item_id, s.price,
            (SELECT MAX(at) FROM price_decisions d WHERE d.item_id = s.item_id) AS last_check
     FROM listing_snapshots s
     WHERE s.taken_at = (SELECT MAX(taken_at) FROM listing_snapshots)
       AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.item_id = s.item_id AND p.status IN ('pending', 'approved'))
       AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.item_id = s.item_id AND p.kind = 'price' AND p.status = 'applied' AND p.decided_at > ?)
     ORDER BY COALESCE(last_check, 0) ASC`,
  )
    .bind(now - 7 * DAY)
    .all<{ item_id: string; price: number; last_check: number | null }>();
  const due = results.filter((r) => !r.last_check || now - r.last_check > 6 * DAY).slice(0, PRICED_PER_NIGHT);
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
