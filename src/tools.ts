import type { Env } from "./env";
import { getActiveListings, getItem, titleLockReason } from "./ebay/trading";
import { snapshotListings } from "./snapshot";
import { searchActiveComps } from "./ebay/browse";
import { listProposals, proposeAndNotify } from "./proposals";
import { gateClosedReason, setWritesPaused, verifyNewListing } from "./ebay/write";
import { MAX_PRICE_STEP, MIN_DAYS_BETWEEN_PRICE_CHANGES } from "./rules";
import { currentPricing, priceListing } from "./pricing/engine";

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (env: Env, args: any) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

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
    name: "price_check",
    description:
      "Run the pricing engine on one of K's listings: identifies the item (and a bundle's parts), finds true matching sold sales and current listings, reads the market (clearing price, long-run price, trend, weeks of supply, regime) and recommends a strategy (compete, hold, clear, or ask K) with a price and three options showing expected days to sell. Prices are what K lists; totals include postage. Use its price and 'why' for any price proposal.",
    inputSchema: obj({ item_id: { type: "string" } }, ["item_id"]),
    run: async (env, a) => {
      // A check from today is reused (the nightly review may have just run one).
      const r = (await currentPricing(env, a.item_id, 1)) ?? (await priceListing(env, a.item_id));
      // A compact view for Claude: the decision and the market, not every matched title.
      return {
        decision: r.decision,
        method: r.method,
        identity: { product: r.identity.product, group: r.identity.group, priceable: r.identity.priceable },
        components: r.components.map((c) => ({ name: c.name, query: c.query, market: c.market, matched: c.matched, evidence: c.evidence.sold.slice(0, 3), errors: c.errors })),
      };
    },
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
      // Every price comes from the pricing engine: one of its three options from a check in the last 3 days.
      const engine = await enginePriceCheck(env, a.item_id, a.new_price);
      a.reason = `${a.reason}\nEngine: ${engine}`;

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
        flags.push(`more than ${MAX_PRICE_STEP * 100}% away from £${Number(last.price).toFixed(2)}`);
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
      "Propose a new title, description, item specifics and/or Best Offer setting for a listing. Nothing changes on eBay until K approves. Item specifics replace the listing's current set, so include every specific to keep.",
    inputSchema: obj(
      {
        item_id: { type: "string" },
        title: { type: "string", maxLength: 80 },
        description: { type: "string", description: "HTML or plain text" },
        item_specifics: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        best_offer_enabled: { type: "boolean", description: "Let buyers make offers (K answers every offer)" },
        reason: { type: "string" },
      },
      ["item_id", "reason"],
    ),
    run: async (env, a) => {
      if (a.title || a.description) {
        const lock = titleLockReason(await getItem(env, a.item_id));
        if (lock) throw new Error(`Not proposed: ${lock}. Item specifics and the Best Offer setting can still change.`);
      }
      const bestOffer = typeof a.best_offer_enabled === "boolean" ? a.best_offer_enabled : undefined;
      if (!a.title && !a.description && !a.item_specifics && bestOffer === undefined)
        throw new Error("Give a title, description, item specifics or Best Offer setting.");
      const changed = [
        a.title && "title",
        a.description && "description",
        a.item_specifics && "item specifics",
        bestOffer !== undefined && `Best Offer ${bestOffer ? "on" : "off"}`,
      ].filter(Boolean);
      return proposeAndNotify(
        env,
        {
          kind: "revise",
          itemId: a.item_id,
          payload: { title: a.title, description: a.description, itemSpecifics: a.item_specifics, bestOfferEnabled: bestOffer },
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
        best_offer: { type: "boolean", description: "Let buyers make offers (K answers every offer)" },
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
        bestOffer: Boolean(a.best_offer),
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

/**
 * A price proposal must be one of the pricing engine's options (within 1%) from a check in the last 3 days,
 * and the engine must not be asking K a question instead. Returns the engine's summary for the reason.
 */
export async function enginePriceCheck(env: Env, itemId: string, price: number): Promise<string> {
  const row = await env.DB.prepare("SELECT result FROM price_decisions WHERE item_id = ? AND at > ? ORDER BY at DESC LIMIT 1")
    .bind(itemId, Date.now() - 3 * 86_400_000)
    .first<{ result: string }>();
  if (!row) throw new Error("Run price_check for this item first: prices come from the pricing engine. Not proposed.");
  const d = JSON.parse(row.result).decision as { strategy: string; price: number | null; options: { price: number }[]; why: string; question?: string };
  if (d.strategy === "ask" || d.price == null)
    throw new Error(`The pricing engine can't price this yet: ${d.question ?? d.why} Put that question in your note for K. Not proposed.`);
  const allowed = [d.price, ...d.options.map((o) => o.price)];
  if (!allowed.some((p) => Math.abs(price - p) <= p * 0.01))
    throw new Error(`£${price} isn't one of the engine's prices (${allowed.map((p) => `£${p.toFixed(2)}`).join(", ")}). Use its recommended price. Not proposed.`);
  return `${d.strategy}, recommended £${d.price.toFixed(2)}. ${d.why}`;
}
