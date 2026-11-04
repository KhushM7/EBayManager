import { hashId, seqId, type BatchOp, type DocStore } from "./doc";

// People, passkeys, recovery codes and invites live in one partition ("auth"; at most three people), so every
// change that touches several of them is one all-or-nothing batch. Sessions, sign-in challenges and failed
// attempts are short-lived and expire by TTL.

const A = "auth" as const;
const PK = "auth";
const E = "ephemeral" as const;

export interface UserRow {
  id: string;
  name: string;
  role: string;
  created_at: number;
  disabled: number;
  is_test: number;
}
export interface CredentialRow {
  id: string;
  user_id: string;
  alg: number;
  public_key: string;
  sign_count: number;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
}
export interface InviteRow {
  token_hash: string;
  name: string;
  role: string;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  /** Set by the Azure migration: completing this invite adds a passkey to an existing person. */
  reenrol_user_id?: string | null;
}
export interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
  must_add_passkey: number;
  revoked: number;
}

const userId = (id: string) => `user:${id}`;
const credId = async (id: string) => `cred:${await hashId(id)}`;
const unused = { f: "used_at", op: "null" } as const;

const user = ({ id, pk, type, _etag, user_id, ...r }: any): UserRow => ({ id: user_id, ...r });
const cred = ({ id, pk, type, _etag, cred_id, ...r }: any): CredentialRow => ({ id: cred_id, last_used_at: null, label: null, ...r });

async function credDoc(c: Omit<CredentialRow, "created_at" | "last_used_at">, now: number) {
  return {
    id: await credId(c.id),
    pk: PK,
    type: "credential",
    cred_id: c.id,
    user_id: c.user_id,
    alg: c.alg,
    public_key: c.public_key,
    sign_count: c.sign_count,
    label: c.label,
    created_at: now,
    last_used_at: null,
  };
}

/** Seconds a session document lives: until it can no longer be used (hard expiry or 12 h idle), plus a margin. */
const sessionTtl = (s: { expires_at: number; last_seen_at: number }, now: number, idleMs: number) =>
  Math.max(60, Math.ceil((Math.min(s.expires_at, s.last_seen_at + idleMs) - now) / 1000) + 300);

