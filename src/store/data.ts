import { hashId, pad13, seqId, type Doc, type DocStore, type PatchOp } from "./doc";

// Everything else the app keeps: settings and the eBay token, listings (snapshots, traffic, K's settings,
// specs and a per-item "latest" summary), orders, buyer messages and offers, the pricing engine's records,
// sold-data usage and cache, Claude usage, audit reports, nightly health flags, locks and background jobs.

const strip = ({ id, pk, type, _etag, ttl, ...r }: any) => r;
const safeKey = (k: string) => /^[\w:.-]{1,200}$/.test(k);

/** Document ids for the documents this file writes. */
const docIds = {
  setting: async (key: string) => `setting:${safeKey(key) ? key : await hashId(key)}`,
  question: async (id: string) => `q:${safeKey(id) ? id : await hashId(id)}`,
  offer: async (id: string) => `o:${safeKey(id) ? id : await hashId(id)}`,
  params: async (grp: string) => `params:${await hashId(grp)}`,
  push: async (endpoint: string) => `push:${await hashId(endpoint)}`,
  solddata: async (key: string) => `sd:${await hashId(key)}`,
  identity: async (key: string) => `idn:${await hashId(key)}`,
  marketPk: (key: string) => hashId(key),
  usage: (provider: string, month: string) => `solddata_usage:${provider}:${month}`,
};
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Read-modify-write with an etag, retried: for documents several writers update (latest, orders). */
async function mutate(docs: DocStore, c: Parameters<DocStore["get"]>[0], id: string, pk: string, fn: (cur: Doc | null) => Doc | null): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const cur = await docs.get(c, id, pk);
    const next = fn(cur ? { ...cur } : null);
    if (!next) return;
    const done = cur ? await docs.replace(c, { ...next, id, pk }, cur._etag) : await docs.create(c, { ...next, id, pk });
    if (done) return;
  }
  throw new Error(`Too many simultaneous changes to ${c}/${id}`);
}

// --- Settings and the eBay token (container kv) ---

export function kvRepo(docs: DocStore) {
  const settingId = docIds.setting;
  return {
    async get(key: string): Promise<string | null> {
      const id = await settingId(key);
      return (await docs.get<any>("kv", id, id))?.value ?? null;
    },
    async set(key: string, value: string) {
      const id = await settingId(key);
      await docs.upsert("kv", { id, pk: id, type: "setting", key, value });
    },
    async getJson<T>(key: string): Promise<T | null> {
      const v = await this.get(key);
      return v == null ? null : (JSON.parse(v) as T);
    },
    async setJson(key: string, v: unknown) {
      await this.set(key, JSON.stringify(v));
    },
    getEbayTokens: async () => {
      const d = await docs.get<any>("kv", "ebay_tokens", "ebay_tokens");
      return d ? (strip(d) as { access_token: string; access_expires_at: number; refresh_token: string; refresh_expires_at: number; scopes: string }) : null;
    },
    async saveEbayTokens(t: { access_token: string; access_expires_at: number; refresh_token: string; refresh_expires_at: number; scopes: string }) {
      await docs.upsert("kv", { id: "ebay_tokens", pk: "ebay_tokens", type: "ebay_tokens", ...t });
    },
    async updateEbayAccess(token: string, expiresAt: number) {
      await docs.patch("kv", "ebay_tokens", "ebay_tokens", [
        { op: "set", path: "/access_token", value: token },
        { op: "set", path: "/access_expires_at", value: expiresAt },
      ]);
    },
  };
}

// --- Web Push subscriptions (container kv) ---

export interface PushRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

