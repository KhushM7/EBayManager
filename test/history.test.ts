import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { decide } from "../src/proposals";
import { forgetUser } from "../src/deletion";
import { closeForEnded, handleSuggestions, markSeen, needsAttention, proposalOutcome, suggestionHistory, todoOutcome } from "../src/history";
import { memoryStore, type ProposalRow } from "../src/store";
import { newProposalId } from "../src/store/proposals";
import { seedProposal, seedSnapshot } from "./fixtures";
// @ts-ignore a plain script without types
import { planAdvice, planProposals, planTodos } from "../scripts/backfill-plan.mjs";

const DAY = 86_400_000;
const NOW = Date.now();
const ITEM = "111111111111";
let env: Env;
beforeEach(() => {
  env = { store: memoryStore(), WRITE_MODE: "approval", EBAY_ENV: "sandbox", PUBLIC_URL: "https://x" } as unknown as Env;
});
const label = (o: Partial<ProposalRow> = {}): ProposalRow => ({
  id: newProposalId(o.item_id === undefined ? ITEM : o.item_id),
  kind: "price",
  item_id: ITEM,
  payload: JSON.stringify({ oldPrice: 10, newPrice: 9 }),
  reason: "Why",
  status: "pending",
  dry_run: 0,
  created_at: NOW,
  expires_at: NOW + 7 * DAY,
  ...o,
});
const todo = (o: object = {}) => ({ code: "photos", kind: "you" as const, itemId: ITEM, itemTitle: "Thing", title: "Add photos", detail: "Two photos", fingerprint: "a", ...o });
const raw = (c: "proposals" | "pricing") => env.store.docs.query<any>(c, { where: [{ f: "type", op: "=", v: "suggestion_event" }] });

describe("label events", () => {
  it("records one decision and one event however many race", async () => {
    const p = label();
    await env.store.proposals.create(p, true);
    const won = await Promise.all(Array.from({ length: 25 }, (_, i) => env.store.proposals.decide(p.id, i % 2 ? "approved" : "rejected", NOW, "K")));
    expect(won.filter(Boolean)).toHaveLength(1);
    expect((await env.store.proposals.events(p.id)).map((e) => e.event)).toEqual(["filed", expect.stringMatching(/approved|rejected/)]);
  });

  it("a refused decision writes no event", async () => {
    const p = label({ expires_at: NOW - 1 });
    await env.store.proposals.create(p, false);
    expect(await env.store.proposals.decide(p.id, "approved", NOW, "K", undefined, NOW)).toBe(false);
    expect((await raw("proposals")).map((e) => e.event)).toEqual(["filed"]);
  });

  it("says why each one closed: replaced, ran out, buyer gone", async () => {
    const a = label();
    const b = label({ created_at: NOW + 1 });
    await env.store.proposals.create(a, true);
    await env.store.proposals.create(b, true);
    expect(await env.store.proposals.get(a.id)).toMatchObject({ status: "expired", closed_reason: "superseded", superseded_by: b.id });
    const late = label({ kind: "revise", expires_at: NOW - 1 });
    await env.store.proposals.create(late, false);
    expect(await decide(env, late.id, "approve", "K")).toBe("Expired");
    expect((await env.store.proposals.get(late.id))!.closed_reason).toBe("lapsed");
    const stale = label({ kind: "end_listing", expires_at: NOW - 1 });
    await env.store.proposals.create(stale, false);
    await env.store.proposals.expireStale(NOW);
    expect((await env.store.proposals.get(stale.id))!.closed_reason).toBe("lapsed");
    const msg = label({ kind: "message", payload: JSON.stringify({ recipientId: "someone_1", body: "hello" }) });
    await env.store.proposals.create(msg, false);
    await forgetUser(env, "someone_1");
    expect(await env.store.proposals.get(msg.id)).toMatchObject({ status: "expired", closed_reason: "privacy_deletion" });
  });

  it("keeps no text in a label's events, replies included", async () => {
    const p = label({ kind: "message", payload: JSON.stringify({ recipientId: "someone_1", body: "secret words" }) });
    await env.store.proposals.create(p, false);
    await env.store.proposals.editPayload(p.id, JSON.stringify({ recipientId: "someone_1", body: "other words" }), "K");
    await env.store.proposals.decide(p.id, "rejected", NOW, "K");
    expect(JSON.stringify(await raw("proposals"))).not.toMatch(/words|someone_1/);
    expect((await suggestionHistory(env)).rows[0]).toMatchObject({ title: "Reply to a buyer", detail: null });
  });

  it("records what eBay did with the label", async () => {
    const p = label();
    await env.store.proposals.create(p, false);
    await env.store.proposals.decide(p.id, "approved", NOW, "K");
    await env.store.proposals.claimForApply(p.id);
    await env.store.proposals.setOutcome(p.id, { status: "failed", result: "eBay said no" });
    expect((await env.store.proposals.events(p.id)).map((e) => e.event).sort()).toEqual(["approved", "failed", "filed", "sending"]);
  });
});

