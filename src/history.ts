import type { Env } from "./env";
import { log, swallow } from "./log";
import type { ProposalRow, TodoRow } from "./store";
import { nothingSent } from "./store/proposals";
import type { ReasonCode, SuggestionEvent, SuggestionSource } from "./store/events";

// History: every suggestion the app has made and what became of it (docs/approvals.md). Three kinds in one list:
// labels (proposals), to-dos and the old bundle advice. It reads what is stored and says so plainly when a reason
// wasn't recorded; it never changes eBay.

export type OutcomeGroup = "done" | "declined" | "closed" | "problem";

export interface Outcome {
  group: OutcomeGroup;
  words: string;
}

export interface HistoryRow {
  key: string;
  source: SuggestionSource;
  id: string;
  episode: number;
  kind: string;
  item_id: string | null;
  item_title: string | null;
  title: string;
  detail: string | null;
  outcome: Outcome;
  /** When it closed, which is how History is ordered. */
  at: number;
  filed_at: number;
  superseded_by: string | null;
}

const by = (who: string | null | undefined) => (who ? ` by ${who}` : "");

const CLOSED_WORDS: Record<ReasonCode, string> = {
  person: "Closed by a person",
  lapsed: "Ran out of time",
  superseded: "Replaced by a newer suggestion",
  problem_gone: "No longer needed: the problem has gone",
  label_filed: "A change was suggested instead",
  listing_sold: "Listing sold",
  listing_ended: "Listing ended",
  replaced_by_run: "Replaced by a newer suggestion",
  nothing_to_do: "Already so on eBay: nothing sent",
  privacy_deletion: "Removed: the buyer closed their eBay account",
  unknown: "Closed, reason not recorded",
};

/** In words, what became of a label. Every status a label can close with is here. */
export function proposalOutcome(p: Pick<ProposalRow, "status" | "decided_by" | "result" | "closed_reason" | "created_at" | "decided_at" | "expires_at">): Outcome | null {
  switch (p.status) {
    case "applied":
      return nothingSent(p.result) ? { group: "done", words: CLOSED_WORDS.nothing_to_do } : { group: "done", words: `Applied${by(p.decided_by)}` };
    case "agreed":
      return { group: "done", words: "Recorded only (read-only days)" };
    case "failed":
      return { group: "problem", words: "eBay refused it" };
    case "rejected":
      return { group: "declined", words: `Rejected${by(p.decided_by)}` };
    case "expired": {
      if (p.closed_reason === "lapsed" || (!p.closed_reason && p.decided_at != null && p.decided_at >= p.expires_at)) {
        const days = Math.round((p.expires_at - p.created_at) / 86_400_000);
        return { group: "closed", words: days >= 1 ? `Ran out after ${days} ${days === 1 ? "day" : "days"}` : "Ran out of time" };
      }
      return { group: "closed", words: CLOSED_WORDS[p.closed_reason ?? "unknown"] };
    }
    default:
      return null;
  }
}

/** In words, what became of a to-do, or of one earlier episode of it. */
export function todoOutcome(event: string, who: string | null | undefined, why: ReasonCode | null | undefined): Outcome | null {
  if (event === "done") return { group: "done", words: `Done${by(who)}` };
  if (event === "dismissed") return { group: "declined", words: `Dismissed${by(who)}` };
  if (event === "resolved") return { group: "closed", words: CLOSED_WORDS[why ?? "unknown"] };
  return null;
}

export function adviceOutcome(status: string, who: string | null | undefined): Outcome | null {
  if (status === "dismissed") return { group: "declined", words: who ? `Dismissed by ${who}` : "Dismissed" };
  if (status === "replaced") return { group: "closed", words: CLOSED_WORDS.replaced_by_run };
  // Left open when the Bundle assistant took over (2026-11-24).
  if (status === "open") return { group: "closed", words: "No longer shown: the Bundle assistant replaced this advice" };
  return null;
}

/** Only these kinds' own words are shown; any other (replies, offers, messages) gets its kind and no text. */
const WORDED_KINDS = ["price", "revise", "create_listing", "end_listing", "relist", "promote", "offer_to_watchers", "policy"];

const pounds = (n: unknown) => (Number.isFinite(Number(n)) && n != null ? `£${Number(n).toFixed(2)}` : "");