export function pushRepo(docs: DocStore) {
  const id = docIds.push;
  return {
    async save(s: { endpoint: string; p256dh: string; auth: string }, userAgent: string, now: number) {
      const key = await id(s.endpoint);
      await mutate(docs, "kv", key, key, (cur) =>
        cur
          ? { ...cur, p256dh: s.p256dh, auth: s.auth, user_agent: userAgent }
          : { id: key, pk: key, type: "push", ...s, user_agent: userAgent, created_at: now, last_ok_at: null, last_error: null },
      );
    },
    list: async (): Promise<PushRow[]> =>
      (await docs.query<any>("kv", { where: [{ f: "type", op: "=", v: "push" }], orderBy: ["created_at", "desc"] })).map((d) => strip(d) as PushRow),
    async delete(endpoint: string) {
      const key = await id(endpoint);
      await docs.delete("kv", key, key);
    },
    async markOk(endpoint: string, at: number) {
      const key = await id(endpoint);
      await docs.patch("kv", key, key, [
        { op: "set", path: "/last_ok_at", value: at },
        { op: "set", path: "/last_error", value: null },
      ]);
    },
    async markError(endpoint: string, error: string) {
      const key = await id(endpoint);
      await docs.patch("kv", key, key, [{ op: "set", path: "/last_error", value: error.slice(0, 300) }]);
    },
  };
}

// --- Listings (container listings, one partition per item) ---

export interface SnapshotRow {
  item_id: string;
  taken_at: number;
  title: string;
  price: number;
  currency: string;
  quantity_available: number;
  watch_count: number;
  view_count: number | null;
  start_time: string;
  /** The listing's main picture on eBay (older snapshots have none). */
  image_url?: string | null;
}

export interface LatestRow extends SnapshotRow {
  /** The earliest start time seen for this item (the listing's first start). */
  first_start_time: string | null;
  views_7d: number | null;
  impressions_7d: number | null;
}

export interface ItemSettings {
  item_id: string;
  floor_price: number | null;
  collection_only: number;
  notes: string | null;
  /** K's own price for a listing with no market to price from; the engine never changes it. */
  own_price: number | null;
  /** When K set it (for the 30-day reminder), and when the engine last looked for a market for the item. */
  own_price_set_at?: number | null;
  own_checked_at?: number | null;
}

const minIso = (a: string | null | undefined, b: string | null | undefined) => (!a ? b ?? null : !b ? a : Date.parse(a) <= Date.parse(b) ? a : b);

