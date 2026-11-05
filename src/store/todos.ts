import { hashId, type DocStore } from "./doc";

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
}

/** Which to-dos a run is responsible for: these checks, on these listings (null: every listing). */
export interface TodoScope {
  codes: string[];
  itemIds?: string[] | null;
}

const strip = ({ pk, type, _etag, ttl, _rid, _self, _attachments, _ts, ...r }: any) => r as TodoRow;

export const todoId = async (code: string, itemId: string | null, subject?: string | null) => `todo:${await hashId(`${code}:${itemId ?? subject ?? "-"}`)}`;

export function todosRepo(docs: DocStore) {
  const inScope = (t: TodoRow, s: TodoScope) => s.codes.includes(t.code) && (s.itemIds == null || (t.item_id != null && s.itemIds.includes(t.item_id)));
  return {
    /**
     * Files a run's to-dos. New ones open; open ones are refreshed; done or dismissed ones stay closed unless
     * their fingerprint changed (a different problem), and resolved ones reopen (the problem came back).
     * Open to-dos in scope that the run didn't find any more are marked resolved.
     */
    async sync(source: string, scope: TodoScope, todos: TodoInput[], now: number): Promise<{ opened: number; resolved: number }> {
      const existing = new Map((await docs.query<any>(C, { pk: PK })).map((d) => [d.id as string, strip(d)]));
      let opened = 0;
      const seen = new Set<string>();
      for (const t of todos) {
        const id = await todoId(t.code, t.itemId, t.subject);
        if (seen.has(id)) continue;
        seen.add(id);
        const ex = existing.get(id);
        const fields = { code: t.code, kind: t.kind, source, item_id: t.itemId, item_title: t.itemTitle, title: t.title, detail: t.detail, question: t.question ?? null, fingerprint: t.fingerprint, at: now };
        if (!ex) {
          await docs.upsert(C, { id, pk: PK, type: "todo", ...fields, status: "open", created_at: now, decided_at: null, decided_by: null, note: null });
          opened++;
        } else if (ex.status === "open" || ex.status === "resolved" || ex.fingerprint !== t.fingerprint) {
          if (ex.status !== "open") opened++;
          const reopen = ex.status !== "open" ? { status: "open", decided_at: null, decided_by: null, note: null } : {};
          await docs.upsert(C, { ...ex, id, pk: PK, type: "todo", ...fields, ...reopen });
        }
      }
      let resolved = 0;
      for (const t of existing.values())
        if (t.status === "open" && !seen.has(t.id) && inScope(t, scope))
          if (await docs.patch(C, t.id, PK, [{ op: "set", path: "/status", value: "resolved" }, { op: "set", path: "/decided_at", value: now }], [{ f: "status", op: "=", v: "open" }])) resolved++;
      return { opened, resolved };
    },

    /** Open to-dos for listings that are no longer live (ended or sold), except checks about ended listings. */
    async resolveForEnded(liveItemIds: string[], now: number, keepCodes: string[] = ["ended_unsold"]): Promise<number> {
      const open = await docs.query<any>(C, { pk: PK, where: [{ f: "status", op: "=", v: "open" }] });
      let n = 0;
      for (const t of open)
        if (t.item_id && !liveItemIds.includes(t.item_id) && !keepCodes.includes(t.code))
          if (await docs.patch(C, t.id, PK, [{ op: "set", path: "/status", value: "resolved" }, { op: "set", path: "/decided_at", value: now }], [{ f: "status", op: "=", v: "open" }])) n++;
      return n;
    },

    list: async (status: TodoStatus): Promise<TodoRow[]> => (await docs.query<any>(C, { pk: PK, where: [{ f: "status", op: "=", v: status }] })).map(strip),
    get: async (id: string): Promise<TodoRow | null> => {
      if (!/^todo:[\w-]{1,64}$/.test(id)) return null;
      const d = await docs.get(C, id, PK);
      return d ? strip(d) : null;
    },
    /** open -> done or dismissed, once. */
    close: (id: string, status: "done" | "dismissed", by: string, now: number, note: string | null = null) =>
      docs.patch(C, id, PK, [
        { op: "set", path: "/status", value: status },
        { op: "set", path: "/decided_at", value: now },
        { op: "set", path: "/decided_by", value: by },
        { op: "set", path: "/note", value: note },
      ], [{ f: "status", op: "=", v: "open" }]),
  };
}