function labelTitle(kind: string, a: any): string {
  switch (kind) {
    case "price":
      return a.oldPrice != null ? `Price ${pounds(a.oldPrice)} to ${pounds(a.newPrice)}` : `Set price to ${pounds(a.newPrice)}`;
    case "revise": {
      const parts = [a.title && "title", a.description && "description", a.itemSpecifics && "item specifics", typeof a.bestOfferEnabled === "boolean" && "Best Offer"].filter(Boolean);
      return `Edit the ${parts.join(", ") || "listing"}`;
    }
    case "create_listing":
      return `New listing: ${String(a.title ?? "").slice(0, 80)}`;
    case "promote":
      return a.action === "end" ? "End the promotion" : `Promote at ${a.rate}%`;
    case "offer_to_watchers":
      return `Offer watchers ${a.percent}% off`;
    case "end_listing":
      return "End the listing";
    case "relist":
      return "Relist";
    case "policy":
      return `Return policy: ${String(a.name ?? "").slice(0, 80)}`;
    case "message":
      return "Reply to a buyer";
    case "best_offer_response":
      return "Answer an offer";
    default:
      return kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

interface Entry {
  key: string;
  at: number;
  group: OutcomeGroup | null;
  source: SuggestionSource;
  kind: string;
  item: string | null;
  load: () => Promise<HistoryRow | null>;
}

export interface HistoryQuery {
  outcome?: OutcomeGroup | null;
  source?: SuggestionSource | null;
  kind?: string | null;
  /** An item number, or words in a listing's title. */
  q?: string | null;
  /** The cursor the last page gave. */
  before?: string | null;
  limit?: number;
}

const GROUP_OF: Record<string, OutcomeGroup> = { applied: "done", agreed: "done", rejected: "declined", failed: "problem", expired: "closed" };
const CLOSING = ["done", "dismissed", "resolved"];
const cmp = (a: { at: number; key: string }, b: { at: number; key: string }) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);

export async function suggestionHistory(env: Env, q: HistoryQuery = {}): Promise<{ rows: HistoryRow[]; next: string | null }> {
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 50)), 100);
  const [labels, todos, events, advice, titles] = await Promise.all([
    env.store.proposals.closedIndex(),
    env.store.todos.all(),
    env.store.todos.events(),
    env.store.pricing.allAdvice(),
    env.store.listings.latestAll(),
  ]);
  const titleOf = (id: string | null) => (id ? (titles.get(id)?.title ?? null) : null);
  const entries: Entry[] = [];

  for (const p of labels) {
    const key = `proposal:${p.id}`;
    entries.push({
      key,
      at: p.decided_at ?? p.created_at,
      group: GROUP_OF[p.status] ?? null,
      source: "proposal",
      kind: p.kind,
      item: p.item_id,
      load: async () => {
        const row = await env.store.proposals.get(p.id);
        const outcome = row && proposalOutcome(row);
        if (!row || !outcome) return null;
        const a = JSON.parse(row.payload || "{}");
        const worded = WORDED_KINDS.includes(row.kind);
        return {
          key,
          source: "proposal",
          id: row.id,
          episode: 1,
          kind: row.kind,
          item_id: row.item_id,
          item_title: titleOf(row.item_id) ?? (worded ? (a.itemTitle ?? null) : null),
          title: labelTitle(row.kind, a),
          detail: worded ? [row.reason, row.status === "failed" || row.status === "agreed" ? row.result : null].filter(Boolean).join("\n") || null : null,
          outcome,
          at: row.decided_at ?? row.created_at,
          filed_at: row.created_at,
          superseded_by: row.superseded_by ?? null,
        };
      },
    });
  }

  const todoRow = (t: TodoRow) => (o: Outcome, x: { episode: number; at: number; title: string; detail: string; note: string | null; filed_at: number; key: string }): HistoryRow => ({
    key: x.key,
    source: "todo",
    id: t.id,
    episode: x.episode,
    kind: t.code,
    item_id: t.item_id,
    item_title: titleOf(t.item_id) ?? t.item_title,
    title: x.title,
    // The raw diagnostics of an "eBay refused" to-do can hold a reply; the label itself has what matters.
    detail: [x.detail.split("--- diagnostics ---")[0].trim(), x.note].filter(Boolean).join("\n") || null,
    outcome: o,
    at: x.at,
    filed_at: x.filed_at,
    superseded_by: null,
  });
  const todoById = new Map(todos.map((t) => [t.id, t]));
  const push = (t: TodoRow, o: Outcome, x: Parameters<ReturnType<typeof todoRow>>[1]) =>
    entries.push({ key: x.key, at: x.at, group: o.group, source: "todo", kind: t.code, item: t.item_id, load: async () => todoRow(t)(o, x) });
  for (const t of todos) {
    const o = todoOutcome(t.status, t.decided_by, t.closed_reason ?? null);
    const episode = t.episode ?? 1;
    if (o) push(t, o, { key: `todo:${t.id}:${episode}`, episode, at: t.decided_at ?? t.at, title: t.title, detail: t.detail, note: t.note, filed_at: t.opened_at ?? t.created_at });
  }
  // Earlier episodes of to-dos that came back: the row no longer holds them, their closing event does.
  for (const e of events as SuggestionEvent[]) {
    const t = todoById.get(e.suggestion_id);
    if (!t || !CLOSING.includes(e.event) || e.episode >= (t.episode ?? 1)) continue;
    const o = todoOutcome(e.event, e.actor, e.reason_code);
    const s = e.snapshot;
    if (o) push(t, o, { key: `todo:${t.id}:${e.episode}`, episode: e.episode, at: e.at, title: s?.title ?? t.title, detail: s?.detail ?? "", note: s?.note ?? null, filed_at: s?.filed_at ?? t.created_at });
  }

  for (const a of advice) {
    const o = adviceOutcome(a.status, a.decided_by);
    if (!o) continue;
    const key = `advice:${a.id}`;
    entries.push({
      key,
      at: a.decided_at ?? a.at,
      group: o.group,
      source: "advice",
      kind: "bundle_advice",
      item: a.item_ids.split(",")[0] || null,
      load: async () => {
        const d = JSON.parse(a.detail || "{}");
        return { key, source: "advice", id: a.id, episode: 1, kind: "bundle_advice", item_id: null, item_title: a.item_ids.split(",").map((i) => titleOf(i) ?? i).join("; "), title: `${a.kind === "split" ? "Sell separately" : "Sell together"}: ${d.title ?? ""}`, detail: d.reason ?? null, outcome: o, at: a.decided_at ?? a.at, filed_at: a.at, superseded_by: null };
      },
    });
  }

  entries.sort(cmp);
  const words = q.q?.trim().toLowerCase() || null;
  const cut = /^(\d{1,15})\|(.{1,200})$/.exec(q.before ?? "");
  const rows: HistoryRow[] = [];
  let next: string | null = null;
  for (const e of entries) {
    if (cut && cmp({ at: Number(cut[1]), key: cut[2] }, e) >= 0) continue;
    if (q.outcome && e.group !== q.outcome) continue;
    if (q.source && e.source !== q.source) continue;
    if (q.kind && e.kind !== q.kind) continue;
    if (words && e.item !== words && e.source === "proposal" && e.item && !(titleOf(e.item) ?? "").toLowerCase().includes(words)) continue;
    const row = await e.load();
    if (!row) continue;
    if (words && row.item_id !== words && !`${row.item_title ?? ""} ${row.title}`.toLowerCase().includes(words)) continue;
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      next = `${last.at}|${last.key}`;
      break;
    }
    rows.push(row);
  }
  return { rows, next };
}

