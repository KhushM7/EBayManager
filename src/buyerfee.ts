import { r2 } from "./util";

// eBay UK's Buyer Protection fee on a private seller's item. The seller sets a base price and receives it; eBay adds
// the fee and shows buyers the total (K, 2026-11-24): 10p, plus 7% of the first £20, 4% to £300 and 2% to £4,000.
// eBay's API reports the seller's figure: five offers read on production each come to a round number of pounds once
// this fee is added, which is what buyers type. The band above £300 is eBay's published one, unproven here.

export function buyerFee(seller: number): number {
  if (!(seller > 0)) return 0;
  const band = (from: number, to: number) => Math.max(0, Math.min(seller, to) - from);
  return r2(0.1 + band(0, 20) * 0.07 + band(20, 300) * 0.04 + band(300, 4000) * 0.02);
}

/** What a buyer pays for an item K receives `seller` for, before postage. */
export const buyerPays = (seller: number) => r2(seller + buyerFee(seller));
