import type { Env } from "./env";
import { getActiveListings } from "./ebay/trading";

/** Stores a snapshot of every active listing (read-only). Runs nightly, on demand, and after K's changes apply. */
export async function snapshotListings(env: Env) {
  const listings = await getActiveListings(env);
  const now = Date.now();
  await env.store.listings.writeSnapshot(
    now,
    listings.map((l) => ({
      item_id: l.itemId,
      title: l.title,
      price: l.price,
      currency: l.currency,
      quantity_available: l.quantityAvailable,
      watch_count: l.watchCount,
      start_time: l.startTime,
    })),
  );
  return { count: listings.length, takenAt: new Date(now).toISOString() };
}
