import type { Cond, DocStore } from "./doc";

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
  async function transition(id: string, from: Cond[], set: Record<string, unknown>): Promise<boolean> {
    const p = await find(id);
    if (!p) return false;
    return docs.patch(
      C,
      id,
      p.pk,
      Object.entries(set).map(([k, v]) => ({ op: "set" as const, path: `/${k}`, value: v })),
      [{ f: "id", op: "=", v: id }, ...from],
    );
  }

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
        if (!(await docs.create(C, doc))) throw new Error("Proposal id clash");
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
            ],
            cond: [{ f: "status", op: "=", v: "pending" }] as Cond[],
          })),
          { op: "create", doc },
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
      }),

    expire: (id: string, at: number) => transition(id, [{ f: "status", op: "=", v: "pending" }], { status: "expired", decided_at: at }),

    /** The write gate's claim: approved and not a dry run -> applying, at most once. */
    claimForApply: (id: string) =>
      transition(
        id,
        [
          { f: "status", op: "=", v: "approved" },
          { f: "dry_run", op: "=", v: 0 },
        ],
        { status: "applying" },
      ),

    async setOutcome(id: string, set: { status?: "applied" | "failed"; result: string }) {
      const p = await find(id);
      if (p) await docs.patch(C, id, p.pk, Object.entries(set).map(([k, v]) => ({ op: "set" as const, path: `/${k}`, value: v })));
    },

    editPayload: (id: string, payload: string) => transition(id, [{ f: "status", op: "=", v: "pending" }], { payload }),

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
      for (const s of stale) if (await transition(s.id, [{ f: "status", op: "=", v: "pending" }], { status: "expired", decided_at: now })) n++;
      return n;
    },

    /** Scrubs a buyer's details from a proposal; a pending one is closed. */
    async scrub(id: string, payload: string) {
      const p = await find(id);
      if (!p) return false;
      const ops = [{ op: "set" as const, path: "/payload", value: payload }];
      if (p.status === "pending") ops.push({ op: "set", path: "/status", value: "expired" });
      return docs.patch(C, id, p.pk, ops);
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