export function listingsRepo(docs: DocStore) {
  const L = "listings" as const;
  return {
    /** A snapshot of every active listing. The new set becomes "the latest" only after every item is written. */
    async writeSnapshot(takenAt: number, rows: Omit<SnapshotRow, "taken_at" | "view_count">[]) {
      for (const r of rows) {
        const snap = { ...r, taken_at: takenAt, view_count: null };
        await docs.upsert(L, { id: `s:${pad13(takenAt)}`, pk: r.item_id, type: "snapshot", ...snap });
        await mutate(docs, L, "latest", r.item_id, (cur) => ({
          id: "latest",
          pk: r.item_id,
          type: "latest",
          views_7d: null,
          impressions_7d: null,
          ...(cur ?? {}),
          ...snap,
          first_start_time: minIso(cur?.first_start_time, r.start_time),
        }));
      }
      if (rows.length) await docs.upsert("kv", { id: "listings_latest", pk: "listings_latest", type: "pointer", taken_at: takenAt });
    },
    /** The latest snapshot set (every listing that was active at the last read). */
    async latestSet(): Promise<LatestRow[]> {
      const ptr = await docs.get<any>("kv", "listings_latest", "listings_latest");
      if (!ptr) return [];
      const rows = await docs.query<any>(L, {
        where: [
          { f: "type", op: "=", v: "latest" },
          { f: "taken_at", op: "=", v: ptr.taken_at },
        ],
      });
      return rows.map((d) => strip(d) as LatestRow).sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
    },
    latest: async (itemId: string): Promise<LatestRow | null> => {
      const d = await docs.get(L, "latest", itemId);
      return d ? (strip(d) as LatestRow) : null;
    },
    /** Every item's latest summary, including items no longer active. */
    async latestAll(): Promise<Map<string, LatestRow>> {
      const rows = await docs.query<any>(L, { where: [{ f: "type", op: "=", v: "latest" }] });
      return new Map(rows.map((d) => [d.item_id, strip(d) as LatestRow]));
    },
    snapshotsSince: async (since: number) =>
      docs.query<{ taken_at: number; price: number; quantity_available: number; watch_count: number }>(L, {
        where: [
          { f: "type", op: "=", v: "snapshot" },
          { f: "taken_at", op: ">=", v: since },
        ],
        fields: ["taken_at", "price", "quantity_available", "watch_count"],
      }),
    async writeTraffic(takenAt: number, rows: { itemId: string; views: number; impressions: number }[]) {
      for (const r of rows) {
        await docs.upsert(L, { id: `t:${pad13(takenAt)}`, pk: r.itemId, type: "traffic", item_id: r.itemId, taken_at: takenAt, views_7d: r.views, impressions_7d: r.impressions });
        await mutate(docs, L, "latest", r.itemId, (cur) => ({
          ...(cur ?? { id: "latest", pk: r.itemId, type: "latest", item_id: r.itemId, taken_at: 0, first_start_time: null }),
          views_7d: r.views,
          impressions_7d: r.impressions,
          traffic_at: takenAt,
        }));
      }
    },
    getSettings: async (itemId: string): Promise<ItemSettings | null> => {
      const d = await docs.get(L, "settings", itemId);
      return d ? ({ collection_only: 0, notes: null, floor_price: null, own_price: null, ...strip(d) } as ItemSettings) : null;
    },
    async settingsAll(): Promise<Map<string, ItemSettings>> {
      const rows = await docs.query<any>(L, { where: [{ f: "type", op: "=", v: "item_settings" }] });
      return new Map(rows.map((d) => [d.item_id, { collection_only: 0, notes: null, floor_price: null, own_price: null, ...strip(d) } as ItemSettings]));
    },
    /** K's floor and facts from the app: both replaced, collection-only kept. */
    async setFloorAndNotes(itemId: string, floor: number | null, notes: string | null) {
      await mutate(docs, L, "settings", itemId, (cur) => ({
        ...(cur ?? { id: "settings", pk: itemId, type: "item_settings", item_id: itemId, collection_only: 0 }),
        floor_price: floor,
        notes,
      }));
    },
    /** K's own price, for a listing with no market to price from (null clears it). Other settings kept. */
    async setOwnPrice(itemId: string, price: number | null, now = Date.now()) {
      await mutate(docs, L, "settings", itemId, (cur) => ({
        ...(cur ?? { id: "settings", pk: itemId, type: "item_settings", item_id: itemId, collection_only: 0, floor_price: null, notes: null }),
        own_price: price,
        own_price_set_at: price == null ? null : now,
        own_checked_at: price == null ? null : now,
      }));
    },
    /** When the engine last looked for a market for an own-priced listing. */
    async markOwnChecked(itemId: string, at: number) {
      await mutate(docs, L, "settings", itemId, (cur) => (cur ? { ...cur, own_checked_at: at } : null));
    },
    /** The MCP/Claude tool: floor and notes only when given, collection-only always. */
    async mergeSettings(itemId: string, s: { floor_price?: number | null; collection_only: boolean; notes?: string | null }) {
      await mutate(docs, L, "settings", itemId, (cur) => ({
        ...(cur ?? { id: "settings", pk: itemId, type: "item_settings", item_id: itemId, floor_price: null, notes: null }),
        ...(s.floor_price != null ? { floor_price: s.floor_price } : {}),
        ...(s.notes != null ? { notes: s.notes } : {}),
        collection_only: s.collection_only ? 1 : 0,
      }));
    },
    getSpecs: async (itemId: string, title: string): Promise<string | null> => {
      const d = await docs.get<any>(L, "specs", itemId);
      return d && d.title === title ? d.lookup : null;
    },
    async putSpecs(itemId: string, title: string, at: number, lookup: string) {
      await docs.upsert(L, { id: "specs", pk: itemId, type: "product_specs", item_id: itemId, title, at, lookup });
    },
  };
}

// --- Orders (container orders), each with its items embedded ---

export interface OrderDoc {
  order_id: string;
  created_at: number;
  total: number | null;
  fees: number | null;
  currency: string | null;
  status: string | null;
  items: Record<string, { title: string; quantity: number; price: number | null }>;
}

const safeItem = (id: string) => /^[\w-]{1,64}$/.test(id);