describe("to-do episodes", () => {
  const scope = { codes: ["photos"] };
  it("keeps every time round, with who and the note", async () => {
    const t = env.store.todos;
    await t.sync("audit", scope, [todo()], NOW);
    const [row] = await t.list("open");
    await t.sync("audit", scope, [todo()], NOW + 1);
    await t.sync("audit", scope, [], NOW + 2);
    await t.sync("audit", scope, [todo({ detail: "One photo" })], NOW + 3);
    expect(await t.get(row.id)).toMatchObject({ status: "open", episode: 2, opened_at: NOW + 3, created_at: NOW });
    expect(await t.close(row.id, "dismissed", "Sam", NOW + 4, "no thanks")).toBe(true);
    expect(await t.close(row.id, "done", "K", NOW + 5)).toBe(false);
    expect((await t.events()).map((e) => [e.event, e.episode])).toEqual([["filed", 1], ["resolved", 1], ["reopened", 2], ["dismissed", 2]]);
    const { rows } = await suggestionHistory(env);
    expect(rows.map((r) => [r.outcome.words, r.detail])).toEqual([
      ["Dismissed by Sam", "One photo\nno thanks"],
      ["No longer needed: the problem has gone", "Two photos"],
    ]);
  });

  it("never reads an event as a to-do", async () => {
    await env.store.todos.sync("audit", scope, [todo()], NOW);
    expect(await env.store.todos.list("open")).toHaveLength(1);
    expect(await env.store.todos.all()).toHaveLength(1);
    const empty = memoryStore();
    await empty.docs.create("pricing", { id: "ev:x", pk: "_todo", type: "suggestion_event" });
    expect(await empty.todos.any()).toBe(false);
  });

  it("records the closing of an old row before a reopen blanks it", async () => {
    await env.store.todos.sync("audit", scope, [todo()], NOW);
    const [d] = await env.store.docs.query<any>("pricing", { where: [{ f: "type", op: "=", v: "todo" }] });
    const { episode, opened_at, closed_reason, ...old } = d;
    await env.store.docs.upsert("pricing", { ...old, status: "dismissed", decided_by: "K", decided_at: NOW + 1 });
    await env.store.todos.sync("audit", scope, [todo({ fingerprint: "b" })], NOW + 9);
    expect((await suggestionHistory(env)).rows[0].outcome.words).toBe("Dismissed by K");
  });

  it("scrubs a closed eBay account from to-dos and their events, and keeps no words of other runs", async () => {
    await env.store.todos.sync("audit", scope, [todo({ detail: "from someone_1" })], NOW);
    await env.store.todos.sync("gate", { codes: ["x"] }, [todo({ code: "x", detail: "reply to someone_1" })], NOW);
    await forgetUser(env, "someone_1");
    expect(JSON.stringify(await env.store.docs.query("pricing", {}))).not.toContain("someone_1");
    expect((await raw("pricing")).find((e) => e.kind === "x").snapshot).toBeNull();
  });
});

