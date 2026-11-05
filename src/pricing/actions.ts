import type { Env } from "../env";
import { tools } from "../tools";
import { filePriceQuestions } from "../todos";
import { priceListing, type PriceResult } from "./engine";

// What K can do from a price check (Listings) or the Inbox, through the same paths as everything else: a price
// label still goes through propose_price_change (floor, step and engine checks, K approves), and nothing here
// writes to eBay.

const propose = () => tools.find((t) => t.name === "propose_price_change")!;

/** Files the engine's price (one of its options, from the latest check) as a label for K to approve. */
export async function proposeEnginePrice(env: Env, itemId: string, price: number): Promise<string> {
  const current = (await env.store.listings.latest(itemId))?.price ?? null;
  if (current != null && Math.abs(current - price) / current < 0.01) return `The listing is already at £${current.toFixed(2)}: nothing to change.`;
  await propose().run(env, { item_id: itemId, new_price: price, reason: "From a price check on Listings." });
  return `A label to change it to £${price.toFixed(2)} is waiting in the Inbox.`;
}

/**
 * K's own price, for a listing with nothing comparable to price it from: recorded as the engine's decision, and
 * if the listing isn't at it, a label to put it there. The engine keeps looking for a market each week.
 */
export async function setOwnPrice(env: Env, itemId: string, price: number, where: string): Promise<string> {
  await env.store.listings.setOwnPrice(itemId, price);
  await priceListing(env, itemId);
  const current = (await env.store.listings.latest(itemId))?.price ?? null;
  let note = `Saved: £${price.toFixed(2)} is this listing's price. The engine looks for a market each week and prices it as soon as one appears.`;
  if (current != null && Math.abs(current - price) / current >= 0.01) {
    await propose().run(env, { item_id: itemId, new_price: price, reason: `Your own price, set ${where}: nothing comparable has sold to price it from.` });
    note += ` A label to change it from £${current.toFixed(2)} is waiting in the Inbox.`;
  }
  // Its "Set the price yourself" to-do, if any, is answered.
  await filePriceQuestions(env, [itemId], [], Date.now());
  return note;
}

/** A price check from Listings, keeping the Inbox in step: its question becomes (or stops being) a to-do. */
export async function priceCheck(env: Env, itemId: string): Promise<PriceResult> {
  const r = await priceListing(env, itemId);
  const d = r.decision;
  const title = (await env.store.listings.latest(itemId))?.title ?? r.identity.product;
  const asked = d.strategy === "ask" ? [{ itemId, title, question: d.question ?? "Which brand and model is it?", reason: d.reason }] : [];
  await filePriceQuestions(env, [itemId], asked, Date.now());
  return r;
}
