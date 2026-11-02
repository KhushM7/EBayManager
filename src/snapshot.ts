import type { Env } from "./env";
import { getActiveListings } from "./ebay/trading";

/** Stores a snapshot of every active listing (read-only). Runs nightly, on demand, and after K's changes apply. */
export async function snapshotListings(env: Env) {
  const listings = await getActiveListings(env);
  const now = Date.now();
  if (listings.length)
    await env.DB.batch(
      listings.map((l) =>
        env.DB.prepare(
          `INSERT INTO listing_snapshots (item_id, taken_at, title, price, currency, quantity_available, watch_count, start_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(l.itemId, now, l.title, l.price, l.currency, l.quantityAvailable, l.watchCount, l.startTime),
      ),
    );
  return { count: listings.length, takenAt: new Date(now).toISOString() };
}
