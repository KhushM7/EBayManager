import { describe, expect, it, vi, afterEach } from "vitest";
import { memoryStore } from "../src/store";
import { seedProposal, seedSnapshot } from "./fixtures";
import type { Env } from "../src/env";
import { answerOffer } from "../src/pricing/offers";
import { enginePriceCheck, tools } from "../src/tools";
import { reviewPrices } from "../src/pricing/review";
import type { Decision, MarketState } from "../src/pricing/model";

const decision = (over: Partial<Decision> = {}): Decision => ({
  strategy: "compete",
  price: 40,
  total: 44,
  options: [
    { total: 40.5, price: 36.5, daysToSell: 10, chance30: 0.9, keeps: 36.5, expectedValue: 35 },
    { total: 44, price: 40, daysToSell: 20, chance30: 0.75, keeps: 40, expectedValue: 37 },
    { total: 47.5, price: 43.5, daysToSell: 40, chance30: 0.5, keeps: 43.5, expectedValue: 36 },
  ],
  why: "Sales clear at £44.00.",
  confidence: 0.6,
  ...over,
});
const market = { valueFloor: 38, mNow: 44 } as MarketState; // value floor £34 as an item price with £4 postage

describe("offers against the engine", () => {
  const ask = (offer: number, over: Partial<Parameters<typeof answerOffer>[0]> = {}) =>
    answerOffer({ offer, asking: 45, decision: decision(), market, postage: 4, floor: null, ...over })!;

  it("accepts an offer worth more than carrying on (listing at £40 and waiting about 20 days is worth £37 now)", () => {
    const a = ask(37.5);
    expect(a.action).toBe("accept");
    expect(a.reservation).toBe(37);
    expect(a.reason).toMatch(/about 20 days/);
  });

  it("counters below that, halfway to the asking price or at the reservation, with a precise ending", () => {
    const a = ask(33);
    expect(a.action).toBe("counter");
    expect(a.counterPrice).toBe(38.9); // halfway is £39, given a precise ending
    expect(ask(20, { asking: 38 }).counterPrice).toBeGreaterThanOrEqual(37);
  });

  it("declines a lowball under half the reservation", () => {
    expect(ask(15).action).toBe("decline");
  });

  it("never goes below K's floor or the market's value floor", () => {
    expect(ask(37.5, { floor: 39 })).toMatchObject({ action: "counter", reservation: 39 });
    const slow = decision({ options: decision().options.map((o) => ({ ...o, expectedValue: 20 })) });
    expect(answerOffer({ offer: 30, asking: 45, decision: slow, market, postage: 4, floor: null })!.reservation).toBe(34);
  });

  it("has no answer when the engine can't price the item", () => {
    expect(answerOffer({ offer: 30, asking: 45, decision: decision({ strategy: "ask", price: null, options: [] }), market: null, postage: 4, floor: null })).toBeNull();
  });
});

describe("price proposals come from the engine", () => {
  const env = () => ({ store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", SIGNING_KEY: "test-signing-key", PUBLIC_URL: "https://app.example" }) as Env;
  const record = (e: Env, d: Decision, at = Date.now()) =>
    e.store.pricing.recordDecision({ item_id: "111", at, grp: "g", strategy: d.strategy, price: d.price, total: d.total, market_price: 44, predicted_days: 20, result: JSON.stringify({ decision: d }) });

  it("refuses without a recent check, off the engine's options, or when it's asking K", async () => {
    const e = env();
    await expect(enginePriceCheck(e, "111", 40)).rejects.toThrow(/Run price_check/);
    await record(e, decision(), Date.now() - 4 * 86_400_000);
    await expect(enginePriceCheck(e, "111", 40)).rejects.toThrow(/Run price_check/);
    await record(e, decision());
    expect(await enginePriceCheck(e, "111", 40.2)).toMatch(/compete, recommended £40.00/);
    expect(await enginePriceCheck(e, "111", 36.5)).toBeTruthy();
    await expect(enginePriceCheck(e, "111", 30)).rejects.toThrow(/isn't one of the engine's prices/);
    await record(e, decision({ strategy: "ask", price: null, options: [], question: "Which model?" }), Date.now() + 1);
    await expect(enginePriceCheck(e, "111", 40)).rejects.toThrow(/Which model\?/);
  });

  it("files the proposal with the engine's reasoning attached", async () => {
    const e = env();
    await record(e, decision());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const out: any = await tools.find((t) => t.name === "propose_price_change")!.run(e, { item_id: "111", new_price: 40, reason: "Comps." });
    vi.unstubAllGlobals();
    expect(out.proposalId).toBeTruthy();
    const [p] = await e.store.proposals.listByStatus("pending", "asc");
    expect(p!.reason).toMatch(/Engine: compete, recommended £40.00/);
  });
});

describe("nightly price review", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips listings with a pending price change or a recent check, and reports what it did", async () => {
    const e = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval" } as Env;
    const now = Date.now();
    // A pending listing edit (item 4) doesn't hold back a price check.
    await seedSnapshot(e.store, now, ["1", "2", "3", "4"].map((id) => ({ item_id: id, price: 40 })));
    await seedProposal(e.store, { id: "p", kind: "price", item_id: "1", status: "pending", created_at: now, expires_at: now + 1e9 });
    await seedProposal(e.store, { id: "q", kind: "revise", item_id: "4", status: "pending", created_at: now, expires_at: now + 1e9 });
    await e.store.pricing.recordDecision({ item_id: "2", at: now - 86_400_000, grp: "g", strategy: "compete", price: null, total: null, market_price: null, predicted_days: null, result: "{}" });
    // Item 3 is due; eBay isn't reachable here, so its check fails and is reported.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const out = await reviewPrices(e, now);
    expect(out).toMatch(/^2 priced, 0 proposed/);
    expect(out).toMatch(/failed 3:/);
    expect(out).toMatch(/4:/);
    // The audit prices every listing, pending proposals and recent checks included.
    expect(await reviewPrices(e, now, { all: true })).toMatch(/^4 priced/);
  });
});