export function ordersRepo(docs: DocStore) {
  const O = "orders" as const;
  const toItems = (items: { itemId: string; title: string; quantity: number; price: number | null }[]) =>
    Object.fromEntries(items.filter((i) => safeItem(i.itemId)).map((i) => [i.itemId, { title: i.title, quantity: i.quantity, price: i.price }]));
  return {
    /** Nightly sync from eBay: totals, fees and status updated; items replaced from eBay's list. */
    async upsertFromApi(orders: { orderId: string; createdAt: number; total: number | null; fees: number | null; currency: string | null; status: string | null; items: { itemId: string; title: string; quantity: number; price: number | null }[] }[]) {
      for (const o of orders) {
        const items = toItems(o.items);
        await mutate(docs, O, o.orderId, o.orderId, (cur) => {
          if (!cur) return { id: o.orderId, pk: o.orderId, type: "order", order_id: o.orderId, created_at: o.createdAt, total: o.total, fees: o.fees, currency: o.currency, status: o.status, items };
          const next = { ...cur, total: o.total, fees: o.fees, status: o.status, items: { ...cur.items, ...items } };
          return JSON.stringify(next) === JSON.stringify(cur) ? null : next;
        });
      }
    },
    /** Adds orders and items that aren't there yet; never changes existing ones. Returns how many items were added. */
    async insertIfAbsent(orders: { orderId: string; createdAt: number; total: number | null; fees: number | null; currency: string | null; status: string | null; items: { itemId: string; title: string; quantity: number; price: number | null }[] }[]) {
      let added = 0;
      for (const o of orders) {
        const items = toItems(o.items);
        let addedHere = 0;
        await mutate(docs, O, o.orderId, o.orderId, (cur) => {
          addedHere = 0;
          if (!cur) {
            addedHere = Object.keys(items).length;
            return { id: o.orderId, pk: o.orderId, type: "order", order_id: o.orderId, created_at: o.createdAt, total: o.total, fees: o.fees, currency: o.currency, status: o.status, items };
          }
          const fresh = Object.entries(items).filter(([k]) => !(k in (cur.items ?? {})));
          if (!fresh.length) return null;
          addedHere = fresh.length;
          return { ...cur, items: { ...cur.items, ...Object.fromEntries(fresh) } };
        });
        added += addedHere;
      }
      return added;
    },
    all: async (): Promise<OrderDoc[]> => (await docs.query<any>(O, { where: [{ f: "type", op: "=", v: "order" }] })).map((d) => strip(d) as OrderDoc),
    since: async (since: number): Promise<OrderDoc[]> =>
      (
        await docs.query<any>(O, {
          where: [
            { f: "type", op: "=", v: "order" },
            { f: "created_at", op: ">=", v: since },
          ],
        })
      ).map((d) => strip(d) as OrderDoc),
  };
}

/** One row per (order, item), as the old order_items JOIN orders gave. */
export const orderLines = (orders: OrderDoc[]) =>
  orders.flatMap((o) =>
    Object.entries(o.items ?? {}).map(([itemId, i]) => ({ order_id: o.order_id, item_id: itemId, title: i.title, quantity: i.quantity, price: i.price, created_at: o.created_at, total: o.total, fees: o.fees, status: o.status, items_in_order: Object.keys(o.items).length })),
  );

// --- Buyer questions and Best Offers already seen (container messages) ---

export function messagesRepo(docs: DocStore) {
  const M = "messages" as const;
  const qid = docIds.question;
  const oid = docIds.offer;
  return {
    seenQuestion: async (messageId: string) => Boolean(await docs.get(M, await qid(messageId), await qid(messageId))),
    seenOffer: async (offerId: string) => Boolean(await docs.get(M, await oid(offerId), await oid(offerId))),
    async recordQuestion(r: { message_id: string; item_id: string; sender: string; body: string; received_at: number; proposal_id: string }) {
      const id = await qid(r.message_id);
      await docs.upsert(M, { id, pk: id, type: "question", ...r });
    },
    async recordOffer(r: { best_offer_id: string; item_id: string; buyer: string; price: number; seen_at: number; proposal_id: string }) {
      const id = await oid(r.best_offer_id);
      await docs.upsert(M, { id, pk: id, type: "offer", ...r });
    },
    async deleteByBuyer(username: string) {
      const qs = await docs.query<any>(M, { where: [{ f: "type", op: "=", v: "question" }, { f: "sender", op: "=", v: username }], fields: ["id"] });
      const os = await docs.query<any>(M, { where: [{ f: "type", op: "=", v: "offer" }, { f: "buyer", op: "=", v: username }], fields: ["id"] });
      let n = 0;
      for (const d of [...qs, ...os]) if (await docs.delete(M, d.id, d.id)) n++;
      return n;
    },
  };
}

