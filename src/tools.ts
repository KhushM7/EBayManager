import type { Env } from "./env";
import { getActiveListings, getItem } from "./ebay/trading";
import { searchActiveComps } from "./ebay/browse";
import { listProposals, proposeAndNotify } from "./proposals";
import { gateClosedReason, setWritesPaused, verifyNewListing } from "./ebay/write";
import { MAX_PRICE_STEP, MIN_DAYS_BETWEEN_PRICE_CHANGES } from "./rules";

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (env: Env, args: any) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

export async function snapshotListings(env: Env) {
  const listings = await getActiveListings(env);
  const now = Date.now();
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

export const tools: Tool[] = [
  {
    name: "list_active_listings",
    description: "List every active listing on K's eBay account with price, watchers and start date.",
    inputSchema: obj({}),
    run: (env) => getActiveListings(env),
  },
  {
    name: "get_listing",
    description: "Full detail for one listing: description, item specifics, condition, photos, category.",
    inputSchema: obj({ item_id: { type: "string" } }, ["item_id"]),
    run: (env, a) => getItem(env, a.item_id),
  },
  {
    name: "search_active_comps",
    description:
      "Active competing fixed-price listings for a search, with low/median/high price and how many are active (market saturation). These are asking prices, not sold prices.",
    inputSchema: obj(
      {
        query: { type: "string" },
        condition_ids: { type: "array", items: { type: "string" }, description: "eBay condition IDs, e.g. 1000 new, 3000 used" },
        category_id: { type: "string" },
      },
      ["query"],
    ),
    run: (env, a) => searchActiveComps(env, a.query, { conditionIds: a.condition_ids, categoryId: a.category_id }),
  },
  {
    name: "set_item_settings",
    description: "Record K's floor price or collection-only flag for an item. Only call with values K stated.",
    inputSchema: obj(
      { item_id: { type: "string" }, floor_price: { type: "number" }, collection_only: { type: "boolean" }, notes: { type: "string" } },
      ["item_id"],
    ),
    run: async (env, a) => {
      await env.DB.prepare(
        `INSERT INTO item_settings (item_id, floor_price, collection_only, notes) VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET floor_price = COALESCE(excluded.floor_price, floor_price),
           collection_only = excluded.collection_only, notes = COALESCE(excluded.notes, notes)`,
      )
        .bind(a.item_id, a.floor_price ?? null, a.collection_only ? 1 : 0, a.notes ?? null)
        .run();
      return { ok: true };
    },
  },
  {
    name: "propose_price_change",
    description:
      "Propose a new price for a listing. Nothing changes on eBay: K gets a push with Approve/Reject and the price is applied only on K's tap. Give a one-line reason citing comps.",
    inputSchema: obj(
      { item_id: { type: "string" }, new_price: { type: "number" }, reason: { type: "string" } },
      ["item_id", "new_price", "reason"],
    ),
    run: async (env, a) => {
      const settings = await env.DB.prepare("SELECT floor_price FROM item_settings WHERE item_id = ?")
        .bind(a.item_id)
        .first<{ floor_price: number | null }>();
      if (settings?.floor_price != null && a.new_price < settings.floor_price)
        throw new Error(`Below K's floor of ${settings.floor_price}; not proposed.`);

      const last = await env.DB.prepare(
        "SELECT price FROM listing_snapshots WHERE item_id = ? ORDER BY taken_at DESC LIMIT 1",
      )
        .bind(a.item_id)
        .first<{ price: number }>();
      const recent = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM proposals WHERE item_id = ? AND kind = 'price' AND status = 'applied' AND decided_at > ?",
      )
        .bind(a.item_id, Date.now() - MIN_DAYS_BETWEEN_PRICE_CHANGES * 86_400_000)
        .first<{ n: number }>();
      const flags: string[] = [];
      if (last && Math.abs(a.new_price - last.price) / last.price > MAX_PRICE_STEP)
        flags.push(`more than ${MAX_PRICE_STEP * 100}% from ${last.price}`);
      if (recent?.n) flags.push(`price already changed in the last ${MIN_DAYS_BETWEEN_PRICE_CHANGES} days`);

      const from = last ? `${last.price} → ` : "";
      const out = await proposeAndNotify(
        env,
        { kind: "price", itemId: a.item_id, payload: { oldPrice: last?.price ?? null, newPrice: a.new_price, flags }, reason: a.reason },
        `Price: ${from}${a.new_price}`,
        [a.reason, ...flags.map((f) => `Note: ${f}`)].join("\n"),
      );
      return { ...out, flags };
    },
  },
  {
    name: "propose_listing_revision",
    description:
      "Propose a new title, description and/or item specifics for a listing. Nothing changes on eBay until K approves. Item specifics replace the listing's current set, so include every specific to keep.",
    inputSchema: obj(
      {
        item_id: { type: "string" },
        title: { type: "string", maxLength: 80 },
        description: { type: "string", description: "HTML or plain text" },
        item_specifics: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        reason: { type: "string" },
      },
      ["item_id", "reason"],
    ),
    run: async (env, a) => {
      if (!a.title && !a.description && !a.item_specifics) throw new Error("Give a title, description or item specifics.");
      const changed = [a.title && "title", a.description && "description", a.item_specifics && "item specifics"].filter(Boolean);
      return proposeAndNotify(
        env,
        {
          kind: "revise",
          itemId: a.item_id,
          payload: { title: a.title, description: a.description, itemSpecifics: a.item_specifics },
          reason: a.reason,
        },
        `Revise ${changed.join(", ")}`,
        [a.title ? `Title: ${a.title}` : "", a.reason].filter(Boolean).join("\n"),
      );
    },
  },
  {
    name: "propose_new_listing",
    description:
      "Propose a new fixed-price listing (GBP, returns accepted, buyer pays return postage). Nothing is listed until K approves. Price must follow the house pricing rule and cite comps in the reason.",
    inputSchema: obj(
      {
        title: { type: "string", maxLength: 80 },
        description: { type: "string" },
        category_id: { type: "string" },
        price: { type: "number" },
        condition_id: { type: "string", description: "eBay condition ID, e.g. 1000 new, 3000 used" },
        quantity: { type: "number" },
        postcode: { type: "string" },
        shipping_cost: { type: "number" },
        collection_only: { type: "boolean" },
        picture_urls: { type: "array", items: { type: "string" } },
        item_specifics: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        reason: { type: "string" },
      },
      ["title", "description", "category_id", "price", "condition_id", "postcode", "reason"],
    ),
    run: async (env, a) => {
      const payload = {
        title: a.title,
        description: a.description,
        categoryId: a.category_id,
        price: a.price,
        conditionId: a.condition_id,
        quantity: a.quantity ?? 1,
        postcode: a.postcode,
        shippingCost: a.shipping_cost ?? 0,
        collectionOnly: Boolean(a.collection_only),
        pictureUrls: a.picture_urls ?? [],
        itemSpecifics: a.item_specifics,
      };
      // eBay checks the listing first; a rejected listing never reaches K. Throws with eBay's reason.
      const { fees } = await verifyNewListing(env, payload);
      const out = await proposeAndNotify(
        env,
        { kind: "create_listing", payload: { ...payload, verifiedFees: fees }, reason: a.reason },
        `New listing: ${a.title} at ${a.price}`,
        a.reason,
      );
      return { ...out, ebayCheck: "passed", listingFees: fees };
    },
  },
  {
    name: "pause_writes",
    description: "Stop every eBay write immediately (the kill switch). Only K can resume writes, outside this tool set.",
    inputSchema: obj({}),
    run: async (env) => {
      await setWritesPaused(env, true);
      return { paused: true };
    },
  },
  {
    name: "write_status",
    description: "Which eBay environment this is and whether approved changes can currently be applied.",
    inputSchema: obj({}),
    run: async (env) => ({
      ebayEnv: env.EBAY_ENV,
      writeMode: env.WRITE_MODE,
      writesBlocked: (await gateClosedReason(env)) ?? false,
    }),
  },
  {
    name: "list_proposals",
    description: "Proposals by status (pending, applied, rejected, failed).",
    inputSchema: obj({
      status: { type: "string", enum: ["pending", "approved", "applying", "applied", "rejected", "expired", "failed"] },
    }),
    run: (env, a) => listProposals(env, a.status ?? "pending"),
  },
  {
    name: "snapshot_listings",
    description: "Store today's snapshot of all active listings (also runs nightly on its own).",
    inputSchema: obj({}),
    run: (env) => snapshotListings(env),
  },
];
