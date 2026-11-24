import type { Cond, DocStore } from "./doc";
import { EVENT, eventDoc, eventOp, seenDoc, type EventName, type ReasonCode, type SuggestionEvent } from "./events";

// Proposals (and the audit log that records what the write gate did with them). Every state change is a
// conditional write: a proposal moves out of 'pending' or 'approved' once, however many requests race.

export interface ProposalRow {
  id: string;
  kind: string;
  item_id: string | null;
  payload: string;
  reason: string | null;
  status: string;
  dry_run: number;
  created_at: number;
  expires_at: number;
  decided_at?: number | null;
  decided_by?: string | null;
  result?: string | null;
  /** Why an expired one closed (src/store/events.ts); absent on rows from before 2026-11-24. */
  closed_reason?: ReasonCode | null;
  superseded_by?: string | null;
}

const C = "proposals" as const;
export const proposalPk = (itemId: string | null | undefined) => (itemId ? String(itemId) : "none");

/** New ids carry their partition, so a lookup by id is a point read: "<item>_<uuid>". Old ids are bare UUIDs. */
export const newProposalId = (itemId: string | null) => `${proposalPk(itemId)}_${crypto.randomUUID()}`;
const pkFromId = (id: string) => (id.includes("_") ? id.slice(0, id.indexOf("_")) : null);

function row(d: any): ProposalRow {
  const { pk, type, _etag, ttl, ...r } = d;
  return { decided_at: null, decided_by: null, result: null, ...r } as ProposalRow;
}

