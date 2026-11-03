import type { Decision, MarketState } from "./model";
import { endPrice } from "./model";

// Best Offers judged against the pricing engine (docs/pricing-engine.md, "Offers"). The principle is the
// seller's reservation value: accept an offer when it's worth more than carrying on — listing at the
// engine's recommended price and waiting for a buyer, with the wait's holding cost and impatience counted.
// Otherwise counter at a price that is, never below K's floor or the market's value floor. Pure: no I/O.

const r2 = (x: number) => Math.round(x * 100) / 100;

export interface OfferInput {
  /** The buyer's offer, item price (eBay offers exclude postage). */
  offer: number;
  /** The listing's asking price. */
  asking: number;
  /** The engine's latest decision and the main part's market, for this item. */
  decision: Decision;
  market: MarketState | null;
  /** Postage K charges, so totals convert to item prices. */
  postage: number;
  floor: number | null;
}

export interface OfferAnswer {
  action: "accept" | "counter" | "decline";
  counterPrice: number | null;
  /** What carrying on is worth to K now, item price: the line between accepting and countering. */
  reservation: number;
  reason: string;
}

/**
 * - Accept if the offer is at least the reservation value.
 * - Counter if it's below: at the reservation value, or halfway to the asking price if that's higher (eBay
 *   buyers expect to meet in the middle), never above the asking price, with a precise ending (a precise
 *   counter signals a firm seller, per Backus, Blake & Tadelis).
 * - Decline only a lowball under half the reservation value; K can still counter from the Inbox.
 */
export function answerOffer(i: OfferInput): OfferAnswer | null {
  const d = i.decision;
  if (d.strategy === "ask" || d.price == null || d.options.length < 2) return null;
  const rec = d.options[1];
  // Present value of carrying on at the recommended price (already net of waiting costs).
  const carryOn = Math.max(0, rec.expectedValue);
  // Never below the long-run value floor of this item, nor K's floor.
  const valueFloor = i.market?.valueFloor != null ? Math.max(0, i.market.valueFloor - i.postage) : 0;
  const reservation = r2(Math.max(carryOn, valueFloor, i.floor ?? 0));
  const days = Number.isFinite(rec.daysToSell) ? rec.daysToSell : null;
  const wait = days == null ? "an uncertain wait" : `about ${days} days`;

  if (i.offer >= reservation) {
    return {
      action: "accept",
      counterPrice: null,
      reservation,
      reason:
        `£${i.offer.toFixed(2)} beats carrying on: listing at £${d.price.toFixed(2)} means ${wait} for a buyer, worth about £${reservation.toFixed(2)} today. ` +
        `Market: ${d.why}`,
    };
  }
  if (i.offer < reservation * 0.5) {
    return {
      action: "decline",
      counterPrice: null,
      reservation,
      reason: `£${i.offer.toFixed(2)} is under half of what this is worth to you now (about £${reservation.toFixed(2)}). Market: ${d.why}`,
    };
  }
  const midway = (i.offer + i.asking) / 2;
  let counter = Math.min(i.asking, Math.max(reservation, midway));
  counter = Math.min(i.asking, Math.max(endPrice(counter, "hold"), reservation));
  return {
    action: "counter",
    counterPrice: r2(counter),
    reservation,
    reason:
      `£${i.offer.toFixed(2)} is below what carrying on is worth (about £${reservation.toFixed(2)}: listing at £${d.price.toFixed(2)}, ${wait} to sell). ` +
      `Counter at £${r2(counter).toFixed(2)}. Market: ${d.why}`,
  };
}
