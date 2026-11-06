import { pad13, type Container, type Doc } from "./doc";
import { docIds, reportBody } from "./data";
import { proposalPk } from "./proposals";

// Cloudflare D1 rows -> store documents (docs/azure-migration.md, M4 and M6). Pure: given every table's rows,
// returns the documents to write, in the same shapes the repositories write, so the app reads imported data
// exactly as it reads its own. scripts/migrate-d1-to-cosmos.ts loads the D1 export, calls this, writes with
// upserts (safe to run again) and verifies.
//
// Not imported, because they are bound to the old web address or are short-lived: sessions, sign-in
// challenges and attempts, push subscriptions (tied to the old origin's service worker), passkeys (bound to
// the old address), invites (links to the old address). People are re-enrolled with a new invite instead.

export type Rows = Record<string, Record<string, any>[]>;
export interface Planned {
  container: Container;
  doc: Doc;
}

const DAY = 86_400_000;
const month = (at: number) => new Date(at).toISOString().slice(0, 7);
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
/** Deterministic id for a row that had an AUTOINCREMENT id: sorts with new ids by time, and is the same on a rerun. */
const d1Id = (at: number, id: number) => `${pad13(at)}-d1-${String(id).padStart(8, "0")}`;
const latestBy = <T>(xs: T[], key: (x: T) => number) => xs.reduce<T | null>((m, x) => (m == null || key(x) >= key(m) ? x : m), null);
const minIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(a) <= Date.parse(b) ? a : b);

export const SKIPPED_TABLES = ["sessions", "auth_challenges", "auth_attempts", "push_subscriptions", "credentials", "invites"];