const ATTENTION_DAYS = 14;

/**
 * Labels past the decision that still need someone: approved but held, being sent, and refused by eBay with
 * nothing tried since. A refusal drops off once the same change is suggested again for that listing (or draft),
 * or after 14 days; it stays in History either way.
 */
export async function needsAttention(env: Env, now = Date.now()): Promise<ProposalRow[]> {
  const rows = await env.store.proposals.listWhere([{ f: "status", op: "in", v: ["approved", "applying", "failed"] }]);
  const failed = rows.filter((p) => p.status === "failed" && (p.decided_at ?? p.created_at) > now - ATTENTION_DAYS * 86_400_000);
  const subject = (p: ProposalRow) => {
    if (p.item_id) return p.item_id;
    try {
      return String(JSON.parse(p.payload).draftId ?? p.id);
    } catch {
      return p.id;
    }
  };
  const oldest = Math.min(...failed.map((p) => p.created_at));
  const later = failed.length ? await env.store.proposals.listWhere([{ f: "created_at", op: ">", v: oldest }]) : [];
  // Two failures for one listing: the newest speaks for both.
  const open = failed.filter((f) => !later.some((l) => l.kind === f.kind && subject(l) === subject(f) && l.created_at > f.created_at && !["rejected", "expired"].includes(l.status)));
  return [...rows.filter((p) => p.status !== "failed" && !p.dry_run), ...open].sort((a, b) => (b.decided_at ?? b.created_at) - (a.decided_at ?? a.created_at));
}

