import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore, type TodoInput } from "../src/store";
import type { Env } from "../src/env";
import { handleApi } from "../src/api";
import { auditListing, settingsFindings } from "../src/firstday";
import { AUDIT_TODO_CODES, auditTodos, fileAuditTodos, fileHealthTodos, filePriceQuestions, lastSentence } from "../src/todos";

const NOW = Date.parse("2026-11-05T02:00:00Z");
const t = (code: string, itemId: string | null, fingerprint = code, extra: Partial<TodoInput> = {}): TodoInput => ({
  code,
  kind: "you",
  itemId,
  itemTitle: itemId ? `Item ${itemId}` : null,
  title: `Do ${code}`,
  detail: "",
  fingerprint,
  ...extra,
});

describe("to-do store", () => {
  it("opens new to-dos and refreshes open ones without duplicating them", async () => {
    const store = memoryStore();
    expect(await store.todos.sync("audit", { codes: ["photos"] }, [t("photos", "1"), t("photos", "1")], NOW)).toEqual({ opened: 1, resolved: 0 });
    await store.todos.sync("nightly", { codes: ["photos"] }, [t("photos", "1", "photos", { title: "Add more photos" })], NOW + 1);
    const open = await store.todos.list("open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: "Add more photos", source: "nightly", created_at: NOW, at: NOW + 1 });
  });

  it("keeps a dismissed to-do dismissed until the problem changes", async () => {
    const store = memoryStore();
    await store.todos.sync("audit", { codes: ["photos"] }, [t("photos", "1", "2 photos")], NOW);
    const [todo] = await store.todos.list("open");
    expect(await store.todos.close(todo.id, "dismissed", "K", NOW)).toBe(true);
    expect(await store.todos.close(todo.id, "done", "K", NOW)).toBe(false); // once only

    await store.todos.sync("audit", { codes: ["photos"] }, [t("photos", "1", "2 photos")], NOW + 1);
    expect(await store.todos.list("open")).toHaveLength(0);

    await store.todos.sync("audit", { codes: ["photos"] }, [t("photos", "1", "1 photo")], NOW + 2);
    expect(await store.todos.list("open")).toEqual([expect.objectContaining({ id: todo.id, decided_by: null })]);
  });

  it("resolves open to-dos a run no longer finds, only within its scope, and reopens them if they return", async () => {
    const store = memoryStore();
    await store.todos.sync("audit", { codes: ["photos", "health"] }, [t("photos", "1"), t("photos", "2"), t("health", "3")], NOW);
    // The nightly priced only item 2 and is responsible only for health.
    expect(await store.todos.sync("nightly", { codes: ["health"], itemIds: ["1", "2"] }, [], NOW + 1)).toEqual({ opened: 0, resolved: 0 });
    expect(await store.todos.sync("nightly", { codes: ["photos"], itemIds: ["2"] }, [], NOW + 1)).toEqual({ opened: 0, resolved: 1 });
    expect((await store.todos.list("open")).map((x) => x.item_id).sort()).toEqual(["1", "3"]);
    expect(await store.todos.list("resolved")).toEqual([expect.objectContaining({ item_id: "2", decided_at: NOW + 1 })]);

    expect(await store.todos.sync("audit", { codes: ["photos"] }, [t("photos", "1"), t("photos", "2")], NOW + 2)).toEqual({ opened: 1, resolved: 0 });
  });

  it("closes to-dos for listings that ended, except about ended listings", async () => {
    const store = memoryStore();
    await store.todos.sync("audit", { codes: ["photos", "ended_unsold"] }, [t("photos", "1"), t("photos", "2"), t("ended_unsold", "9")], NOW);
    expect(await store.todos.resolveForEnded(["1"], NOW)).toBe(1);
    expect((await store.todos.list("open")).map((x) => x.item_id).sort()).toEqual(["1", "9"]);
  });

  it("keeps to-dos about different policies apart", async () => {
    const store = memoryStore();
    await store.todos.sync("audit", { codes: ["policy_handling"] }, [t("policy_handling", null, "a", { subject: "A" }), t("policy_handling", null, "b", { subject: "B" })], NOW);
    expect(await store.todos.list("open")).toHaveLength(2);
  });
});

describe("audit findings as to-dos", () => {
  const weak = {
    ItemID: "222",
    Title: "Headphones",
    Description: "Good",
    PictureDetails: { PictureURL: "https://i/1" },
    ConditionID: "3000",
    ReturnPolicy: { ReturnsAcceptedOption: "ReturnsNotAccepted" },
    BestOfferDetails: { BestOfferEnabled: "false" },
    DispatchTimeMax: "2",
    ShippingDetails: { ShippingServiceOptions: { ShippingServiceCost: { "#text": "3.5" } } },
    SellingStatus: { CurrentPrice: { "#text": "20" } },
  };
  const ask = { decision: { strategy: "ask", price: null, total: null, options: [], why: "", confidence: 0, question: "Which model?" } } as any;

  it("files one Claude review per listing, each finding only K can fix, and nothing a label already covers", () => {
    const l = auditListing(weak, { pricing: ask, now: NOW });
    const todos = auditTodos({ listings: [l], findings: l.findings });
    const byCode = Object.fromEntries(todos.map((x) => [x.code, x]));

    expect(todos.filter((x) => x.kind === "claude")).toEqual([
      expect.objectContaining({ code: "claude_review", itemId: "222", title: "Let Claude improve this listing" }),
    ]);
    expect(byCode.claude_review.detail.split("\n").map((x) => x.split(":")[0])).toEqual(["Short title", "Few item specifics", "No description"]);
    expect(byCode.engine_question).toMatchObject({ kind: "answer", title: "Answer the pricing engine's question", question: "Which model?" });
    expect(byCode.photos).toMatchObject({ kind: "you", title: "Add more photos", detail: expect.stringMatching(/^1 photo now\./) });
    expect(byCode.best_offer).toMatchObject({ kind: "you", title: "Consider turning on Best Offer" });
    expect(byCode.returns).toBeUndefined(); // a policy proposal is filed for it
    expect(todos.every((x) => AUDIT_TODO_CODES.includes(x.code) || x.kind === "you")).toBe(true);
  });

  it("names the policy in a policy to-do", () => {
    const f = settingsFindings({ returns: [], postage: [{ id: "p", name: "Royal Mail 2nd", handlingDays: 5, services: [{ service: "x", cost: 1, free: false }], collection: false }], payment: [] } as any, null);
    expect(auditTodos({ listings: [], findings: f })).toEqual([expect.objectContaining({ title: "Shorten the handling time in Royal Mail 2nd", subject: expect.any(String) })]);
  });

  it("files them in the store and a rerun leaves fixed ones resolved", async () => {
    const env = { store: memoryStore() } as Env;
    const l = auditListing(weak, { pricing: ask, now: NOW });
    await fileAuditTodos(env, { listings: [l], findings: l.findings }, NOW);
    const first = (await env.store.todos.list("open")).length;
    const fixed = auditListing({ ...weak, BestOfferDetails: { BestOfferEnabled: "true" } }, { pricing: ask, now: NOW });
    await fileAuditTodos(env, { listings: [fixed], findings: fixed.findings }, NOW + 1);
    expect(await env.store.todos.list("open")).toHaveLength(first - 1);
    expect(await env.store.todos.list("resolved")).toEqual([expect.objectContaining({ code: "best_offer" })]);
  });
});

describe("nightly to-dos", () => {
  it("files the engine's questions for the listings it priced", async () => {
    const env = { store: memoryStore() } as Env;
    await filePriceQuestions(env, ["1", "2"], [{ itemId: "1", title: "Lamp", question: "Which brand?" }], NOW);
    expect(await env.store.todos.list("open")).toEqual([expect.objectContaining({ code: "engine_question", item_id: "1", item_title: "Lamp", question: "Which brand?", source: "nightly" })]);
    // Priced again with an answer: no question, so it resolves. Item 3 wasn't priced, so its question would stay.
    await filePriceQuestions(env, ["1"], [], NOW + 1);
    expect(await env.store.todos.list("open")).toHaveLength(0);
  });

  it("files flagged listings without a label, with Claude's note, and closes those that ended", async () => {
    const env = { store: memoryStore() } as Env;
    const live = [{ itemId: "1", title: "Lamp" }, { itemId: "2", title: "Mug" }];
    const flagged = [
      { itemId: "1", flags: [{ flag: "stale", detail: "Listed 112 days with no watchers." }] },
      { itemId: "2", flags: [{ flag: "low_views", detail: "Only 1 view." }] },
    ] as any;
    await fileHealthTodos(env, live, flagged, new Map([["1", "A clearer title should help."]]), (id) => id === "2", NOW);
    expect(await env.store.todos.list("open")).toEqual([
      expect.objectContaining({ item_id: "1", title: "Freshen this listing", detail: "Listed 112 days with no watchers.\nClaude: A clearer title should help." }),
    ]);
    const r = await fileHealthTodos(env, [{ itemId: "2", title: "Mug" }], [], new Map(), () => false, NOW + 1);
    expect(r.resolved).toBe(1);
  });

  it("takes Claude's closing sentence", () => {
    expect(lastSentence("Checked the price.\n\nNo change needed; the photos could show the label.")).toBe("No change needed; the photos could show the label.");
  });
});

describe("to-do API", () => {
  let env: Env;
  let cookie: string;
  const call = (path: string, body?: unknown) => {
    const url = new URL(`https://test.example/api${path}`);
    return handleApi(env, new Request(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "X-EbayManager": "1", Cookie: cookie } }), url);
  };

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<x/>")));
    env = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", SIGNING_KEY: "k", DASHBOARD_KEY: "dash-key", ALLOW_KEY_LOGIN: "true", PUBLIC_URL: "https://test.example" } as Env;
    cookie = "";
    const res = await call("/login", { key: "dash-key" });
    cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists open to-dos, answers first, and dismisses one once", async () => {
    await env.store.todos.sync("audit", { codes: ["photos", "measurements"] }, [t("photos", "1"), t("measurements", "1", "m", { kind: "answer", question: "Size?" })], NOW);
    const list = (await (await call("/todos")).json()) as any[];
    expect(list.map((x) => x.code)).toEqual(["measurements", "photos"]);
    expect((await call(`/todos/${list[1].id}/dismiss`, {})).status).toBe(200);
    expect((await call(`/todos/${list[1].id}/done`, {})).status).toBe(409);
    expect(((await (await call("/todos?status=dismissed")).json()) as any[])[0]).toMatchObject({ code: "photos", decided_by: "Sandbox test key" });
  });

  it("saves an answer as K's facts, keeping the floor and earlier facts", async () => {
    await env.store.listings.setFloorAndNotes("1", 55, "Width 110 cm");
    await env.store.todos.sync("audit", { codes: ["measurements"] }, [t("measurements", "1", "m", { kind: "answer", question: "Size?" })], NOW);
    const [todo] = await env.store.todos.list("open");
    expect((await call(`/todos/${todo.id}/answer`, { text: "  " })).status).toBe(400);
    const res = (await (await call(`/todos/${todo.id}/answer`, { text: "Height 44 cm" })).json()) as any;
    expect(res.note).toMatch(/Saved/);
    expect(await env.store.listings.getSettings("1")).toMatchObject({ floor_price: 55, notes: "Width 110 cm\nHeight 44 cm" });
    expect((await env.store.todos.get(todo.id))!.status).toBe("done");
  });

  it("refuses an answer on a to-do that doesn't take one, and unknown ids", async () => {
    await env.store.todos.sync("audit", { codes: ["photos"] }, [t("photos", "1")], NOW);
    const [todo] = await env.store.todos.list("open");
    expect((await call(`/todos/${todo.id}/answer`, { text: "x" })).status).toBe(400);
    expect((await call(`/todos/${todo.id}/claude`, {})).status).toBe(400);
    expect((await call(`/todos/todo:nope/done`, {})).status).toBe(404);
    expect((await call(`/todos/../done`, {})).status).toBe(404);
  });
});