export async function planImport(rows: Rows, now = Date.now()): Promise<{ docs: Planned[]; notes: string[] }> {
  const out: Planned[] = [];
  const notes: string[] = [];
  const t = (name: string) => rows[name] ?? [];
  const add = (container: Container, doc: Doc) => out.push({ container, doc });

  // Settings, the eBay token, sold-data usage.
  for (const r of t("settings")) {
    const id = await docIds.setting(r.key);
    add("kv", { id, pk: id, type: "setting", key: r.key, value: r.value });
  }
  for (const r of t("ebay_tokens"))
    add("kv", { id: "ebay_tokens", pk: "ebay_tokens", type: "ebay_tokens", access_token: r.access_token, access_expires_at: r.access_expires_at, refresh_token: r.refresh_token, refresh_expires_at: r.refresh_expires_at, scopes: r.scopes });
  for (const r of t("solddata_usage")) {
    const id = docIds.usage(r.provider, r.month);
    add("kv", { id, pk: id, type: "solddata_usage", provider: r.provider, month: r.month, used: r.used });
  }

  // People (not the Sandbox test key user) and their unused recovery codes (codes don't depend on the address).
  const users = t("users").filter((u) => !u.is_test);
  for (const u of users) add("auth", { id: `user:${u.id}`, pk: "auth", type: "user", user_id: u.id, name: u.name, role: u.role, created_at: u.created_at, disabled: u.disabled ? 1 : 0, is_test: 0 });
  const active = new Set(users.filter((u) => !u.disabled).map((u) => u.id));
  for (const c of t("recovery_codes")) if (!c.used_at && active.has(c.user_id)) add("auth", { id: `rc:${c.code_hash}`, pk: "auth", type: "recovery", code_hash: c.code_hash, user_id: c.user_id, used_at: null });

  // Proposals keep their ids (approval links and the audit log refer to them).
  const proposals = new Map(t("proposals").map((p) => [p.id, p]));
  for (const p of t("proposals"))
    add("proposals", {
      id: p.id,
      pk: proposalPk(p.item_id),
      type: "proposal",
      kind: p.kind,
      item_id: p.item_id ?? null,
      payload: p.payload,
      reason: p.reason ?? null,
      status: p.status,
      dry_run: p.dry_run ? 1 : 0,
      created_at: p.created_at,
      expires_at: p.expires_at,
      decided_at: p.decided_at ?? null,
      decided_by: p.decided_by ?? null,
      result: p.result ?? null,
    });

  for (const a of t("audit_log")) {
    const p = a.proposal_id ? proposals.get(a.proposal_id) : undefined;
    add("audit", { id: d1Id(a.at, a.id), pk: month(a.at), type: "audit", at: a.at, env: a.env, proposal_id: a.proposal_id ?? null, call: a.call, request: a.request, response: a.response ?? null, outcome: a.outcome, actor: a.actor ?? null, kind: p?.kind ?? null, item_id: p?.item_id ?? null });
  }

  // Listings: snapshots, traffic, K's settings and specs, and each item's "latest" summary.
  const snaps = t("listing_snapshots");
  const traffic = t("listing_traffic");
  for (const s of snaps)
    add("listings", { id: `s:${pad13(s.taken_at)}`, pk: s.item_id, type: "snapshot", item_id: s.item_id, taken_at: s.taken_at, title: s.title, price: s.price, currency: s.currency, quantity_available: s.quantity_available, watch_count: s.watch_count, view_count: s.view_count ?? null, start_time: s.start_time });
  for (const r of traffic) add("listings", { id: `t:${pad13(r.taken_at)}`, pk: r.item_id, type: "traffic", item_id: r.item_id, taken_at: r.taken_at, views_7d: r.views_7d, impressions_7d: r.impressions_7d });
  const items = new Set([...snaps.map((s) => s.item_id), ...traffic.map((r) => r.item_id)]);
  for (const item of items) {
    const mine = snaps.filter((s) => s.item_id === item);
    const last = latestBy(mine, (s) => s.taken_at);
    const tr = latestBy(traffic.filter((r) => r.item_id === item), (r) => r.taken_at);
    add("listings", {
      id: "latest",
      pk: item,
      type: "latest",
      item_id: item,
      ...(last
        ? { taken_at: last.taken_at, title: last.title, price: last.price, currency: last.currency, quantity_available: last.quantity_available, watch_count: last.watch_count, view_count: last.view_count ?? null, start_time: last.start_time }
        : { taken_at: 0 }),
      first_start_time: mine.reduce<string | null>((m, s) => minIso(m, s.start_time ?? null), null),
      views_7d: tr?.views_7d ?? null,
      impressions_7d: tr?.impressions_7d ?? null,
      ...(tr ? { traffic_at: tr.taken_at } : {}),
    });
  }
  if (snaps.length) {
    const latest = Math.max(...snaps.map((s) => s.taken_at));
    add("kv", { id: "listings_latest", pk: "listings_latest", type: "pointer", taken_at: latest });
  }
  for (const s of t("item_settings")) add("listings", { id: "settings", pk: s.item_id, type: "item_settings", item_id: s.item_id, floor_price: s.floor_price ?? null, collection_only: s.collection_only ? 1 : 0, notes: s.notes ?? null });
  for (const s of t("product_specs")) add("listings", { id: "specs", pk: s.item_id, type: "product_specs", item_id: s.item_id, title: s.title, at: s.at, lookup: s.lookup });

  // Orders with their items embedded (items without an order are left out, as the old JOIN left them out).
  const orderIds = new Set(t("orders").map((o) => o.order_id));
  const orphans = t("order_items").filter((i) => !orderIds.has(i.order_id));
  if (orphans.length) notes.push(`${orphans.length} order items had no order and were left out`);
  for (const o of t("orders")) {
    const its = t("order_items").filter((i) => i.order_id === o.order_id);
    const bad = its.filter((i) => !/^[\w-]{1,64}$/.test(String(i.item_id)));
    if (bad.length) notes.push(`order ${o.order_id}: ${bad.length} items with unusual ids left out`);
    add("orders", {
      id: o.order_id,
      pk: o.order_id,
      type: "order",
      order_id: o.order_id,
      created_at: o.created_at,
      total: o.total ?? null,
      fees: o.fees ?? null,
      currency: o.currency ?? null,
      status: o.status ?? null,
      items: Object.fromEntries(its.filter((i) => !bad.includes(i)).map((i) => [String(i.item_id), { title: i.title, quantity: i.quantity, price: i.price ?? null }])),
    });
  }

  // Nightly health flags, one document per run.
  const runs = new Map<number, any[]>();
  for (const f of t("health_flags")) runs.set(f.checked_at, [...(runs.get(f.checked_at) ?? []), { item_id: f.item_id, flag: f.flag, detail: f.detail }]);
  for (const [checked_at, flags] of runs) add("jobs", { id: `health:${pad13(checked_at)}`, pk: "health", type: "health_run", checked_at, flags });

  // Buyer questions and offers already seen (so they aren't drafted again).
  for (const m of t("buyer_messages")) {
    const id = await docIds.question(m.message_id);
    add("messages", { id, pk: id, type: "question", message_id: m.message_id, item_id: m.item_id, sender: m.sender, body: m.body, received_at: m.received_at, proposal_id: m.proposal_id ?? "" });
  }
  for (const o of t("best_offers")) {
    const id = await docIds.offer(o.best_offer_id);
    add("messages", { id, pk: id, type: "offer", best_offer_id: o.best_offer_id, item_id: o.item_id, buyer: o.buyer, price: o.price, seen_at: o.seen_at, proposal_id: o.proposal_id ?? "" });
  }

  // The pricing engine: decisions (plus each item's latest), learned parameters, bundle advice, identities.
  const decisions = t("price_decisions");
  for (const d of decisions)
    add("pricing", { id: d1Id(d.at, d.id), pk: d.item_id ?? "none", type: "decision", item_id: d.item_id ?? null, at: d.at, grp: d.grp, strategy: d.strategy, price: d.price ?? null, total: d.total ?? null, market_price: d.market_price ?? null, predicted_days: d.predicted_days ?? null, result: d.result });
  const byItem = new Map<string, any[]>();
  for (const d of decisions) if (d.item_id) byItem.set(d.item_id, [...(byItem.get(d.item_id) ?? []), d]);
  for (const [item, ds] of byItem) {
    const d = latestBy(ds, (x) => x.at * 1e6 + x.id)!;
    add("pricing", { id: "latest", pk: item, type: "decision_latest", item_id: item, at: d.at, grp: d.grp, strategy: d.strategy, price: d.price ?? null, total: d.total ?? null, market_price: d.market_price ?? null, predicted_days: d.predicted_days ?? null, result: d.result });
  }
  for (const p of t("pricing_params")) add("pricing", { id: await docIds.params(p.grp), pk: "_params", type: "params", grp: p.grp, tau: p.tau, alpha: p.alpha, n: p.n, updated_at: p.updated_at });
  for (const b of t("bundle_advice")) add("pricing", { id: d1Id(b.at, b.id), pk: "_bundle", type: "bundle_advice", at: b.at, kind: b.kind, item_ids: b.item_ids, detail: b.detail, status: b.status });
  for (const i of t("item_identity")) {
    const id = await docIds.identity(i.key);
    add("cache", { id, pk: id, type: "identity", key: i.key, item_id: i.item_id ?? null, identity: i.identity, at: i.at });
  }

  // Market snapshots: one document per search per day, kept for what's left of their 180 days.
  const buckets = new Map<string, any>();
  for (const m of t("market_snapshots")) {
    const k = `${m.key}\u0000${m.taken_at}`;
    const b = buckets.get(k) ?? { key: m.key, taken_at: m.taken_at, grp: m.grp, market: m.market, share: m.share, items: [] as any[] };
    if (!b.items.some((x: any) => x.item_id === m.item_id)) b.items.push({ item_id: m.item_id, total: m.total });
    buckets.set(k, b);
  }
  let expiredMarket = 0;
  for (const b of buckets.values()) {
    const ttl = Math.floor((b.taken_at + 180 * DAY - now) / 1000);
    if (ttl <= 0) {
      expiredMarket++;
      continue;
    }
    add("market", { id: pad13(b.taken_at), pk: await docIds.marketPk(b.key), type: "market_bucket", ...b, ttl });
  }
  if (expiredMarket) notes.push(`${expiredMarket} market snapshot days were past 180 days and left out`);

  // Sold-data cache: kept for what's left of its 30 days (searches already paid for).
  let expiredCache = 0;
  for (const c of t("solddata_cache")) {
    const ttl = Math.floor((c.fetched_at + 30 * DAY - now) / 1000);
    if (ttl <= 0) {
      expiredCache++;
      continue;
    }
    const id = await docIds.solddata(c.key);
    add("cache", { id, pk: id, type: "solddata", key: c.key, provider: c.provider, fetched_at: c.fetched_at, sales: c.sales, ttl });
  }
  if (expiredCache) notes.push(`${expiredCache} sold-data searches were past 30 days and left out`);

  for (const u of t("claude_usage"))
    add("usage", { id: d1Id(u.at, u.id), pk: day(u.at), type: "usage", at: u.at, job: u.job, model: u.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_tokens: u.cache_read_tokens ?? 0, cache_write_tokens: u.cache_write_tokens ?? 0, cost_usd: u.cost_usd, stop_reason: u.stop_reason ?? null });

  for (const r of t("audit_reports")) add("reports", { id: d1Id(r.at, r.id), pk: r.env, type: "firstday", at: r.at, env: r.env, ...(await reportBody(r.report)) });

  for (const s of SKIPPED_TABLES) if (t(s).length) notes.push(`${s}: ${t(s).length} rows not carried over (bound to the old address or short-lived)`);
  return { docs: out, notes };
}

