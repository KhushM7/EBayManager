import type { Env } from "../env";
import { orderLines, type LatestRow } from "../store";
import { claudeDailyBudgetUsd } from "../rules";
import { decisionUrl } from "../links";
import { r2, reliableDays } from "../util";

// The tables behind the read-only API (docs/power-platform.md): what Power BI, Power Automate and Copilot
// Studio may see. Store reads only: nothing here writes to the store, calls eBay or Claude, or imports
// anything that can (test/readonly.test.ts follows the imports to prove it).
//
// No buyer personal data leaves through these tables. Orders are stored without buyer fields; proposals carry
// only the allowlisted fields below, and a reply or an offer answer carries no text at all; eBay's order
// numbers are replaced by a short hash.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms: number | null | undefined) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hours = (ms: number) => Math.round((ms / HOUR) * 10) / 10;

/** How far back a table goes: `days` from the query, 1 to 730, 90 unless said. */
export const sinceDays = (days: unknown, fallback = 90) => {
  const n = Number(days);
  return Date.now() - (Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 730) : fallback) * DAY;
};

async function shortHash(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Listings ---

export async function listingsTable(env: Env, now = Date.now()) {
  const rows = await env.store.listings.latestSet();
  const flags = await env.store.jobs.latestHealthFlags();
  const pending = await env.store.proposals.listByStatus("pending", "asc");
  return rows.map((l) => ({
    item_id: l.item_id,
    title: l.title,
    price: l.price,
    currency: l.currency,
    quantity: l.quantity_available,
    watchers: l.watch_count ?? 0,
    views_7d: l.views_7d ?? null,
    impressions_7d: l.impressions_7d ?? null,
    start_date: iso(Date.parse(l.first_start_time ?? l.start_time)),
    days_listed: Math.max(0, Math.floor((now - Date.parse(l.first_start_time ?? l.start_time)) / DAY)),
    health_flags: flags.filter((f) => f.item_id === l.item_id).map((f) => f.flag).join(" "),
    waiting_changes: pending.filter((p) => p.item_id === l.item_id).length,
    snapshot_at: iso(l.taken_at),
  }));
}

/** One row per day: how many listings were live, their asking total and watchers (the day's last snapshot). */
export async function listingsDailyTable(env: Env, since: number) {
  const snaps = await env.store.listings.snapshotsSince(since);
  const last = new Map<string, number>();
  for (const s of snaps) last.set(isoDay(s.taken_at), Math.max(last.get(isoDay(s.taken_at)) ?? 0, s.taken_at));
  const days = new Map<string, { date: string; active_listings: number; asking_total: number; watchers: number }>();
  for (const s of snaps) {
    const date = isoDay(s.taken_at);
    if (s.taken_at !== last.get(date)) continue;
    const d = days.get(date) ?? { date, active_listings: 0, asking_total: 0, watchers: 0 };
    d.active_listings++;
    d.asking_total = r2(d.asking_total + (s.price ?? 0) * Math.max(s.quantity_available ?? 1, 1));
    d.watchers += s.watch_count ?? 0;
    days.set(date, d);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// --- Sales ---

export interface SaleRow {
  sale_id: string;
  sold_at: string;
  sold_ms: number;
  item_id: string;
  title: string;
  quantity: number;
  /** What one item sold for, without postage. */
  item_price: number | null;
  line_total: number | null;
  days_to_sell: number | null;
  source: "ebay" | "imported";
}

export async function salesTable(env: Env, since: number): Promise<SaleRow[]> {
  const latest = await env.store.listings.latestAll();
  const lines = orderLines(await env.store.orders.since(since));
  const out: SaleRow[] = [];
  for (const l of lines) {
    const start = Date.parse(latest.get(l.item_id)?.first_start_time ?? "");
    const quantity = Math.max(1, Number(l.quantity) || 1);
    out.push({
      // eBay's order number isn't sent: this is only a stable name for the row.
      sale_id: await shortHash(`${l.order_id}:${l.item_id}`),
      sold_at: iso(l.created_at)!,
      sold_ms: l.created_at,
      item_id: l.item_id,
      title: l.title,
      quantity,
      item_price: l.price == null ? null : r2(l.price / quantity),
      line_total: l.price,
      days_to_sell: Number.isFinite(start) && l.created_at >= start ? Math.round(((l.created_at - start) / DAY) * 10) / 10 : null,
      source: l.status === "IMPORTED" ? "imported" : "ebay",
    });
  }
  return out.sort((a, b) => a.sold_ms - b.sold_ms);
}

// --- Proposals (labels) ---

/** The only payload fields that leave, by kind. A reply to a buyer (`message`) sends none. */
const PAYLOAD_FIELDS: Record<string, string[]> = {
  price: ["oldPrice", "newPrice"],
  revise: ["title", "bestOfferEnabled"],
  promote: ["action", "rate", "currentRate", "suggestedRate"],
  offer_to_watchers: ["percent", "price", "offerPrice", "watchers"],
  create_listing: ["title", "price"],
  best_offer_response: ["offerPrice", "listPrice", "action", "counterPrice"],
};
/** Kinds whose reason is written about a buyer's message, so it stays in the app. */
const BUYER_KINDS = new Set(["message", "new_message", "best_offer_response"]);
const KIND_WORDS: Record<string, string> = {
  price: "Price change",
  revise: "Listing edit",
  create_listing: "New listing",
  end_listing: "End listing",
  relist: "Relist",
  promote: "Promotion",
  offer_to_watchers: "Offer to watchers",
  message: "Reply to a buyer",
  best_offer_response: "Answer to a Best Offer",
  policy: "Policy change",
};
/** How a proposal ended, for the approval funnel. */
const OUTCOME: Record<string, string> = {
  pending: "waiting",
  approved: "approved",
  applying: "approved",
  applied: "approved",
  failed: "approved",
  agreed: "approved",
  rejected: "rejected",
  expired: "expired",
};

const scalar = (v: unknown) => (typeof v === "number" || typeof v === "boolean" ? v : typeof v === "string" ? v.slice(0, 200) : null);

function safePayload(kind: string, payload: string): Record<string, string | number | boolean | null> {
  let p: any;
  try {
    p = JSON.parse(payload);
  } catch {
    return {};
  }
  if (!p || typeof p !== "object") return {};
  return Object.fromEntries((PAYLOAD_FIELDS[kind] ?? []).filter((f) => f in p).map((f) => [f, scalar(p[f])]));
}

export interface ProposalOut {
  id: string;
  kind: string;
  kind_label: string;
  item_id: string | null;
  item_title: string | null;
  status: string;
  outcome: string;
  /** True when the change reached eBay. */
  applied: boolean;
  dry_run: boolean;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
  hours_to_decide: number | null;
  decided_by: string | null;
  details: Record<string, string | number | boolean | null>;
  created_ms: number;
  expires_ms: number;
}

function proposalOut(p: { id: string; kind: string; item_id: string | null; payload: string; reason: string | null; status: string; dry_run: number; created_at: number; expires_at: number; decided_at?: number | null; decided_by?: string | null }, latest: Map<string, LatestRow>): ProposalOut {
  const details = safePayload(p.kind, p.payload);
  let title: string | null = null;
  try {
    const t = JSON.parse(p.payload)?.itemTitle;
    if (typeof t === "string") title = t.slice(0, 200);
  } catch {}
  const decided = p.status === "pending" ? null : (p.decided_at ?? null);
  return {
    id: p.id,
    kind: p.kind,
    kind_label: KIND_WORDS[p.kind] ?? p.kind,
    item_id: p.item_id,
    item_title: (p.item_id ? latest.get(p.item_id)?.title : null) ?? title ?? (typeof details.title === "string" ? details.title : null),
    status: p.status,
    outcome: OUTCOME[p.status] ?? p.status,
    applied: p.status === "applied",
    dry_run: Boolean(p.dry_run),
    reason: BUYER_KINDS.has(p.kind) ? null : (p.reason?.slice(0, 600) ?? null),
    created_at: iso(p.created_at)!,
    decided_at: iso(decided),
    expires_at: iso(p.expires_at)!,
    hours_to_decide: decided != null && ["approved", "applying", "applied", "failed", "agreed", "rejected"].includes(p.status) ? hours(decided - p.created_at) : null,
    decided_by: p.status === "expired" ? null : (p.decided_by ?? null),
    details,
    created_ms: p.created_at,
    expires_ms: p.expires_at,
  };
}

export async function proposalsTable(env: Env, since: number, status?: string): Promise<ProposalOut[]> {
  const latest = await env.store.listings.latestAll();
  const rows = await env.store.proposals.listWhere([{ f: "created_at", op: ">=", v: since }, ...(status ? [{ f: "status", op: "=" as const, v: status }] : [])]);
  return rows.map((p) => proposalOut(p, latest)).sort((a, b) => a.created_ms - b.created_ms);
}

/**
 * What's waiting for a person, oldest first, with how long it has waited and how long is left.
 *
 * `open_url` opens the app, where the person signs in and decides. `approve_url` and `reject_url` are the same
 * signed, expiring pages a push notification opens: opening one only shows the change, and deciding is that
 * page's own POST. They're given only on the real account, where the page also needs a signed-in device, so
 * this key can never decide anything by itself. Replies and offer answers are decided in the app.
 */
export async function waitingTable(env: Env, now = Date.now()) {
  const latest = await env.store.listings.latestAll();
  const rows = (await env.store.proposals.listByStatus("pending", "asc")).filter((p) => p.expires_at > now);
  const drafts = new Map<string, string>();
  const out = [];
  for (const p of rows) {
    const o = proposalOut(p, latest);
    // A new listing is for whoever made its draft; everything else is the owner's.
    let who = "owner";
    if (p.kind === "create_listing") {
      let draftId: unknown;
      try {
        draftId = JSON.parse(p.payload)?.draftId;
      } catch {}
      if (typeof draftId === "string") {
        if (!drafts.has(draftId)) drafts.set(draftId, (await env.store.drafts.get(draftId))?.created_by ?? "owner");
        who = drafts.get(draftId)!;
      }
    }
    const links = env.EBAY_ENV === "production" && !p.dry_run && !BUYER_KINDS.has(p.kind);
    const { created_ms, expires_ms, decided_at, decided_by, hours_to_decide, outcome, applied, ...rest } = o;
    out.push({
      ...rest,
      for: who,
      hours_waiting: hours(now - p.created_at),
      hours_left: hours(p.expires_at - now),
      open_url: `${env.PUBLIC_URL}/`,
      approve_url: links ? await decisionUrl(env, p, "approve") : null,
      reject_url: links ? await decisionUrl(env, p, "reject") : null,
    });
  }
  return out;
}

// --- Pricing ---

function parseResult(result: string): any {
  try {
    return JSON.parse(result);
  } catch {
    return null; // a very long result is stored cut short
  }
}

/** The engine's latest price for each live listing, with its reasoning in words. */
export async function pricingTable(env: Env, itemId?: string) {
  const latest = await env.store.listings.latestAll();
  const rows = itemId ? [await env.store.pricing.latestDecision(itemId)].filter((r) => r != null) : await env.store.pricing.latestDecisions();
  return rows
    .map((r) => {
      const d = parseResult(r.result)?.decision;
      const l = r.item_id ? latest.get(r.item_id) : undefined;
      return {
        item_id: r.item_id,
        title: l?.title ?? null,
        current_price: l?.price ?? null,
        decided_at: iso(r.at)!,
        strategy: r.strategy,
        suggested_price: r.price,
        suggested_total_with_postage: r.total,
        market_price: r.market_price,
        confidence: typeof d?.confidence === "number" ? d.confidence : null,
        why: typeof d?.why === "string" ? d.why.slice(0, 1500) : null,
        question: typeof d?.question === "string" ? d.question.slice(0, 500) : null,
        options: Array.isArray(d?.options) ? d.options.slice(0, 5).map((o: any) => ({ price: Number(o?.price) || null, days_to_sell: reliableDays(o?.daysToSell) })) : [],
      };
    })
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
}

/** Every price the engine gave for K's own items (no reasoning text), for trends. */
export async function priceDecisionsTable(env: Env, since: number) {
  return (await env.store.pricing.decisionSummaries(since))
    .map((r) => ({ item_id: r.item_id!, decided_at: iso(r.at)!, decided_ms: r.at, group: r.grp, strategy: r.strategy, suggested_price: r.price, suggested_total_with_postage: r.total, market_price: r.market_price, predicted_days: reliableDays(r.predicted_days) }))
    .sort((a, b) => a.decided_ms - b.decided_ms);
}

/**
 * Pricing accuracy: each sale beside the engine's last price for that item before it sold. `error` is sold
 * minus predicted; `abs_pct_error` is its size as a share of the sold price. Sales the engine never priced
 * beforehand are left out (`priced` in the summary says how many were compared).
 */
export async function accuracyTable(env: Env, since: number) {
  const sales = await salesTable(env, since);
  const decisions = (await env.store.pricing.decisionSummaries(0)).filter((d) => d.price != null && d.price > 0);
  const byItem = new Map<string, typeof decisions>();
  for (const d of decisions) byItem.set(d.item_id!, [...(byItem.get(d.item_id!) ?? []), d]);
  const rows = [];
  for (const s of sales) {
    if (s.item_price == null || s.item_price <= 0) continue;
    const before = (byItem.get(s.item_id) ?? []).filter((d) => d.at <= s.sold_ms).sort((a, b) => b.at - a.at)[0];
    if (!before) continue;
    const error = r2(s.item_price - before.price!);
    rows.push({
      sale_id: s.sale_id,
      sold_at: s.sold_at,
      item_id: s.item_id,
      title: s.title,
      group: before.grp,
      strategy: before.strategy,
      predicted_at: iso(before.at)!,
      days_before_sale: Math.round(((s.sold_ms - before.at) / DAY) * 10) / 10,
      predicted_price: before.price!,
      market_price: before.market_price,
      sold_price: s.item_price,
      error,
      abs_pct_error: Math.round((Math.abs(error) / s.item_price) * 1000) / 1000,
    });
  }
  const mean = rows.length ? Math.round((rows.reduce((t, r) => t + r.abs_pct_error, 0) / rows.length) * 1000) / 1000 : null;
  return { rows, summary: { sales: sales.length, priced: rows.length, mean_abs_pct_error: mean } };
}

// --- Listing health ---

export async function healthTable(env: Env, since: number) {
  const latest = await env.store.listings.latestAll();
  return (await env.store.jobs.healthRunsSince(since)).flatMap((run) =>
    run.flags.map((f) => ({ date: isoDay(run.checked_at), checked_at: iso(run.checked_at)!, item_id: f.item_id, title: latest.get(f.item_id)?.title ?? null, flag: f.flag, detail: String(f.detail ?? "").slice(0, 300) })),
  );
}

// --- Claude spend ---

export async function spendTable(env: Env, since: number) {
  const rows = new Map<string, { date: string; job: string; model: string; calls: number; input_tokens: number; output_tokens: number; cost_usd: number; daily_budget_usd: number }>();
  for (const u of await env.store.usage.since(since)) {
    // "triage:1234567890" is the triage job for one listing: the listing isn't part of the job's name here.
    const job = u.job.includes(":") ? u.job.slice(0, u.job.indexOf(":")) : u.job;
    const key = `${isoDay(u.at)}|${job}|${u.model}`;
    const r = rows.get(key) ?? { date: isoDay(u.at), job, model: u.model, calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, daily_budget_usd: claudeDailyBudgetUsd(env) };
    r.calls++;
    r.input_tokens += u.input_tokens ?? 0;
    r.output_tokens += u.output_tokens ?? 0;
    r.cost_usd = Math.round((r.cost_usd + (u.cost_usd ?? 0)) * 1e6) / 1e6;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.job.localeCompare(b.job));
}

// --- Status ---

export async function statusTable(env: Env, now = Date.now()) {
  const nightly = await env.store.kv.getJson<{ at: number; proposals: number }>("last_nightly").catch(() => null);
  const pending = (await env.store.proposals.listByStatus("pending", "asc")).filter((p) => p.expires_at > now);
  return {
    environment: env.EBAY_ENV,
    // Whether approved changes reach eBay here ("approval") or everything is a dry run ("off").
    write_mode: env.WRITE_MODE,
    read_only: true,
    active_listings: (await env.store.listings.latestSet()).length,
    waiting_changes: pending.length,
    last_nightly_at: iso(nightly?.at),
    claude_daily_budget_usd: claudeDailyBudgetUsd(env),
    now: iso(now)!,
  };
}
