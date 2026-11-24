import { hashId, type DocStore } from "./doc";
import { EVENT, eventOp, seenDoc, type EventName, type ReasonCode, type SuggestionEvent } from "./events";

// Inbox to-dos (src/todos.ts): what needs K that isn't an eBay change. Answer a question, let Claude draft,
// or do something by hand. They never touch eBay; a Claude draft files ordinary proposals.
//
// Kept in the pricing container under their own partition, as the bundle advice is, so no new container
// (and no infrastructure change) was needed. One document per check and listing (or subject, such as a
// policy): the id is a hash of both, so the audit and the nightly run file the same to-do, not two.

const C = "pricing" as const;
const PK = "_todo";

export type TodoKind = "answer" | "claude" | "you";
export type TodoStatus = "open" | "done" | "dismissed" | "resolved";

export interface TodoInput {
  code: string;
  kind: TodoKind;
  itemId: string | null;
  itemTitle: string | null;
  /** What it's about when it isn't a listing, such as a policy; part of the id. */
  subject?: string | null;
  title: string;
  detail: string;
  /** For an answer: what to ask K. */
  question?: string | null;
  /** What makes it the same problem. A dismissed or done to-do comes back only when this changes. */
  fingerprint: string;
}

export interface TodoRow {
  id: string;
  code: string;
  kind: TodoKind;
  source: string;
  item_id: string | null;
  item_title: string | null;
  title: string;
  detail: string;
  question: string | null;
  fingerprint: string;
  status: TodoStatus;
  created_at: number;
  at: number;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  /** Counts up each time it reopens. Absent (1) on rows from before 2026-11-24. */
  episode?: number;
  /** When this episode opened; created_at stays the first time it was ever filed. */
  opened_at?: number;
  closed_reason?: ReasonCode | null;
}

/** Which to-dos a run is responsible for: these checks, on these listings (null: every listing). */
export interface TodoScope {
  codes: string[];
  itemIds?: string[] | null;
  /** Why this run's missing to-dos resolve, when it knows; otherwise the problem has gone. */
  resolvedReason?: (t: TodoRow) => ReasonCode;
}

/** Runs whose to-dos hold only the app's and K's words, so History may keep them. Any other keeps ids and codes. */
const KEEPS_WORDS = ["audit", "nightly", "listing", "services", "allowance", "monitor", "bundles", "bundle"];

const strip = ({ pk, type, _etag, ttl, _rid, _self, _attachments, _ts, ...r }: any) => r as TodoRow;

export const todoId = async (code: string, itemId: string | null, subject?: string | null) => `todo:${await hashId(`${code}:${itemId ?? subject ?? "-"}`)}`;