/** How many rows of each table should arrive, for checking an import. */
export function expectedCounts(rows: Rows, docs: Planned[]) {
  const n = (c: Container, type: string) => docs.filter((d) => d.container === c && d.doc.type === type).length;
  return [
    ["proposals", rows.proposals?.length ?? 0, n("proposals", "proposal")],
    ["audit_log", rows.audit_log?.length ?? 0, n("audit", "audit")],
    ["listing_snapshots", rows.listing_snapshots?.length ?? 0, n("listings", "snapshot")],
    ["listing_traffic", rows.listing_traffic?.length ?? 0, n("listings", "traffic")],
    ["item_settings", rows.item_settings?.length ?? 0, n("listings", "item_settings")],
    ["product_specs", rows.product_specs?.length ?? 0, n("listings", "product_specs")],
    ["orders", rows.orders?.length ?? 0, n("orders", "order")],
    ["price_decisions", rows.price_decisions?.length ?? 0, n("pricing", "decision")],
    ["claude_usage", rows.claude_usage?.length ?? 0, n("usage", "usage")],
    ["audit_reports", rows.audit_reports?.length ?? 0, n("reports", "firstday")],
    ["buyer_messages", rows.buyer_messages?.length ?? 0, n("messages", "question")],
    ["best_offers", rows.best_offers?.length ?? 0, n("messages", "offer")],
    ["settings", rows.settings?.length ?? 0, n("kv", "setting")],
  ] as [string, number, number][];
}