// --- The pricing engine's records (container pricing) and market snapshots (container market) ---

export interface DecisionRow {
  item_id: string | null;
  at: number;
  grp: string;
  strategy: string;
  price: number | null;
  total: number | null;
  market_price: number | null;
  predicted_days: number | null;
  result: string;
}

export function pricingRepo(docs: DocStore) {
  const P = "pricing" as const;
  const paramsId = docIds.params;
  return {
    /** Records a decision; for one of K's items, also updates that item's latest decision, in one batch. */
    async recordDecision(r: DecisionRow) {
      const doc = { id: seqId(r.at), pk: r.item_id ?? "none", type: "decision", ...r };
      if (!r.item_id) {
        await docs.create(P, doc);
        return;
      }
      for (let i = 0; i < 5; i++) {
        const cur = await docs.get<any>(P, "latest", r.item_id);
        const latest = { ...doc, id: "latest", type: "decision_latest" };
        const ops =
          cur && cur.at > r.at
            ? [{ op: "create" as const, doc }]
            : [{ op: "create" as const, doc }, cur ? { op: "replace" as const, doc: latest, etag: cur._etag } : { op: "create" as const, doc: latest }];
        if ((await docs.batch(P, r.item_id, ops)).ok) return;
      }
      throw new Error("Couldn't record the price decision");
    },
    /** The latest decision for an item, if newer than minAt. */
    async latestDecision(itemId: string, minAt = 0): Promise<DecisionRow | null> {
      const d = await docs.get<any>(P, "latest", itemId);
      return d && d.at > minAt ? (strip(d) as DecisionRow) : null;
    },
    latestDecisions: async (minAt = 0): Promise<DecisionRow[]> =>
      (
        await docs.query<any>(P, {
          where: [
            { f: "type", op: "=", v: "decision_latest" },
            { f: "at", op: ">", v: minAt },
          ],
        })
      ).map((d) => strip(d) as DecisionRow),
    decisionsSince: async (since: number): Promise<DecisionRow[]> =>
      (
        await docs.query<any>(P, {
          where: [
            { f: "type", op: "=", v: "decision" },
            { f: "at", op: ">", v: since },
            { f: "item_id", op: "notnull" },
            { f: "total", op: "notnull" },
            { f: "market_price", op: ">", v: 0 },
          ],
        })
      ).map((d) => strip(d) as DecisionRow),
    /** Learned parameters for a group, else the global fit. */
    async paramsFor(group: string): Promise<{ tau: number; alpha: number } | null> {
      for (const g of [group, "all"]) {
        const d = await docs.get<any>(P, await paramsId(g), "_params");
        if (d) return { tau: d.tau, alpha: d.alpha };
      }
      return null;
    },
    async saveParams(rows: [string, { tau: number; alpha: number; n: number }][], now: number) {
      for (const [grp, p] of rows) await docs.upsert(P, { id: await paramsId(grp), pk: "_params", type: "params", grp, ...p, updated_at: now });
    },
    async lastBundleAt(): Promise<number | null> {
      const [d] = await docs.query<any>(P, { pk: "_bundle", orderBy: ["at", "desc"], limit: 1, fields: ["at"] });
      return d?.at ?? null;
    },
    /** Marks open advice replaced and records the new run and advice, in one transaction. */
    async replaceBundleAdvice(now: number, advice: { kind: string; itemIds: string[]; detail: string }[]) {
      const open = await docs.query<any>(P, { pk: "_bundle", where: [{ f: "status", op: "=", v: "open" }], fields: ["id"] });
      const { ok } = await docs.batch(P, "_bundle", [
        ...open.map((o) => ({ op: "patch" as const, id: o.id, ops: [{ op: "set" as const, path: "/status", value: "replaced" }] })),
        { op: "create", doc: { id: `${pad13(now)}-000`, pk: "_bundle", type: "bundle_advice", at: now, kind: "run", item_ids: "", detail: "{}", status: "done" } },
        ...advice.map((a, i) => ({
          op: "create" as const,
          doc: { id: `${pad13(now)}-${String(i + 1).padStart(3, "0")}`, pk: "_bundle", type: "bundle_advice", at: now, kind: a.kind, item_ids: a.itemIds.join(","), detail: a.detail, status: "open" },
        })),
      ]);
      if (!ok) throw new Error("Couldn't save the bundle advice");
    },
    openAdvice: async () =>
      (await docs.query<any>(P, { pk: "_bundle", where: [{ f: "status", op: "=", v: "open" }], orderBy: ["id", "asc"] })).map((d) => ({ id: d.id as string, at: d.at as number, detail: d.detail as string })),
    dismissAdvice: (id: string) => docs.patch(P, id, "_bundle", [{ op: "set", path: "/status", value: "dismissed" }], [{ f: "status", op: "=", v: "open" }]),

    // Claude's identification of a listing, cached (container cache).
    async getIdentity(key: string): Promise<string | null> {
      const id = await docIds.identity(key);
      return (await docs.get<any>("cache", id, id))?.identity ?? null;
    },
    async putIdentity(key: string, itemId: string | null, identity: string, at: number) {
      const id = await docIds.identity(key);
      await docs.upsert("cache", { id, pk: id, type: "identity", key, item_id: itemId, identity, at });
    },

    // Daily matched active listings per search (container market, kept 180 days).
    async lastMarketAt(key: string): Promise<number | null> {
      const [d] = await docs.query<any>("market", { pk: await docIds.marketPk(key), orderBy: ["taken_at", "desc"], limit: 1, fields: ["taken_at"] });
      return d?.taken_at ?? null;
    },
    async writeMarket(key: string, takenAt: number, b: { grp: string; market: number; share: number; items: { item_id: string; total: number }[] }) {
      return docs.create("market", { id: pad13(takenAt), pk: await docIds.marketPk(key), type: "market_bucket", key, taken_at: takenAt, ...b });
    },
    /** Rows as the old market_snapshots table held them, ordered by key then time. */
    async marketSince(since: number) {
      const buckets = await docs.query<any>("market", { where: [{ f: "taken_at", op: ">", v: since }] });
      return buckets
        .flatMap((b) => (b.items as { item_id: string; total: number }[]).map((i) => ({ key: b.key as string, taken_at: b.taken_at as number, item_id: i.item_id, total: i.total, grp: b.grp as string, market: b.market as number, share: b.share as number })))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.taken_at - b.taken_at));
    },
  };
}

