// One suite, run against every DocStore implementation (memory always; the Cosmos DB emulator when
// COSMOS_EMULATOR is set). It pins the semantics the repositories rely on, and every safety claim under
// concurrency: two implementations that pass it behave the same for the app.
import { describe, expect, it } from "vitest";
import type { DocStore } from "../../src/store/doc";
import { makeStore } from "../../src/store";
import { newProposalId } from "../../src/store/proposals";

export function runConformance(name: string, make: () => Promise<DocStore>, opts: { ttl?: boolean } = {}) {
  describe(`DocStore: ${name}`, () => {
    it("creates once, reads, replaces with etags, patches with conditions, deletes", async () => {
      const d = await make();
      expect(await d.create("kv", { id: "a", pk: "a", type: "t", n: 1 })).toBe(true);
      expect(await d.create("kv", { id: "a", pk: "a", type: "t", n: 2 })).toBe(false);
      const a = (await d.get("kv", "a", "a"))!;
      expect(a.n).toBe(1);
      expect(await d.replace("kv", { ...a, n: 3 }, a._etag)).toBe(true);
      expect(await d.replace("kv", { ...a, n: 4 }, a._etag)).toBe(false); // stale etag
      expect(await d.patch("kv", "a", "a", [{ op: "set", path: "/n", value: 5 }], [{ f: "n", op: "=", v: 99 }])).toBe(false);
      expect(await d.patch("kv", "a", "a", [{ op: "set", path: "/n", value: 5 }], [{ f: "n", op: "=", v: 3 }])).toBe(true);
      expect(await d.patch("kv", "missing", "missing", [{ op: "set", path: "/n", value: 1 }])).toBe(false);
      expect((await d.get("kv", "a", "a"))!.n).toBe(5);
      expect(await d.delete("kv", "a", "a")).toBe(true);
      expect(await d.delete("kv", "a", "a")).toBe(false);
      expect(await d.get("kv", "a", "a")).toBeNull();
    });

    it("increments, creates a missing number, and refuses a path whose parent is missing", async () => {
      const d = await make();
      await d.create("orders", { id: "o", pk: "o", type: "order", items: {} });
      expect(await d.patch("orders", "o", "o", [{ op: "incr", path: "/n", value: 2 }])).toBe(true);
      expect(await d.patch("orders", "o", "o", [{ op: "incr", path: "/n", value: 3 }])).toBe(true);
      expect((await d.get("orders", "o", "o"))!.n).toBe(5);
      expect(await d.patch("orders", "o", "o", [{ op: "set", path: "/items/123", value: { q: 1 } }])).toBe(true);
      expect(await d.patch("orders", "o", "o", [{ op: "set", path: "/nope/123", value: 1 }])).toBe(false);
    });

    it("treats a missing field as null, never as equal or unequal", async () => {
      const d = await make();
      await d.create("auth", { id: "x", pk: "auth", type: "invite", used_at: null });
      await d.create("auth", { id: "y", pk: "auth", type: "invite" });
      await d.create("auth", { id: "z", pk: "auth", type: "invite", used_at: 5 });
      const ids = async (where: any) => (await d.query<any>("auth", { pk: "auth", where })).map((r) => r.id).sort();
      expect(await ids([{ f: "used_at", op: "null" }])).toEqual(["x", "y"]);
      expect(await ids([{ f: "used_at", op: "notnull" }])).toEqual(["z"]);
      expect(await ids([{ f: "used_at", op: "!=", v: 5 }])).toEqual([]);
      expect(await d.patch("auth", "y", "auth", [{ op: "set", path: "/used_at", value: 1 }], [{ f: "used_at", op: "null" }])).toBe(true);
      expect(await d.patch("auth", "y", "auth", [{ op: "set", path: "/used_at", value: 2 }], [{ f: "used_at", op: "null" }])).toBe(false);
    });

    it("orders, limits, projects, and leaves out documents without the sort field", async () => {
      const d = await make();
      for (const [id, at] of [["1", 30], ["2", 10], ["3", 20]] as const) await d.create("usage", { id, pk: "p", at });
      await d.create("usage", { id: "4", pk: "p" });
      const q = await d.query<any>("usage", { orderBy: ["at", "desc"], limit: 2, fields: ["id", "at"] });
      expect(q).toEqual([{ id: "1", at: 30 }, { id: "3", at: 20 }]);
      expect((await d.query<any>("usage", { where: [{ f: "at", op: ">=", v: 20 }] })).map((r) => r.id).sort()).toEqual(["1", "3"]);
      expect((await d.query<any>("usage", { where: [{ f: "id", op: "in", v: ["2", "4"] }] })).map((r) => r.id).sort()).toEqual(["2", "4"]);
    });

    it("applies a batch all-or-nothing, and reads inside it", async () => {
      const d = await make();
      await d.create("auth", { id: "taken", pk: "auth", type: "x" });
      const bad = await d.batch("auth", "auth", [
        { op: "create", doc: { id: "new1", pk: "auth", type: "x" } },
        { op: "create", doc: { id: "taken", pk: "auth", type: "x" } },
      ]);
      expect(bad.ok).toBe(false);
      expect(await d.get("auth", "new1", "auth")).toBeNull();
      const good = await d.batch("auth", "auth", [
        { op: "read", id: "taken" },
        { op: "delete", id: "taken" },
        { op: "create", doc: { id: "new2", pk: "auth", type: "x" } },
      ]);
      expect(good.ok).toBe(true);
      expect(good.results[0]!.id).toBe("taken");
      expect(await d.get("auth", "taken", "auth")).toBeNull();
      expect(await d.get("auth", "new2", "auth")).not.toBeNull();
    });

    if (opts.ttl !== false)
      it("lets documents with a ttl expire", async () => {
        const d = await make();
        await d.create("ephemeral", { id: "s", pk: "s", type: "session", ttl: 1 });
        await d.create("ephemeral", { id: "k", pk: "k", type: "session" });
        await new Promise((r) => setTimeout(r, 2100));
        expect(await d.get("ephemeral", "s", "s")).toBeNull();
        expect(await d.get("ephemeral", "k", "k")).not.toBeNull();
      });
  });

  describe(`Safety claims under concurrency: ${name}`, () => {
    const proposal = (id: string, over: object = {}) => ({
      id,
      kind: "price",
      item_id: "111",
      payload: "{}",
      reason: null,
      status: "pending",
      dry_run: 0,
      created_at: Date.now(),
      expires_at: Date.now() + 86_400_000,
      ...over,
    });

    it("the write gate claims an approved proposal exactly once, and never a dry run", async () => {
      const s = makeStore(await make());
      const id = newProposalId("111");
      await s.proposals.create(proposal(id), false);
      expect(await s.proposals.decide(id, "approved", Date.now(), "K", undefined, Date.now())).toBe(true);
      const claims = await Promise.all(Array.from({ length: 10 }, () => s.proposals.claimForApply(id)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await s.proposals.get(id))!.status).toBe("applying");

      const dry = newProposalId("111");
      await s.proposals.create(proposal(dry, { dry_run: 1, kind: "revise" }), false);
      await s.proposals.decide(dry, "approved", Date.now(), "K");
      expect(await s.proposals.claimForApply(dry)).toBe(false);
    });

    it("decides a proposal once, and never after it expires", async () => {
      const s = makeStore(await make());
      const id = newProposalId("222");
      await s.proposals.create(proposal(id, { item_id: "222" }), false);
      const outcomes = await Promise.all([
        s.proposals.decide(id, "approved", Date.now(), "K", undefined, Date.now()),
        s.proposals.decide(id, "rejected", Date.now(), "Sam"),
        s.proposals.decide(id, "approved", Date.now(), "Sam", undefined, Date.now()),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const old = newProposalId("222");
      await s.proposals.create(proposal(old, { item_id: "222", kind: "message", expires_at: Date.now() - 1 }), false);
      expect(await s.proposals.decide(old, "approved", Date.now(), "K", undefined, Date.now())).toBe(false);
    });

    it("leaves exactly one pending proposal of a superseding kind, however many are filed at once", async () => {
      const s = makeStore(await make());
      await Promise.all(Array.from({ length: 6 }, (_, i) => s.proposals.create(proposal(newProposalId("333"), { item_id: "333", created_at: Date.now() + i }), true)));
      const pending = (await s.proposals.listByStatus("pending", "asc")).filter((p) => p.item_id === "333");
      expect(pending).toHaveLength(1);
      expect((await s.proposals.listByStatus("expired", "asc")).filter((p) => p.item_id === "333")).toHaveLength(5);
    });

    it("uses an invite, a recovery code and a sign-in challenge once each", async () => {
      const s = makeStore(await make());
      const now = Date.now();
      await s.auth.createInvite({ token_hash: "inv1", name: "Sam", role: "manager", created_by: "k", created_at: now, expires_at: now + 3_600_000, used_at: null });
      const reg = (uid: string, cred: string) =>
        s.auth.completeRegistration({
          inviteHash: "inv1",
          now,
          newUser: { id: uid, name: "Sam", role: "manager" },
          existingUserId: null,
          credential: { id: cred, user_id: uid, alg: -7, public_key: "{}", sign_count: 0, label: "x" },
          codeHashes: [`c-${uid}`],
        });
      const regs = await Promise.all([reg("u1", "cred1"), reg("u2", "cred2"), reg("u3", "cred3")]);
      expect(regs.filter(Boolean)).toHaveLength(1);
      expect(await s.auth.countActiveUsers()).toBe(1);

      const winner = ["u1", "u2", "u3"][regs.indexOf(true)];
      const uses = await Promise.all(Array.from({ length: 5 }, () => s.auth.consumeRecoveryCode(`c-${winner}`, now)));
      expect(uses.filter((u) => u === winner)).toHaveLength(1);

      await s.auth.createChallenge({ id: "ch1", challenge: "c", purpose: "login", data: "{}", expires_at: now + 600_000 }, now);
      const takes = await Promise.all(Array.from({ length: 5 }, () => s.auth.takeChallenge("ch1")));
      expect(takes.filter(Boolean)).toHaveLength(1);
    });

    it("counts sold-data usage exactly under parallel increments", async () => {
      const s = makeStore(await make());
      await Promise.all(Array.from({ length: 10 }, () => s.solddata.addUsage("trawl", "2026-11", 1)));
      expect(await s.solddata.used("trawl", "2026-11")).toBe(10);
    });

    it("removes a person's passkeys and codes with their access, in one step", async () => {
      const s = makeStore(await make());
      const now = Date.now();
      await s.auth.createInvite({ token_hash: "inv2", name: "Alex", role: "manager", created_by: "k", created_at: now, expires_at: now + 3_600_000, used_at: null });
      await s.auth.completeRegistration({
        inviteHash: "inv2",
        now,
        newUser: { id: "ua", name: "Alex", role: "manager" },
        existingUserId: null,
        credential: { id: "credA", user_id: "ua", alg: -7, public_key: "{}", sign_count: 0, label: "x" },
        codeHashes: ["ca1", "ca2"],
      });
      await s.auth.createSession({ id_hash: "sa", user_id: "ua", created_at: now, last_seen_at: now, expires_at: now + 86_400_000, user_agent: "", must_add_passkey: 0, revoked: 0 }, 43_200_000);
      await s.auth.removePerson("ua");
      await s.auth.revokeAllSessions("ua");
      expect(await s.auth.getCredentialWithUser("credA")).toBeNull();
      expect(await s.auth.consumeRecoveryCode("ca1", now)).toBeNull();
      expect((await s.auth.getUser("ua"))!.disabled).toBe(1);
      expect((await s.auth.getSessionWithUser("sa"))!.session.revoked).toBe(1);
    });
  });
}