export function proposalsRepo(docs: DocStore) {
  async function find(id: string): Promise<(ProposalRow & { pk: string }) | null> {
    if (!/^[\w-]{1,120}$/.test(id)) return null;
    const pk = pkFromId(id);
    if (pk !== null) {
      const d = await docs.get(C, id, pk);
      return d ? { ...row(d), pk } : null;
    }
    const [d] = await docs.query<any>(C, { where: [{ f: "id", op: "=", v: id }], limit: 1 });
    return d ? { ...row(d), pk: d.pk } : null;
  }

  /** Moves a proposal out of `from` once; false if it wasn't in `from` (someone else got there first). */
  async function transition(id: string, from: Cond[], set: Record<string, unknown>, ev: { event: EventName; at: number; actor?: string | null; reason_code?: ReasonCode }): Promise<boolean> {
    const p = await find(id);
    if (!p) return false;
    // The change and its event are one batch: either both are written or neither, and only one caller's is.
    const { ok } = await docs.batch(C, p.pk, [
      { op: "patch", id, ops: Object.entries(set).map(([k, v]) => ({ op: "set" as const, path: `/${k}`, value: v })), cond: [{ f: "id", op: "=", v: id }, ...from] },
      eventOp(p.pk, about(p, ev)),
    ]);
    return ok;
  }

  const about = (p: Pick<ProposalRow, "id" | "item_id" | "kind">, ev: { event: EventName; at: number; actor?: string | null; reason_code?: ReasonCode; superseded_by?: string }) => ({
    suggestion_id: p.id,
    source: "proposal" as const,
    item_id: p.item_id,
    kind: p.kind,
    ...ev,
  });

  return {
    get: async (id: string) => {
      const p = await find(id);
      if (!p) return null;
      const { pk, ...r } = p;
      return r as ProposalRow;
    },

    /**
     * Records a proposal. A superseding kind (price, revise, promote) for an item expires that item's pending
     * one of the same kind in the same transaction. A head document per item and kind serialises two
     * creators racing, so exactly one pending proposal of that kind remains.
     */
    async create(r: ProposalRow, supersede: boolean): Promise<void> {
      const pk = proposalPk(r.item_id);
      const doc = { ...r, pk, type: "proposal", decided_at: null, decided_by: null, result: null };
      if (!supersede || !r.item_id) {
        const { ok } = await docs.batch(C, pk, [{ op: "create", doc }, eventOp(pk, about(r, { event: "filed", at: r.created_at }))]);
        if (!ok) throw new Error("Proposal id clash");
        return;
      }
      for (let attempt = 0; attempt < 25; attempt++) {
        // Someone else changed this item's proposals between our read and our batch: wait a moment, retry.
        if (attempt) await new Promise((r) => setTimeout(r, Math.random() * 25 * Math.min(attempt, 8)));
        const headId = `head:${r.kind}`;
        const head = await docs.get(C, headId, pk);
        const pending = await docs.query<any>(C, {
          pk,
          where: [
            { f: "type", op: "=", v: "proposal" },
            { f: "kind", op: "=", v: r.kind },
            { f: "status", op: "=", v: "pending" },
          ],
          fields: ["id"],
        });
        const headDoc = { id: headId, pk, type: "head", kind: r.kind, last: r.id, at: r.created_at };
        const { ok } = await docs.batch(C, pk, [
          head ? { op: "replace", doc: headDoc, etag: head._etag } : { op: "create", doc: headDoc },
          ...pending.map((p) => ({
            op: "patch" as const,
            id: p.id,
            ops: [
              { op: "set" as const, path: "/status", value: "expired" },
              { op: "set" as const, path: "/decided_at", value: r.created_at },
              { op: "set" as const, path: "/closed_reason", value: "superseded" },
              { op: "set" as const, path: "/superseded_by", value: r.id },
            ],
            cond: [{ f: "status", op: "=", v: "pending" }] as Cond[],
          })),
          ...pending.map((p) => eventOp(pk, about({ ...r, id: p.id }, { event: "expired", at: r.created_at, reason_code: "superseded", superseded_by: r.id }))),
          { op: "create", doc },
          eventOp(pk, about(r, { event: "filed", at: r.created_at })),
        ]);
        if (ok) return;
      }
      throw new Error("Couldn't record the proposal: too many changes at once. Try again.");
    },

    listByStatus: async (status: string, order: "asc" | "desc", limit?: number) =>
      (
        await docs.query<any>(C, {
          where: [
            { f: "type", op: "=", v: "proposal" },
            { f: "status", op: "=", v: status },
          ],
          orderBy: ["created_at", order],
          limit,
        })
      ).map(row),

    listWhere: async (where: Cond[]) => (await docs.query<any>(C, { where: [{ f: "type", op: "=", v: "proposal" }, ...where] })).map(row),

    /** pending -> approved/rejected/agreed, once, and only before it expires (approve). */
    decide: (id: string, to: "approved" | "rejected" | "agreed", at: number, by: string | null, result?: string, notExpiredAt?: number) =>
      transition(id, [{ f: "status", op: "=", v: "pending" }, ...(notExpiredAt != null ? [{ f: "expires_at", op: ">=", v: notExpiredAt } as Cond] : [])], {
        status: to,
        decided_at: at,
        decided_by: by,
        ...(result !== undefined ? { result } : {}),
      }, { event: to, at, actor: by, reason_code: "person" }),

    /** pending -> expired, once, saying why. */
    expire: (id: string, at: number, why: ReasonCode = "lapsed") =>
      transition(id, [{ f: "status", op: "=", v: "pending" }], { status: "expired", decided_at: at, closed_reason: why }, { event: "expired", at, reason_code: why }),

    /** The write gate's claim: approved and not a dry run -> applying, at most once. */
    claimForApply: (id: string) =>
      transition(
        id,
        [
          { f: "status", op: "=", v: "approved" },
          { f: "dry_run", op: "=", v: 0 },
        ],
        { status: "applying" },
        { event: "sending", at: Date.now() },
      ),

    async setOutcome(id: string, set: { status?: "applied" | "failed"; result: string }) {
      const p = await find(id);
      if (!p) return;
      const ops = Object.entries(set).map(([k, v]) => ({ op: "set" as const, path: `/${k}`, value: v }));
      if (set.status) {
        const ev = about(p, { event: set.status, at: Date.now(), ...(set.status === "applied" && nothingSent(set.result) ? { reason_code: "nothing_to_do" as const } : {}) });
        const { ok } = await docs.batch(C, p.pk, [{ op: "patch", id, ops }, eventOp(p.pk, ev)]);
        if (ok) return;
      }
      // What eBay did must be on the label even if its event couldn't be written.
      await docs.patch(C, id, p.pk, ops);
    },

    editPayload: (id: string, payload: string, by: string | null = null) =>
      transition(id, [{ f: "status", op: "=", v: "pending" }], { payload }, { event: "edited", at: Date.now(), actor: by }),

    async expireStale(now: number) {
      const stale = await docs.query<any>(C, {
        where: [
          { f: "type", op: "=", v: "proposal" },
          { f: "status", op: "=", v: "pending" },
          { f: "expires_at", op: "<", v: now },
        ],
        fields: ["id"],
      });
      let n = 0;
      for (const s of stale) if (await transition(s.id, [{ f: "status", op: "=", v: "pending" }], { status: "expired", decided_at: now, closed_reason: "lapsed" }, { event: "expired", at: now, reason_code: "lapsed" })) n++;
      return n;
    },

    /** Scrubs a buyer's details from a proposal; a pending one is closed. */
    async scrub(id: string, payload: string, now = Date.now()) {
      const p = await find(id);
      if (!p) return false;
      const set = { payload, status: "expired", decided_at: now, closed_reason: "privacy_deletion" };
      if (p.status === "pending" && (await transition(id, [{ f: "status", op: "=", v: "pending" }], set, { event: "expired", at: now, reason_code: "privacy_deletion" }))) return true;
      return docs.patch(C, id, p.pk, [{ op: "set", path: "/payload", value: payload }]);
    },

    /** Everything that happened to one label, oldest first. */
    events: async (id: string): Promise<SuggestionEvent[]> => {
      const p = await find(id);
      if (!p) return [];
      return docs.query<any>(C, { pk: p.pk, where: [{ f: "type", op: "=", v: EVENT }, { f: "suggestion_id", op: "=", v: id }], orderBy: ["created_at", "asc"] });
    },

    /** Every closed label, without its contents: what History sorts and pages. */
    closedIndex: async (): Promise<Pick<ProposalRow, "id" | "kind" | "item_id" | "status" | "created_at" | "decided_at">[]> =>
      docs.query<any>(C, {
        where: [{ f: "type", op: "=", v: "proposal" }, { f: "status", op: "in", v: ["applied", "failed", "rejected", "expired", "agreed"] }],
        fields: ["id", "kind", "item_id", "status", "created_at", "decided_at"],
      }),

    markSeen: async (id: string, user: { id: string; name: string }, at: number) => {
      const p = await find(id);
      if (p) await docs.create(C, await seenDoc(p.pk, user.id, about(p, { event: "seen", at, actor: user.name })));
    },
    markNotified: async (id: string, at: number) => {
      const p = await find(id);
      if (p) await docs.create(C, eventDoc(p.pk, about(p, { event: "notified", at })));
    },
  };
}