// --- Sold-data monthly usage (kv) and cache (container cache, 30 days) ---

export function soldDataRepo(docs: DocStore) {
  const usageId = docIds.usage;
  return {
    used: async (p: string, month: string) => (await docs.get<any>("kv", usageId(p, month), usageId(p, month)))?.used ?? 0,
    /** Adds to the month's count atomically. */
    async addUsage(p: string, month: string, n: number) {
      const id = usageId(p, month);
      const incr: PatchOp[] = [{ op: "incr", path: "/used", value: n }];
      for (let i = 0; i < 4; i++) {
        if (await docs.patch("kv", id, id, incr)) return;
        if (await docs.create("kv", { id, pk: id, type: "solddata_usage", provider: p, month, used: n })) return;
      }
      throw new Error("Couldn't record sold-data usage");
    },
    async cacheGet(key: string, minFetchedAt: number): Promise<string | null> {
      const id = await docIds.solddata(key);
      const d = await docs.get<any>("cache", id, id);
      return d && d.fetched_at > minFetchedAt ? d.sales : null;
    },
    async cachePut(key: string, provider: string, fetchedAt: number, sales: string, ttlDays: number) {
      const id = await docIds.solddata(key);
      await docs.upsert("cache", { id, pk: id, type: "solddata", key, provider, fetched_at: fetchedAt, sales, ttl: ttlDays * 86_400 });
    },
  };
}

// --- Claude usage (container usage, one partition per UTC day) ---

export interface UsageRow {
  at: number;
  job: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  stop_reason: string | null;
}

export function usageRepo(docs: DocStore) {
  return {
    async log(r: UsageRow) {
      await docs.create("usage", { id: seqId(r.at), pk: day(r.at), type: "usage", ...r });
    },
    since: async (since: number): Promise<UsageRow[]> => (await docs.query<any>("usage", { where: [{ f: "at", op: ">=", v: since }] })).map((d) => strip(d) as UsageRow),
  };
}

