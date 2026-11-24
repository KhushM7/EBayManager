import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { acceptFound, BUNDLE_TODO, bundleTodoClosed, confirmBundle, emptyBundles, evaluate, examples, guide, handleBundles, maxPercent, mergeGroups, ordersWith, reviewBundles, ruleGroups, suggest, tiersFor, unfit, type BundleItem, type BundleState } from "../src/bundles";
import { decide, hazard, marketState, type MarketState } from "../src/pricing/model";
import { answerOffer } from "../src/pricing/offers";
import { promotionAdvice } from "../src/promotion";
import { reliableDays } from "../src/util";
import { memoryStore } from "../src/store";
import { seedSnapshot } from "./fixtures";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 24);
const item = (itemId: string, title: string, over: Partial<BundleItem> = {}): BundleItem => ({ itemId, title, price: 20, quantity: 1, watchers: 0, listedDays: 10, collectionOnly: false, group: null, condition: "used", floor: null, sensible: 10, ...over });
const map = (xs: BundleItem[]) => new Map(xs.map((i) => [i.itemId, i]));
const games = [item("1001", "Scrabble board game"), item("1002", "Wooden chess set"), item("1003", "Air hockey table game")];
const mic = item("2001", "USB microphone kit");
const stand = item("2002", "TV stand");

describe("which listings belong together", () => {
  it("drops pairs Claude itself calls unrelated, in its verdict or its words", () => {
    const f = { reason: "Both are games.", relation: "same_set_or_hobby", sameBuyer: true, name: "Games", itemIds: ["1001", "1002"] };
    const all = [...games, mic, stand];
    expect(acceptFound([f], all, NOW)).toHaveLength(1);
    expect(acceptFound([{ ...f, relation: "unrelated" }], all, NOW)).toHaveLength(0);
    expect(acceptFound([{ ...f, sameBuyer: false }], all, NOW)).toHaveLength(0);
    expect(acceptFound([{ ...f, itemIds: ["2001", "2002"], reason: "These are unrelated, so no combine is suggested here." }], all, NOW)).toHaveLength(0);
    expect(acceptFound([{ ...f, itemIds: ["1001", "gone"] }], all, NOW)).toHaveLength(0);
  });

  it("rules group the games and never the microphone with the stand", () => {
    const g = ruleGroups([...games, mic, stand], NOW);
    expect(g).toHaveLength(1);
    expect(g[0].itemIds).toEqual(["1001", "1002", "1003"]);
  });

  it("leaves out spares or repair, sold out, and collection-only among posted", () => {
    expect(unfit(item("1", "Vacuum spares or repair"))).toBe("spares or repair");
    expect(unfit(item("1", "Vacuum", { condition: "parts" }))).toBe("spares or repair");
    expect(unfit(item("1", "x", { quantity: 0 }))).toBe("none left");
    const g = { id: "g", name: "g", itemIds: ["1001", "1002", "9"], source: "k" as const, reason: "", at: 0 };
    const e = evaluate(g, map([games[0], games[1], item("9", "Big game", { collectionOnly: true })]));
    expect(e.items.map((i) => i.itemId)).toEqual(["1001", "1002"]);
    expect(e.leftOut[0].why).toMatch(/collection only/);
  });

  it("remembers a dismissal, including groups around it", () => {
    const s = { ...emptyBundles(), dismissed: [{ itemIds: ["1001", "1002"], at: NOW - 30 * DAY }] };
    expect(mergeGroups(s, null, ruleGroups(games, NOW), NOW)).toHaveLength(0);
  });
});

describe("percentages", () => {
  it("keep what K gets at or above the floor, and the price sensible", () => {
    const i = item("1", "x", { price: 20, floor: 16, sensible: 1 });
    const p = maxPercent(i);
    expect(20 * (1 - p / 100)).toBeGreaterThanOrEqual(16);
    expect(20 * (1 - (p + 5) / 100)).toBeLessThan(16);
    expect(maxPercent(item("1", "x", { price: 20, sensible: 18 }))).toBe(10);
    expect(unfit(item("1", "x", { floor: 20 }))).toMatch(/no room/);
  });

  it("are modest, never fall as more are bought, cap at the tightest item and fit the group's size", () => {
    expect(tiersFor(games.slice(0, 2))).toEqual([{ count: 2, percent: 5 }]);
    expect(tiersFor(games).map((t) => t.percent)).toEqual([5, 10]);
    const four = [...games, item("1004", "Chess clock", { sensible: 18 })];
    expect(tiersFor(four).map((t) => t.percent)).toEqual([5, 10, 10]);
    const slow = four.map((i) => ({ ...i, listedDays: 90, sensible: 5 }));
    expect(tiersFor(slow).map((t) => t.percent)).toEqual([10, 15, 20]);
  });

  it("are explained in pounds, what the buyer pays and what K gets", () => {
    const [e] = examples([item("1", "a", { price: 10 }), item("2", "b", { price: 20 })], [{ count: 2, percent: 10 }]);
    expect(e.low).toMatchObject({ full: 32.3, pays: 29.09, saves: 3.21 });
    expect(e.low.youGet).toBe(27);
  });
});

