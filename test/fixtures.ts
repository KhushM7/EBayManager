// Shared test fixtures over the in-memory store (replaces test/d1.ts and raw SQL seeding).
import type { Store } from "../src/store";
import { proposalPk } from "../src/store/proposals";

/** A connected eBay account whose access token is valid for another hour. */
export async function withEbayTokens(store: Store) {
  await store.kv.saveEbayTokens({
    access_token: "t",
    access_expires_at: Date.now() + 3_600_000,
    refresh_token: "r",
    refresh_expires_at: Date.now() + 3_600_000,
    scopes: "s",
  });
}

/** A proposal stored directly, with a chosen id (for tests that set up state). */
export async function seedProposal(store: Store, r: { id: string; kind: string; item_id: string | null; status: string; created_at: number; expires_at: number; payload?: string; dry_run?: number }) {
  await store.docs.create("proposals", { payload: "{}", reason: null, dry_run: 0, decided_at: null, decided_by: null, result: null, ...r, pk: proposalPk(r.item_id), type: "proposal" });
}

/** A listing snapshot set at one time, with defaults for fields a test doesn't care about. */
export async function seedSnapshot(store: Store, takenAt: number, rows: { item_id: string; title?: string; price: number }[]) {
  await store.listings.writeSnapshot(
    takenAt,
    rows.map((r) => ({ item_id: r.item_id, title: r.title ?? "x", price: r.price, currency: "GBP", quantity_available: 1, watch_count: 0, start_time: new Date(takenAt).toISOString() })),
  );
}

/** Overwrites fields on a stored proposal, as a test's way of putting it in a given state. */
export async function setProposal(store: Store, id: string, fields: Record<string, unknown>) {
  const [d] = await store.docs.query("proposals", { where: [{ f: "id", op: "=", v: id }] });
  if (!d) throw new Error(`No proposal ${id}`);
  await store.docs.upsert("proposals", { ...d, ...fields });
}