describe("sold and ended listings", () => {
  it("closes labels and to-dos with the reason, and leaves new listings and replies alone", async () => {
    const [sold, ended, fresh] = ["111111111111", "222222222222", "333333333333"];
    await seedSnapshot(env.store, NOW - DAY, [{ item_id: sold, price: 5 }, { item_id: ended, price: 5 }]);
    await seedSnapshot(env.store, NOW, [{ item_id: "444444444444", price: 5 }]);
    await env.store.orders.upsertFromApi([{ orderId: "o1", createdAt: NOW, total: 5, fees: 0, currency: "GBP", status: "PAID", items: [{ itemId: sold, title: "x", quantity: 1, price: 5 }] }]);
    const ps = [label({ item_id: sold }), label({ item_id: ended }), label({ item_id: fresh }), label({ item_id: sold, kind: "message" })];
    for (const p of ps) await env.store.proposals.create(p, false);
    await env.store.todos.sync("audit", { codes: ["photos"] }, [todo({ itemId: sold }), todo({ itemId: ended })], NOW);
    await closeForEnded(env, NOW);
    expect(await Promise.all(ps.map(async (p) => (await env.store.proposals.get(p.id))!.closed_reason ?? null))).toEqual(["listing_sold", "listing_ended", null, null]);
    expect((await env.store.todos.all()).map((t) => t.closed_reason).sort()).toEqual(["listing_ended", "listing_sold"]);
  });
});

describe("the Inbox split", () => {
  it("puts every status of every kind in exactly one of To decide and History", () => {
    for (const status of ["pending", "approved", "applying", "applied", "failed", "rejected", "expired", "agreed"]) {
      const o = proposalOutcome({ status, decided_by: "K", result: null, created_at: NOW, decided_at: NOW, expires_at: NOW + DAY });
      expect([status, o === null]).toEqual([status, ["pending", "approved", "applying"].includes(status)]);
    }
    for (const status of ["open", "done", "dismissed", "resolved"]) expect(todoOutcome(status, "K", null) === null).toBe(status === "open");
    expect(proposalOutcome({ status: "expired", decided_by: null, result: null, created_at: NOW - DAY, decided_at: NOW, expires_at: NOW + DAY })!.words).toBe("Closed, reason not recorded");
    expect(proposalOutcome({ status: "applied", decided_by: "K", result: "The listing isn't promoted any more: nothing to end.", created_at: 0, decided_at: 0, expires_at: 0 })!.words).toContain("nothing sent");
  });

  it("pins held, sending and refused labels until something newer speaks for them", async () => {
    const base = { item_id: ITEM, created_at: NOW - 2 * DAY, expires_at: NOW + DAY };
    await seedProposal(env.store, { ...base, id: `${ITEM}_a`, kind: "price", status: "approved" });
    await seedProposal(env.store, { ...base, id: `${ITEM}_b`, kind: "revise", status: "applying" });
    await seedProposal(env.store, { ...base, id: `${ITEM}_c`, kind: "promote", status: "failed" });
    await seedProposal(env.store, { ...base, id: `${ITEM}_old`, kind: "relist", status: "failed", created_at: NOW - 30 * DAY });
    expect((await needsAttention(env, NOW)).map((p) => p.id).sort()).toEqual([`${ITEM}_a`, `${ITEM}_b`, `${ITEM}_c`]);
    await seedProposal(env.store, { ...base, id: `${ITEM}_d`, kind: "promote", status: "applied", created_at: NOW - DAY });
    expect((await needsAttention(env, NOW)).map((p) => p.id)).not.toContain(`${ITEM}_c`);
  });
});