/** Kinds that only make sense while the listing is live. A reply can still be sent after a sale; offers have their own check. */
const LIVE_ONLY = ["price", "revise", "promote", "offer_to_watchers", "end_listing"];

/**
 * Nightly: pending labels and open to-dos whose listing has sold or ended close, saying which. Only for listings
 * an earlier snapshot saw and the latest doesn't, so one just published is never mistaken for ended.
 */
export async function closeForEnded(env: Env, now = Date.now()): Promise<string> {
  const live = await env.store.listings.latestSet();
  if (!live.length) return "skipped: no listings read";
  const liveIds = live.map((l) => l.item_id);
  const takenAt = Math.max(...live.map((l) => l.taken_at));
  const all = await env.store.listings.latestAll();
  const sold = new Set((await env.store.orders.since(now - 90 * 86_400_000)).flatMap((o) => Object.keys(o.items ?? {})));
  let labels = 0;
  for (const p of await env.store.proposals.listByStatus("pending", "asc")) {
    if (!p.item_id || !LIVE_ONLY.includes(p.kind) || liveIds.includes(p.item_id)) continue;
    const seen = all.get(p.item_id);
    if (!seen?.taken_at || seen.taken_at >= takenAt) continue;
    if (await env.store.proposals.expire(p.id, now, sold.has(p.item_id) ? "listing_sold" : "listing_ended")) labels++;
  }
  const todos = await env.store.todos.resolveForEnded(liveIds, now, undefined, sold);
  const advice = await env.store.pricing.retireAdvice(now).catch(swallow(env, "history.retire_advice"));
  if (labels) await log(env, "info", "history.closed_for_ended", { job: "nightly", detail: `${labels} labels, ${todos} to-dos` });
  return `${labels} labels and ${todos} to-dos closed for sold or ended listings${advice ? `, ${advice} old bundle advice retired` : ""}`;
}

/** A card was on someone's screen: recorded once per person and episode. */
export async function markSeen(env: Env, ids: unknown, user: { id: string; name: string }, now = Date.now()): Promise<number> {
  const list = (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === "string").slice(0, 100);
  for (const id of list) await (id.startsWith("todo:") ? env.store.todos.markSeen(id, user, now) : env.store.proposals.markSeen(id, user, now));
  return list.length;
}

/** The routes, under /api/suggestions. Null: not one of these. */
export async function handleSuggestions(env: Env, path: string, method: string, url: URL, body: () => Promise<any>, user: { id: string; name: string }): Promise<unknown | null> {
  if (path === "/suggestions/history" && method === "GET") {
    const p = url.searchParams;
    const pick = <T extends string>(name: string, allowed: readonly T[]) => allowed.find((x) => x === p.get(name)) ?? null;
    return suggestionHistory(env, {
      outcome: pick("outcome", ["done", "declined", "closed", "problem"] as const),
      source: pick("source", ["proposal", "todo", "advice"] as const),
      kind: /^[a-z_]{1,40}$/.test(p.get("kind") ?? "") ? p.get("kind") : null,
      q: p.get("q")?.slice(0, 80) ?? null,
      before: p.get("before"),
      limit: Number(p.get("limit")) || 50,
    });
  }
  if (path === "/suggestions/attention" && method === "GET") {
    const titles = await env.store.listings.latestAll();
    return (await needsAttention(env)).map((p) => ({ ...p, item_title: (p.item_id && titles.get(p.item_id)?.title) || null, item_price: null, payload: JSON.parse(p.payload) }));
  }
  if (path === "/suggestions/seen" && method === "POST") return { ok: true, seen: await markSeen(env, (await body())?.ids, user) };
  return null;
}
