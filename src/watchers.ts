import type { Env } from "./env";
import { getEligibleForOffers } from "./ebay/sell";
import { proposeAndNotify } from "./proposals";
import { WATCHER_OFFER } from "./rules";
import { r2 } from "./util";

// Offers to watchers (K, 2026-11-15). People who watch a listing liked it; a small offer reminds them it's
// there. So the discount is as little as possible (WATCHER_OFFER: 2% the first time, a point more each time the
// listing is offered again unsold, never above 5%), never under K's floor. Each offer is an `offer_to_watchers`
// proposal K approves (a locked kind); the write gate sends it and refuses any other percentage.

const DAY = 86_400_000;

export interface WatcherOfferInput {
  price: number;
  watchers: number;
  listedDays: number;
  floor: number | null;
  /** Offers to watchers already sent for this listing, and when the last one was. */
  sentBefore: number;
  lastSentAt: number | null;
  /** A price change is waiting or was just applied: the offer would be a percentage off a price about to move. */
  priceMoving: boolean;
  now?: number;
}

export interface WatcherOffer {
  percent: number;
  offerPrice: number;
  why: string;
}

/** The offer to send, or why none. Pure. */
export function watcherOffer(i: WatcherOfferInput): WatcherOffer | { skip: string } {
  const now = i.now ?? Date.now();
  if (i.watchers < 1) return { skip: "nobody is watching it" };
  if (i.listedDays < WATCHER_OFFER.minListedDays) return { skip: `listed under ${WATCHER_OFFER.minListedDays} days` };
  if (i.priceMoving) return { skip: "its price is changing" };
  if (i.lastSentAt != null && now - i.lastSentAt < WATCHER_OFFER.cooldownDays * DAY) return { skip: `an offer went out in the last ${WATCHER_OFFER.cooldownDays} days` };
  // As little off as possible: 2%, then a point more each time it's offered again, up to 5%.
  let percent = Math.min(WATCHER_OFFER.maxPercent, WATCHER_OFFER.minPercent + i.sentBefore);
  const priceAt = (p: number) => r2(i.price * (1 - p / 100));
  // Never under K's floor: step back down to the smallest discount that stays above it.
  while (i.floor != null && percent > WATCHER_OFFER.minPercent && priceAt(percent) < i.floor) percent--;
  if (i.floor != null && priceAt(percent) < i.floor) return { skip: `even ${percent}% off would be under your floor of £${i.floor.toFixed(2)}` };
  const offerPrice = priceAt(percent);
  return {
    percent,
    offerPrice,
    why:
      `${i.watchers} ${i.watchers === 1 ? "person is" : "people are"} watching this after ${i.listedDays} days. A small offer reminds them: ${percent}% off, £${offerPrice.toFixed(2)} instead of £${i.price.toFixed(2)}, open for ${WATCHER_OFFER.durationDays} days.` +
      (i.sentBefore ? ` Offered ${i.sentBefore === 1 ? "once" : `${i.sentBefore} times`} before, so a point more than last time.` : ""),
  };
}

export const WATCHER_MESSAGE = "Thanks for watching this. Here's a little off if you'd still like it.";

/**
 * Nightly: for each listing eBay says can take an offer to its watchers, file one `offer_to_watchers` proposal
 * when the rules above allow. Reads eBay only; nothing is sent until K approves.
 */
export async function reviewWatcherOffers(env: Env, now = Date.now()): Promise<string> {
  const rows = (await env.store.listings.latestSet()).filter((l) => (l.watch_count ?? 0) > 0);
  if (!rows.length) return "no listings with watchers";
  const eligible = new Set(await getEligibleForOffers(env));
  const earlier = await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "offer_to_watchers" }]);
  const prices = await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "price" }]);
  let proposed = 0;
  const skipped: string[] = [];
  for (const l of rows) {
    if (!eligible.has(l.item_id)) continue;
    const mine = earlier.filter((p) => p.item_id === l.item_id);
    // One waiting is enough; a rejection holds for the cooldown, as a sent one does.
    if (mine.some((p) => p.status === "pending" || p.status === "approved")) continue;
    const sent = mine.filter((p) => p.status === "applied");
    const lastTouched = Math.max(0, ...mine.filter((p) => p.status === "applied" || p.status === "rejected").map((p) => p.decided_at ?? p.created_at));
    const priceMoving = prices.some(
      (p) => p.item_id === l.item_id && !p.dry_run && (p.status === "pending" || p.status === "approved" || (p.status === "applied" && (p.decided_at ?? 0) > now - 3 * DAY)),
    );
    const s = await env.store.listings.getSettings(l.item_id);
    const offer = watcherOffer({
      price: l.price,
      watchers: l.watch_count ?? 0,
      listedDays: Math.floor((now - Date.parse(l.start_time)) / DAY),
      floor: s?.floor_price ?? null,
      sentBefore: sent.length,
      lastSentAt: lastTouched || null,
      priceMoving,
      now,
    });
    if ("skip" in offer) {
      skipped.push(`${l.item_id}: ${offer.skip}`);
      continue;
    }
    await proposeAndNotify(
      env,
      {
        kind: "offer_to_watchers",
        itemId: l.item_id,
        payload: { itemTitle: l.title, percent: offer.percent, price: l.price, offerPrice: offer.offerPrice, watchers: l.watch_count ?? 0, message: WATCHER_MESSAGE, durationDays: WATCHER_OFFER.durationDays },
        reason: offer.why,
      },
      `Offer watchers ${offer.percent}% off: ${l.title}`,
      offer.why,
    );
    proposed++;
  }
  return `${eligible.size} eligible on eBay, ${proposed} proposed${skipped.length ? `; skipped ${skipped.join("; ").slice(0, 200)}` : ""}`;
}