describe("History", () => {
  it("pages past 200 without gaps or repeats, even when times tie", async () => {
    for (let i = 0; i < 230; i++)
      await seedProposal(env.store, { id: `${ITEM}_${i}`, kind: "price", item_id: ITEM, status: i % 2 ? "rejected" : "applied", created_at: NOW - Math.floor(i / 7), expires_at: NOW, payload: JSON.stringify({ newPrice: 1 }) });
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof suggestionHistory>> = await suggestionHistory(env, { before });
      seen.push(...page.rows.map((r) => r.id));
      before = page.next;
    } while (before);
    expect(seen).toHaveLength(230);
    expect(new Set(seen).size).toBe(230);
    expect((await suggestionHistory(env, { outcome: "declined", limit: 5 })).rows.every((r) => r.outcome.group === "declined")).toBe(true);
  });

  it("keeps old bundle advice, and who dismissed it", async () => {
    await env.store.pricing.replaceBundleAdvice(NOW, [
      { kind: "combine", itemIds: ["1", "2"], detail: JSON.stringify({ title: "Games", reason: "r" }) },
      { kind: "combine", itemIds: ["3", "4"], detail: "{}" },
    ]);
    const [a] = await env.store.pricing.openAdvice();
    expect(await env.store.pricing.dismissAdvice(a.id, "K", NOW + 1)).toBe(true);
    expect(await env.store.pricing.retireAdvice(NOW + 2)).toBe(1);
    expect(await env.store.pricing.lastBundleAt()).toBe(NOW);
    expect((await suggestionHistory(env, { source: "advice" })).rows.map((r) => r.outcome.words)).toEqual(["Replaced by a newer suggestion", "Dismissed by K"]);
  });

  it("records seen once per person", async () => {
    const p = label();
    await env.store.proposals.create(p, false);
    for (const id of ["k", "k", "s"]) await markSeen(env, [p.id, "nonsense!", 3], { id, name: id });
    expect((await env.store.proposals.events(p.id)).filter((e) => e.event === "seen")).toHaveLength(2);
    expect(await handleSuggestions(env, "/suggestions/nope", "GET", new URL("https://x/"), async () => ({}), { id: "k", name: "K" })).toBeNull();
  });
});

describe("backfill", () => {
  it("records what is known, says unknown otherwise, and adds nothing the second time", () => {
    const pk = ITEM;
    const rows = [
      { id: "a", pk, item_id: pk, kind: "price", status: "expired", created_at: 1, decided_at: 5, expires_at: 100 },
      { id: "b", pk, item_id: pk, kind: "price", status: "applied", created_at: 5, decided_at: 6, expires_at: 100, decided_by: "K", result: "ok" },
      { id: "c", pk, item_id: pk, kind: "revise", status: "expired", created_at: 1, decided_at: 50, expires_at: 100 },
      { id: "d", pk, item_id: pk, kind: "revise", status: "expired", created_at: 1, decided_at: 101, expires_at: 100 },
    ];
    const p = planProposals(rows);
    const why = (id: string) => p.events.find((e: any) => e.suggestion_id === id && e.event === "expired");
    expect([why("a").reason_code, why("a").superseded_by, why("c").reason_code, why("d").reason_code]).toEqual(["superseded", "b", "unknown", "lapsed"]);
    expect(p.events.every((e: any) => e.backfilled)).toBe(true);
    const known = new Set(p.events.map((e: any) => `${e.suggestion_id}:${e.event}`));
    expect(planProposals(rows, known).events).toEqual([]);
    expect(new Set(p.events.map((e: any) => e.id)).size).toBe(p.events.length);
    const t = planTodos([{ id: "todo:1", pk: "_todo", code: "health", source: "nightly", status: "resolved", created_at: 1, at: 2, decided_at: 2, title: "t", detail: "d" }]);
    expect(t.events.map((e: any) => [e.event, e.reason_code])).toEqual([["filed", null], ["resolved", "unknown"]]);
    const a = planAdvice([
      { id: "1", pk: "_bundle", kind: "run", at: 1, status: "done" },
      { id: "2", pk: "_bundle", kind: "combine", at: 1, status: "replaced" },
      { id: "3", pk: "_bundle", kind: "run", at: 9, status: "done" },
    ]);
    expect(a.events.at(-1)).toMatchObject({ event: "replaced", at: 9 });
  });
});