// --- Audit log: every write the gate allowed, refused or saw fail. ---

export interface AuditRow {
  id: string;
  at: number;
  env: string;
  proposal_id: string | null;
  call: string;
  request: string;
  response: string | null;
  outcome: string;
  actor: string | null;
  kind: string | null;
  item_id: string | null;
}

/** Whether the gate found eBay already that way, so nothing was sent (the promotion changes say so). */
export const nothingSent = (result: string | null | undefined) => /: nothing to (end|change|lower)\.$/.test(result ?? "");

const month = (at: number) => new Date(at).toISOString().slice(0, 7);

export function auditRepo(docs: DocStore) {
  return {
    async record(e: Omit<AuditRow, "id">, id: string) {
      await docs.create("audit", { id, pk: month(e.at), type: "audit", ...e });
    },
    recent: async (limit: number) =>
      (await docs.query<any>("audit", { orderBy: ["id", "desc"], limit })).map(({ pk, type, _etag, ...r }) => r as AuditRow),
    async scrubText(text: string) {
      const hits = await docs.query<any>("audit", { where: [{ f: "request", op: "contains", v: text }] });
      const more = await docs.query<any>("audit", { where: [{ f: "response", op: "contains", v: text }] });
      const all = new Map([...hits, ...more].map((d) => [d.id, d]));
      let n = 0;
      for (const d of all.values()) {
        const ops = [
          { op: "set" as const, path: "/request", value: String(d.request ?? "").split(text).join("[deleted]") },
          { op: "set" as const, path: "/response", value: d.response == null ? null : String(d.response).split(text).join("[deleted]") },
        ];
        if (await docs.patch("audit", d.id, d.pk, ops)) n++;
      }
      return n;
    },
  };
}