// --- First-day audit reports (container reports) ---

async function gzip(s: string): Promise<string> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function gunzip(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/** A report as stored: compressed above 512 KB, refused above 1.8 MB (Cosmos DB holds 2 MB per document). */
export async function reportBody(report: string): Promise<{ report: string } | { report_gz: string }> {
  const body = report.length > 512_000 ? { report_gz: await gzip(report) } : { report };
  if (JSON.stringify(body).length > 1_800_000) throw new Error("The audit report is too large to store");
  return body;
}

export function reportsRepo(docs: DocStore) {
  return {
    async add(at: number, env: string, report: string) {
      const body = await reportBody(report);
      await docs.create("reports", { id: seqId(at), pk: env, type: "firstday", at, env, ...body });
    },
    async latest(env: string): Promise<string | null> {
      const [d] = await docs.query<any>("reports", { pk: env, orderBy: ["id", "desc"], limit: 1 });
      if (!d) return null;
      return d.report_gz ? gunzip(d.report_gz) : (d.report ?? null);
    },
    any: async (env: string) => (await docs.query<any>("reports", { pk: env, limit: 1, fields: ["id"] })).length > 0,
  };
}

// --- Nightly health flags, locks and background jobs (container jobs) ---

export interface JobRow {
  id: string;
  kind: string;
  args: string;
  status: "queued" | "running" | "done" | "failed";
  requested_by: string | null;
  created_at: number;
  updated_at: number;
  result: string | null;
  error: string | null;
}

export function jobsRepo(docs: DocStore) {
  const J = "jobs" as const;
  return {
    async recordHealthFlags(checkedAt: number, flags: { item_id: string; flag: string; detail: string }[]) {
      await docs.upsert(J, { id: `health:${pad13(checkedAt)}`, pk: "health", type: "health_run", checked_at: checkedAt, flags });
    },
    async latestHealthFlags(): Promise<{ item_id: string; flag: string; detail: string }[]> {
      const [d] = await docs.query<any>(J, { pk: "health", orderBy: ["checked_at", "desc"], limit: 1 });
      return d?.flags ?? [];
    },
    /** A lock that frees itself after ttlSec even if its holder crashes. */
    acquireLock: (name: string, ttlSec: number) => docs.create(J, { id: `lock:${name}`, pk: "lock", type: "lock", at: Date.now(), ttl: ttlSec }),
    releaseLock: (name: string) => docs.delete(J, `lock:${name}`, "lock"),

    async createJob(kind: string, args: unknown, by: string | null, now: number): Promise<string> {
      const id = `job_${crypto.randomUUID()}`;
      await docs.create(J, { id, pk: "queue", type: "job", kind, args: JSON.stringify(args), status: "queued", requested_by: by, created_at: now, updated_at: now, result: null, error: null, ttl: 30 * 86_400 });
      return id;
    },
    getJob: async (id: string): Promise<JobRow | null> => {
      if (!/^job_[\w-]{1,64}$/.test(id)) return null;
      const d = await docs.get(J, id, "queue");
      return d ? ({ id: d.id, ...strip(d) } as JobRow) : null;
    },
    /** queued -> running, once (a redelivered queue message can't run a job twice). */
    startJob: (id: string, now: number) =>
      docs.patch(J, id, "queue", [
        { op: "set", path: "/status", value: "running" },
        { op: "set", path: "/updated_at", value: now },
      ], [{ f: "status", op: "=", v: "queued" }]),
    finishJob: (id: string, now: number, out: { result?: string; error?: string }) =>
      docs.patch(J, id, "queue", [
        { op: "set", path: "/status", value: out.error ? "failed" : "done" },
        { op: "set", path: "/updated_at", value: now },
        { op: "set", path: "/result", value: out.result ?? null },
        { op: "set", path: "/error", value: out.error ?? null },
      ]),
    recentJobs: async (kind?: string, limit = 20): Promise<JobRow[]> =>
      (await docs.query<any>(J, { pk: "queue", where: kind ? [{ f: "kind", op: "=", v: kind }] : [], orderBy: ["created_at", "desc"], limit })).map((d) => ({ id: d.id, ...strip(d) }) as JobRow),
  };
}