describe("rotation", () => {
  const books = [item("3001", "Crime paperback", { price: 30 }), item("3002", "Space paperback", { price: 30 })];
  const base = (): BundleState => ({ ...emptyBundles(), groups: ruleGroups([...games, ...books], NOW) });
  const running = (days: number): BundleState => ({ ...base(), active: { groupId: base().groups[0].id, name: "Board and table games", source: "rules", itemIds: ["1001", "1002", "1003"], tiers: [{ count: 2, percent: 5 }, { count: 3, percent: 10 }], excluded: ["3001", "3002"], since: NOW - days * DAY, updatedAt: NOW - days * DAY, by: "K" } });
  const live = map([...games, ...books]);

  it("activates the best group and excludes everything else", () => {
    const x = suggest(base(), live, 0, NOW)!;
    expect(x.action).toBe("activate");
    expect([...x.itemIds, ...x.exclude].sort()).toEqual([...live.keys()].sort());
    expect(guide(x)[0].steps.join(" ")).toMatch(/nearest lower.*24 hours/s);
  });

  it("doesn't swap early or for a small gain, and does for a clear one after 14 days", () => {
    const rich = map([...games, ...books.map((b) => ({ ...b, price: 200, sensible: 50 }))]);
    expect(suggest(running(5), rich, 0, NOW)).toBeNull();
    expect(suggest(running(20), rich, 0, NOW)).toMatchObject({ action: "swap", name: "Books" });
    const close = map([...games, ...books.map((b) => ({ ...b, price: 36 }))]);
    expect(suggest(running(20), close, 0, NOW)).toBeNull();
  });

  it("swaps at once when the group has run down, or asks to turn it off", () => {
    expect(suggest(running(2), map([games[0], ...books]), 0, NOW)).toMatchObject({ action: "swap" });
    expect(suggest(running(2), map([games[0]]), 0, NOW)).toMatchObject({ action: "off" });
  });

  it("asks to exclude a new listing that joined by default, and lowers an unsafe percentage, but a sale alone changes nothing", () => {
    const x = suggest(running(3), map([...games, ...books, stand]), 0, NOW)!;
    expect(x).toMatchObject({ action: "update" });
    expect(x.exclude).toContain("2002");
    expect(suggest(running(3), map([games[0], games[1], ...books]), 0, NOW)).toBeNull();
    const tight = map([{ ...games[0], sensible: 18.9 }, games[1], games[2], ...books]);
    expect(suggest(running(3), tight, 0, NOW)!.tiers.map((t) => t.percent)).toEqual([5, 5]);
  });

  it("counts only orders of several of the group's items since it began", () => {
    const a = { itemIds: ["1001", "1002"], since: 100 };
    expect(ordersWith(a, [{ created_at: 200, items: { "1001": { quantity: 1 }, "1002": { quantity: 1 } } }, { created_at: 200, items: { "1001": { quantity: 1 }, "9": { quantity: 1 } } }, { created_at: 50, items: { "1001": { quantity: 2 } } }])).toBe(1);
  });
});