export function todosRepo(docs: DocStore) {
  const inScope = (t: TodoRow, s: TodoScope) => s.codes.includes(t.code) && (s.itemIds == null || (t.item_id != null && s.itemIds.includes(t.item_id)));
  const isTodo = { f: "type", op: "=" as const, v: "todo" };
  const about = (t: TodoRow, event: EventName, at: number, o: { actor?: string | null; reason_code?: ReasonCode; note?: string | null } = {}) => ({
    suggestion_id: t.id,
    source: "todo" as const,
    item_id: t.item_id,
    kind: t.code,
    episode: t.episode ?? 1,
    event,
    at,
    actor: o.actor ?? null,
    reason_code: o.reason_code ?? null,
    snapshot: KEEPS_WORDS.includes(t.source)
      ? { title: t.title, detail: t.detail, note: o.note ?? t.note ?? null, filed_at: t.opened_at ?? t.created_at, item_title: t.item_title }
      : null,
  });
  const closingEvent = (t: TodoRow): EventName => (t.status === "open" ? "resolved" : t.status);
  /** A row closed before events existed has none: its closing is recorded before a reopen blanks it. */
  const hasClosingEvent = async (t: TodoRow) =>
    (await docs.query<any>(C, { pk: PK, where: [{ f: "type", op: "=", v: EVENT }, { f: "suggestion_id", op: "=", v: t.id }], fields: ["event", "episode"] })).some((e) => e.event === closingEvent(t) && e.episode === (t.episode ?? 1));
  /** open -> resolved, once, with why. */
  const resolve = async (t: TodoRow, now: number, why: ReasonCode) =>
    (
      await docs.batch(C, PK, [
        {
          op: "patch",
          id: t.id,
          ops: [{ op: "set", path: "/status", value: "resolved" }, { op: "set", path: "/decided_at", value: now }, { op: "set", path: "/closed_reason", value: why }],
          cond: [{ f: "status", op: "=", v: "open" }],
        },
        eventOp(PK, about(t, "resolved", now, { reason_code: why })),
      ])
    ).ok;
  return {
    /**
     * Files a run's to-dos. New ones open; open ones are refreshed; done or dismissed ones stay closed unless
     * their fingerprint changed (a different problem), and resolved ones reopen (the problem came back).
     * Open to-dos in scope that the run didn't find any more are marked resolved.
     */
    async sync(source: string, scope: TodoScope, todos: TodoInput[], now: number): Promise<{ opened: number; resolved: number }> {
      const existing = new Map((await docs.query<any>(C, { pk: PK, where: [isTodo] })).map((d) => [d.id as string, { row: strip(d), etag: d._etag as string | undefined }]));
      let opened = 0;
      const seen = new Set<string>();
      for (const t of todos) {
        const id = await todoId(t.code, t.itemId, t.subject);
        if (seen.has(id)) continue;
        seen.add(id);
        const found = existing.get(id);
        const ex = found?.row;
        const fields = { code: t.code, kind: t.kind, source, item_id: t.itemId, item_title: t.itemTitle, title: t.title, detail: t.detail, question: t.question ?? null, fingerprint: t.fingerprint, at: now };
        if (!ex) {
          const row: TodoRow = { id, ...fields, status: "open", created_at: now, opened_at: now, episode: 1, closed_reason: null, decided_at: null, decided_by: null, note: null };
          // Someone else filing the same one at the same moment is fine: there is one document per check and listing.
          if ((await docs.batch(C, PK, [{ op: "create", doc: { ...row, pk: PK, type: "todo" } }, eventOp(PK, about(row, "filed", now))])).ok) opened++;
        } else if (ex.status === "open" || ex.status === "resolved" || ex.fingerprint !== t.fingerprint) {
          const reopens = ex.status !== "open";
          const row: TodoRow = {
            ...ex,
            ...fields,
            ...(reopens ? { status: "open" as const, decided_at: null, decided_by: null, note: null, closed_reason: null, episode: (ex.episode ?? 1) + 1, opened_at: now } : {}),
          };
          const reworded = ex.title !== row.title || ex.detail !== row.detail || ex.fingerprint !== row.fingerprint || ex.question !== row.question;
          const events = reopens
            ? [
                ...((await hasClosingEvent(ex)) ? [] : [eventOp(PK, about(ex, closingEvent(ex), ex.decided_at ?? now, { actor: ex.decided_by, reason_code: ex.decided_by ? "person" : "unknown" }))]),
                eventOp(PK, about(row, "reopened", now)),
              ]
            : reworded
              ? [eventOp(PK, about(row, "refreshed", now))]
              : [];
          // Only if nobody has touched it since it was read: a dismissal made meanwhile stands.
          const { ok } = await docs.batch(C, PK, [{ op: "replace", doc: { ...row, pk: PK, type: "todo" }, etag: found!.etag }, ...events]);
          if (ok && reopens) opened++;
        }
      }
      let resolved = 0;
      for (const { row: t } of existing.values())
        if (t.status === "open" && !seen.has(t.id) && inScope(t, scope)) if (await resolve(t, now, scope.resolvedReason?.(t) ?? "problem_gone")) resolved++;
      return { opened, resolved };
    },

    /** Open to-dos for listings that are no longer live (ended or sold), except checks about ended listings. */
    async resolveForEnded(liveItemIds: string[], now: number, keepCodes: string[] = ["ended_unsold"], sold: ReadonlySet<string> = new Set()): Promise<number> {
      const open = (await docs.query<any>(C, { pk: PK, where: [isTodo, { f: "status", op: "=", v: "open" }] })).map(strip);
      let n = 0;
      for (const t of open)
        if (t.item_id && !liveItemIds.includes(t.item_id) && !keepCodes.includes(t.code))
          if (await resolve(t, now, sold.has(t.item_id) ? "listing_sold" : "listing_ended")) n++;
      return n;
    },

    /** Whether any to-do was ever filed (any status). */
    any: async () => (await docs.query<any>(C, { pk: PK, where: [isTodo], limit: 1, fields: ["id"] })).length > 0,
    list: async (status: TodoStatus): Promise<TodoRow[]> => (await docs.query<any>(C, { pk: PK, where: [isTodo, { f: "status", op: "=", v: status }] })).map(strip),
    /** Every to-do, whatever its status. */
    all: async (): Promise<TodoRow[]> => (await docs.query<any>(C, { pk: PK, where: [isTodo] })).map(strip),
    /** Every to-do event (filed, reopened, closed, seen), oldest first. */
    events: async (): Promise<SuggestionEvent[]> => docs.query<any>(C, { pk: PK, where: [{ f: "type", op: "=", v: EVENT }], orderBy: ["at", "asc"] }),
    markSeen: async (id: string, user: { id: string; name: string }, at: number) => {
      const d = /^todo:[\w-]{1,64}$/.test(id) ? await docs.get(C, id, PK) : null;
      if (d) await docs.create(C, await seenDoc(PK, user.id, { ...about(strip(d), "seen", at, { actor: user.name }), snapshot: null }));
    },
    /** An eBay user closed their account: their name goes from to-dos and from what History kept of them. */
    async scrubText(text: string): Promise<number> {
      const gone = (v: unknown) => (typeof v === "string" ? v.split(text).join("[deleted]") : (v ?? null));
      let n = 0;
      for (const d of await docs.query<any>(C, { pk: PK })) {
        const part = d.type === EVENT ? d.snapshot : d;
        const keys = ["title", "detail", "question", "note", "item_title"].filter((k) => typeof part?.[k] === "string" && part[k].includes(text));
        if (!keys.length) continue;
        const ops = d.type === EVENT ? [{ op: "set" as const, path: "/snapshot", value: Object.fromEntries(Object.entries(part).map(([k, v]) => [k, gone(v)])) }] : keys.map((k) => ({ op: "set" as const, path: `/${k}`, value: gone(part[k]) }));
        if (await docs.patch(C, d.id, PK, ops)) n++;
      }
      return n;
    },
    get: async (id: string): Promise<TodoRow | null> => {
      if (!/^todo:[\w-]{1,64}$/.test(id)) return null;
      const d = await docs.get(C, id, PK);
      return d ? strip(d) : null;
    },
    /** open -> done or dismissed, once. */
    close: async (id: string, status: "done" | "dismissed", by: string, now: number, note: string | null = null): Promise<boolean> => {
      const d = await docs.get(C, id, PK);
      if (!d) return false;
      const { ok } = await docs.batch(C, PK, [
        {
          op: "patch",
          id,
          ops: [
            { op: "set", path: "/status", value: status },
            { op: "set", path: "/decided_at", value: now },
            { op: "set", path: "/decided_by", value: by },
            { op: "set", path: "/note", value: note },
            { op: "set", path: "/closed_reason", value: "person" },
          ],
          cond: [{ f: "status", op: "=", v: "open" }],
        },
        eventOp(PK, about(strip(d), status, now, { actor: by, reason_code: "person", note })),
      ]);
      return ok;
    },
  };
}