export function authRepo(docs: DocStore) {
  const users = () => docs.query<any>(A, { pk: PK, where: [{ f: "type", op: "=", v: "user" }] });

  const codeOps = async (forUser: string, codeHashes: string[]): Promise<BatchOp[]> => {
    const old = await docs.query<any>(A, {
      pk: PK,
      where: [
        { f: "type", op: "=", v: "recovery" },
        { f: "user_id", op: "=", v: forUser },
      ],
      fields: ["id"],
    });
    return [
      ...old.map((o): BatchOp => ({ op: "delete", id: o.id })),
      ...codeHashes.map((h): BatchOp => ({ op: "create", doc: { id: `rc:${h}`, pk: PK, type: "recovery", code_hash: h, user_id: forUser, used_at: null } })),
    ];
  };

  return {
    async countActiveUsers() {
      return (await users()).filter((u) => !u.disabled && !u.is_test).length;
    },
    async countOpenInvites(now: number) {
      return (await docs.query<any>(A, { pk: PK, where: [{ f: "type", op: "=", v: "invite" }, unused, { f: "expires_at", op: ">", v: now }] })).length;
    },
    async createInvite(inv: InviteRow) {
      await docs.create(A, { id: `inv:${inv.token_hash}`, pk: PK, type: "invite", ...inv });
    },
    getInvite: async (tokenHash: string): Promise<InviteRow | null> => {
      const d = await docs.get<any>(A, `inv:${tokenHash}`, PK);
      if (!d) return null;
      const { id, pk, type, _etag, ...r } = d;
      return r as InviteRow;
    },
    getUser: async (id: string) => {
      const d = await docs.get(A, userId(id), PK);
      return d ? user(d) : null;
    },
    async isActiveOwner(id: string) {
      const u = await docs.get<any>(A, userId(id), PK);
      return Boolean(u && u.role === "owner" && !u.disabled);
    },
    /** Sandbox key login: creates the test owner once. */
    async ensureTestUser(id: string, now: number) {
      await docs.create(A, { id: userId(id), pk: PK, type: "user", user_id: id, name: "Sandbox test key", role: "owner", created_at: now, disabled: 0, is_test: 1 });
    },
    async listCredentialIds(forUser: string) {
      return (
        await docs.query<any>(A, {
          pk: PK,
          where: [
            { f: "type", op: "=", v: "credential" },
            { f: "user_id", op: "=", v: forUser },
          ],
        })
      ).map((d) => String(d.cred_id));
    },
    async getCredentialWithUser(id: string): Promise<{ cred: CredentialRow; user: UserRow } | null> {
      const c = await docs.get<any>(A, await credId(id), PK);
      if (!c) return null;
      const u = await docs.get<any>(A, userId(c.user_id), PK);
      return u ? { cred: cred(c), user: user(u) } : null;
    },
    async updateCredentialUse(id: string, signCount: number, at: number) {
      await docs.patch(A, await credId(id), PK, [
        { op: "set", path: "/sign_count", value: signCount },
        { op: "set", path: "/last_used_at", value: at },
      ]);
    },
    async deleteCredential(id: string) {
      return docs.delete(A, await credId(id), PK);
    },

    /**
     * Completes an invite in one transaction: marks it used (only if unused and unexpired), creates the person
     * (or, for a re-enrolment invite, keeps the existing one), stores the passkey and replaces the recovery
     * codes. If the invite was used in the meantime, nothing is written.
     */
    async completeRegistration(a: {
      inviteHash: string;
      now: number;
      newUser: { id: string; name: string; role: string } | null;
      existingUserId: string | null;
      credential: Omit<CredentialRow, "created_at" | "last_used_at">;
      codeHashes: string[];
    }): Promise<boolean> {
      const forUser = a.existingUserId ?? a.newUser!.id;
      const ops: BatchOp[] = [
        {
          op: "patch",
          id: `inv:${a.inviteHash}`,
          ops: [{ op: "set", path: "/used_at", value: a.now }],
          cond: [unused, { f: "expires_at", op: ">", v: a.now }],
        },
        a.existingUserId
          ? { op: "patch", id: userId(a.existingUserId), ops: [{ op: "set", path: "/disabled", value: 0 }], cond: [{ f: "is_test", op: "=", v: 0 }] }
          : {
              op: "create",
              doc: { id: userId(a.newUser!.id), pk: PK, type: "user", user_id: a.newUser!.id, name: a.newUser!.name, role: a.newUser!.role, created_at: a.now, disabled: 0, is_test: 0 },
            },
        { op: "create", doc: await credDoc(a.credential, a.now) },
        ...(await codeOps(forUser, a.codeHashes)),
      ];
      return (await docs.batch(A, PK, ops)).ok;
    },

    /** Another passkey for a signed-in person, with a fresh set of recovery codes, in one transaction. */
    async addCredentialWithCodes(forUser: string, credential: Omit<CredentialRow, "created_at" | "last_used_at">, codeHashes: string[], now: number) {
      const ops: BatchOp[] = [{ op: "create", doc: await credDoc(credential, now) }, ...(await codeOps(forUser, codeHashes))];
      if (!(await docs.batch(A, PK, ops)).ok) throw new Error("This passkey is already registered");
    },

    /** Uses a recovery code once: only one of any number of simultaneous attempts gets the user id back. */
    async consumeRecoveryCode(codeHash: string, now: number): Promise<string | null> {
      const rc = await docs.get<any>(A, `rc:${codeHash}`, PK);
      if (!rc || rc.used_at) return null;
      const { ok, results } = await docs.batch(A, PK, [
        { op: "patch", id: rc.id, ops: [{ op: "set", path: "/used_at", value: now }], cond: [unused] },
        { op: "read", id: userId(rc.user_id) },
      ]);
      if (!ok || !results[1] || results[1].disabled) return null;
      return String(rc.user_id);
    },

    async listPeople(now: number) {
      const all = await docs.query<any>(A, { pk: PK });
      const people = all
        .filter((d) => d.type === "user" && !d.disabled && !d.is_test)
        .sort((a, b) => a.created_at - b.created_at)
        .map((u) => ({ id: u.user_id, name: u.name, role: u.role, created_at: u.created_at }));
      const creds = all
        .filter((d) => d.type === "credential")
        .sort((a, b) => a.created_at - b.created_at)
        .map((c) => ({ id: c.cred_id, user_id: c.user_id, label: c.label ?? null, created_at: c.created_at, last_used_at: c.last_used_at ?? null }));
      const invites = all
        .filter((d) => d.type === "invite" && !d.used_at && d.expires_at > now)
        .sort((a, b) => a.created_at - b.created_at)
        .map((i) => ({ name: i.name, role: i.role, expires_at: i.expires_at }));
      return { people, creds, invites };
    },

    /** Disables a person and deletes their passkeys and recovery codes in one transaction. */
    async removePerson(id: string) {
      const theirs = await docs.query<any>(A, { pk: PK, where: [{ f: "user_id", op: "=", v: id }], fields: ["id", "type"] });
      const ops: BatchOp[] = [
        { op: "patch", id: userId(id), ops: [{ op: "set", path: "/disabled", value: 1 }] },
        ...theirs.filter((d) => d.type === "credential" || d.type === "recovery").map((d): BatchOp => ({ op: "delete", id: d.id })),
      ];
      if (!(await docs.batch(A, PK, ops)).ok) throw new Error("Couldn't remove this person. Try again.");
    },

    // --- Sign-in challenges (single use, 10 minutes) ---

    async createChallenge(c: { id: string; challenge: string; purpose: string; data: string; expires_at: number }, now: number) {
      await docs.create(E, { pk: c.id, type: "challenge", ...c, ttl: Math.ceil((c.expires_at - now) / 1000) + 60 });
    },
    /** Reads and deletes a challenge in one step: only one caller ever gets it. */
    async takeChallenge(id: string): Promise<{ challenge: string; purpose: string; data: string; expires_at: number } | null> {
      if (!/^[\w-]{1,64}$/.test(id)) return null;
      const { ok, results } = await docs.batch(E, id, [
        { op: "read", id },
        { op: "delete", id },
      ]);
      if (!ok || !results[0] || results[0].type !== "challenge") return null;
      const r = results[0];
      return { challenge: r.challenge, purpose: r.purpose, data: r.data, expires_at: r.expires_at };
    },

    // --- Failed sign-in attempts (kept 24 hours) ---

    async countAttempts(key: string, since: number) {
      return (
        await docs.query<any>(E, {
          pk: key,
          where: [
            { f: "type", op: "=", v: "attempt" },
            { f: "at", op: ">", v: since },
          ],
          fields: ["id"],
        })
      ).length;
    },
    async recordAttempt(key: string, at: number) {
      await docs.create(E, { id: seqId(at), pk: key, type: "attempt", key, at, ttl: 86_400 });
    },

    // --- Sessions ---

    async createSession(s: SessionRow, idleMs: number) {
      await docs.create(E, { id: s.id_hash, pk: s.id_hash, type: "session", ...s, ttl: sessionTtl(s, s.created_at, idleMs) });
    },
    async getSessionWithUser(idHash: string): Promise<{ session: SessionRow; user: UserRow } | null> {
      const s = await docs.get<any>(E, idHash, idHash);
      if (!s || s.type !== "session") return null;
      const u = await docs.get<any>(A, userId(s.user_id), PK);
      if (!u) return null;
      const { id, pk, type, _etag, ttl, ...session } = s;
      return { session: session as SessionRow, user: user(u) };
    },
    async touchSession(idHash: string, s: { expires_at: number }, now: number, idleMs: number) {
      await docs.patch(E, idHash, idHash, [
        { op: "set", path: "/last_seen_at", value: now },
        { op: "set", path: "/ttl", value: sessionTtl({ expires_at: s.expires_at, last_seen_at: now }, now, idleMs) },
      ]);
    },
    async revokeSession(idHash: string) {
      await docs.patch(E, idHash, idHash, [{ op: "set", path: "/revoked", value: 1 }]);
    },
    async revokeAllSessions(forUser: string) {
      const mine = await docs.query<any>(E, {
        where: [
          { f: "type", op: "=", v: "session" },
          { f: "user_id", op: "=", v: forUser },
        ],
        fields: ["id"],
      });
      for (const s of mine) await docs.patch(E, s.id, s.id, [{ op: "set", path: "/revoked", value: 1 }]);
    },
    async clearMustAddPasskey(idHash: string) {
      await docs.patch(E, idHash, idHash, [{ op: "set", path: "/must_add_passkey", value: 0 }]);
    },
  };
}