describe("nightly and the page", () => {
  let env: Env;
  beforeEach(async () => {
    env = { store: memoryStore() } as Env;
    await seedSnapshot(env.store, NOW, [...games, mic, stand].map((i) => ({ item_id: i.itemId, title: i.title, price: i.price })));
  });
  const k = { name: "K", role: "owner" };
  const call = async (path: string, body?: any, user = k) => {
    const r = (await handleBundles(env, path, body === undefined ? "GET" : "POST", async () => body, user, NOW))!;
    return { status: r.status, body: (await r.json()) as any };
  };

  it("files one to-do, and its Done marks the group active", async () => {
    expect(await reviewBundles(env, NOW)).toMatch(/Claude is off/);
    const open = (await env.store.todos.list("open")).filter((t) => t.code === BUNDLE_TODO);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "you", source: "bundles" });
    expect(await bundleTodoClosed(env, open[0].fingerprint, "done", "K", NOW)).toBe(true);
    const v = (await call("/bundles")).body;
    expect(v.active.items).toHaveLength(3);
    expect(v.suggestion).toBeNull();
    await reviewBundles(env, NOW + DAY);
    expect((await env.store.todos.list("open")).filter((t) => t.code === BUNDLE_TODO)).toHaveLength(0);
  });

  it("a Claude failure keeps the groups and doesn't count as the weekly run", async () => {
    await env.store.kv.setJson("bundle_assistant", { ...emptyBundles(), groups: [{ id: "c-1", name: "Kept", itemIds: ["2001", "1001"], source: "claude", reason: "", at: 0 }] });
    const api = { create: vi.fn(async () => { throw new Error("overloaded"); }) } as any;
    expect(await reviewBundles({ ...env, ANTHROPIC_API_KEY: "k" } as Env, NOW, api)).toMatch(/Claude's part failed/);
    const s = (await env.store.kv.getJson<BundleState>("bundle_assistant"))!;
    expect(s.groups.map((g) => g.id)).toContain("c-1");
    expect(s.claudeAt).toBeNull();
    expect((await env.store.jobs.recentEvents({ since: 0 })).map((e) => e.kind)).toContain("bundles.claude");
  });

  it("lets only the owner change groups; a manager can confirm; stale confirmations are refused", async () => {
    const m = { name: "M", role: "manager" };
    expect((await call("/bundles/groups", { name: "Mine", itemIds: ["1001", "2001"] }, m)).status).toBe(403);
    const made = (await call("/bundles/groups", { name: "Mine", itemIds: ["1001", "2001"] })).body.groups.find((g: any) => g.name === "Mine");
    expect(made.source).toBe("k");
    expect((await call(`/bundles/groups/${made.id}/choose`, {})).body.suggestion.groupId).toBe(made.id);
    const key = (await call("/bundles")).body.suggestion.key;
    expect((await call("/bundles/confirm", { key: "old" }, m)).status).toBe(409);
    expect((await call("/bundles/confirm", { key }, m)).body.active).toMatchObject({ name: "Mine", by: "M" });
    expect(await confirmBundle(env, key, "K", NOW)).toBe(false);
    await call(`/bundles/groups/${made.id}/dismiss`, {});
    await reviewBundles(env, NOW);
    expect((await call("/bundles")).body.groups.map((g: any) => g.id)).not.toContain(made.id);
  });

  it("snoozes a suggestion for two weeks", async () => {
    const key = (await call("/bundles")).body.suggestion.key;
    expect((await call("/bundles/snooze", { key })).body.suggestion).toBeNull();
    expect(await reviewBundles(env, NOW + 15 * DAY)).toMatch(/suggests: activate/);
  });
});

describe("waits that can't be relied on", () => {
  it("are null past a year, never billions of days", () => {
    for (const d of [366, 18_864_252, Infinity, NaN, null, "9"]) expect(reliableDays(d)).toBeNull();
    expect(reliableDays(12.4)).toBe(12);
    const day = (n: number) => NOW - n * DAY;
    const mk = marketState(Array.from({ length: 8 }, (_, i) => ({ total: 12.5, at: day(i * 8 + 1) })) as any, [] as any, { now: NOW } as any);
    const d = decide({ market: mk, costs: { postage: 0 }, current: 60 });
    expect(hazard(d.total!, mk.mNow!, 0.01, 2)).toBeLessThan(1 / 365);
    expect(d.options[1].daysToSell).toBeNull();
  });

  it("never lead to accepting less than the asking price; the full price is always accepted", () => {
    const o = { total: 36, price: 36, daysToSell: 18_864_252, chance30: 0, keeps: 36, expectedValue: -20 };
    const decision = { strategy: "compete" as const, price: 36, total: 36, options: [o, o, o], why: "", confidence: 0.5 };
    const ask = (offer: number, d: any = decision) => answerOffer({ offer, asking: 36, decision: d, market: null as MarketState | null, postage: 0, floor: null })!;
    expect(ask(10).action).toBe("decline");
    expect(ask(34).action).toBe("counter");
    expect(ask(30).counterPrice).toBeLessThanOrEqual(36);
    expect(ask(36).action).toBe("accept");
    expect(ask(36, { ...decision, strategy: "ask", price: null, options: [] }).action).toBe("accept");
  });

  it("leave promotion unjudged rather than 'doesn't pay'", () => {
    const market = { mNow: 12.5, mLong: 12.5, demand28: 0.011, demand91: 0.011, supply: 2.8, regime: "normal", weeksOfSupply: 30, valueFloor: 7 } as MarketState;
    const a = promotionAdvice({ price: 36, postage: 0, floor: null, listedDays: 60, views7d: 1, watchers: 0, impressions7d: 20, market, suggestedRate: 8, ebayRecommends: true, currentRate: null });
    expect(a.why).toMatch(/can't be judged/);
    expect(a.action).toBe("none");
  });
});
