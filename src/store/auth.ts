import { seqId, type DocStore } from "./doc";

// Sign-in state. The people themselves aren't stored here: they come from K's PEOPLE list (src/auth/people.ts).
// The "auth" partition keeps, per person, the last authenticator time step used (so a code works once).
// Sessions, eBay sign-in challenges and failed attempts are short-lived and expire by TTL ("ephemeral").
// Documents from the old passkey sign-in (people, passkeys, recovery codes, invites) are no longer read.

const A = "auth" as const;
const PK = "auth";
const E = "ephemeral" as const;

export interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  /** How long the session may sit unused. Missing on sessions from before 2026-11-07: 12 hours. */
  idle_ms?: number;
  user_agent: string | null;
  revoked: number;
}

const DEFAULT_IDLE_MS = 12 * 3_600_000;

/** Seconds a session document lives: until it can no longer be used (hard expiry or idle), plus a margin. */
const sessionTtl = (s: { expires_at: number; last_seen_at: number; idle_ms?: number }, now: number) =>
  Math.max(60, Math.ceil((Math.min(s.expires_at, s.last_seen_at + (s.idle_ms ?? DEFAULT_IDLE_MS)) - now) / 1000) + 300);

export function authRepo(docs: DocStore) {
  return {
    // --- Authenticator codes: each time step once per person ---

    /**
     * Records that a person used the code for this time step. False if that step or a later one was already
     * used, so a code can't be replayed (one of any number of simultaneous attempts wins).
     */
    async claimTotpStep(userId: string, step: number): Promise<boolean> {
      const id = `totp:${userId}`;
      const cur = await docs.get<any>(A, id, PK);
      if (!cur) return docs.create(A, { id, pk: PK, type: "totp", user_id: userId, last_step: step });
      return docs.patch(A, id, PK, [{ op: "set", path: "/last_step", value: step }], [{ f: "last_step", op: "<", v: step }]);
    },

    // --- eBay sign-in challenges (single use, 10 minutes) ---

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

    async createSession(s: SessionRow) {
      await docs.create(E, { id: s.id_hash, pk: s.id_hash, type: "session", ...s, ttl: sessionTtl(s, s.created_at) });
    },
    async getSession(idHash: string): Promise<SessionRow | null> {
      const s = await docs.get<any>(E, idHash, idHash);
      if (!s || s.type !== "session") return null;
      const { id, pk, type, _etag, ttl, ...session } = s;
      return session as SessionRow;
    },
    async touchSession(idHash: string, s: { expires_at: number; idle_ms?: number }, now: number) {
      await docs.patch(E, idHash, idHash, [
        { op: "set", path: "/last_seen_at", value: now },
        { op: "set", path: "/ttl", value: sessionTtl({ expires_at: s.expires_at, last_seen_at: now, idle_ms: s.idle_ms }, now) },
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
  };
}
