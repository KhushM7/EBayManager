// K's fixes of 2026-11-05: a known minor fault, no comparable sales (K's own price), readable waits, postage
// above the typical, and no repeated proposals while changes are off.
import { describe, expect, it } from "vitest";
import { daysText, decide, listed, marketState, type MarketSale } from "../src/pricing/model";
import { ownPriceResult, postageNote, priceOwned, pricingPostage, recordDecision, type PriceResult } from "../src/pricing/engine";
import { enginePriceCheck } from "../src/tools";
import { recentlyRevised } from "../src/nightly";
import { fileOwnPriceReminders, filePriceQuestions, parsePrice } from "../src/todos";
import { memoryStore } from "../src/store";
import { seedProposal } from "./fixtures";
import type { Env } from "../src/env";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5);

/** Spares sales like the Dyson's: totals spread from about £16 to £32, one every 10 days. */
function spares(): MarketSale[] {
  const totals = [24, 29.9, 17.26, 28.35, 21.49, 31.5, 15.78, 26, 22.5, 30, 19.5, 27];
  return totals.map((total, i) => ({ total, at: NOW - (i * 10 + 1) * DAY }));
}

describe("a spares item with one known, simple fault", () => {
  const market = marketState(spares(), [{ total: 22 }, { total: 30 }, { total: 35 }], { now: NOW });

  it("is priced from the middle of spares sales, not the cheap end", () => {
    expect(market.regime).toBe("normal");
    const usual = decide({ market, costs: { postage: 6 } });
    const minor = decide({ market, costs: { postage: 6 }, minorFault: true });
    expect(minor.total!).toBeGreaterThanOrEqual(market.mNow! - 1);
    expect(minor.total!).toBeGreaterThan(usual.total!);
    expect(minor.total!).toBeLessThanOrEqual(market.mNow! + 0.5 * (market.p75! - market.mNow!) + 1);
    expect(minor.why).toMatch(/One known fault with the rest working/);
    expect(usual.why).not.toMatch(/known fault/);
  });
});

describe("no comparable sales", () => {
  it("asks K for a price, saying why, instead of asking for the model", () => {
    const empty = marketState([], [], { now: NOW });
    const d = decide({ market: empty, costs: { postage: 10 } });
    expect(d).toMatchObject({ strategy: "ask", reason: "no_sales", question: expect.stringMatching(/What price do you want for it\?$/) });
  });

  it("files that as 'Set the price yourself', and a model question as before", async () => {
    const env = { store: memoryStore() } as Env;
    await filePriceQuestions(env, ["1", "2"], [
      { itemId: "1", title: "TV stand", question: "No sales ... What price do you want for it?", reason: "no_sales" },
      { itemId: "2", title: "Lights", question: "Which brand?", reason: "unidentified" },
    ], NOW);
    const open = await env.store.todos.list("open");
    expect(open.map((t) => [t.code, t.title]).sort()).toEqual([
      ["engine_question", "Answer the pricing engine's question"],
      ["own_price", "Set the price yourself"],
    ]);
  });

  it("reads a price from K's answer", () => {
    expect(parsePrice("£65")).toBe(65);
    expect(parsePrice("about 59.50 I think")).toBe(59.5);
    expect(parsePrice("1,250")).toBe(1250);
    expect(parsePrice("no idea")).toBeNull();
    expect(parsePrice("0")).toBeNull();
  });

  it("treats K's own price as the engine's, so the normal price proposal accepts it and nothing else", async () => {
    const env = { store: memoryStore() } as Env;
    const own = ownPriceResult({ title: "Techlink Arena AA110B TV Stand", postage: 18 }, 65);
    expect(own.decision).toMatchObject({ strategy: "own", price: 65, total: 83, options: [] });
    await recordDecision(env, "1", own);
    await expect(enginePriceCheck(env, "1", 65)).resolves.toMatch(/^own, recommended £65.00/);
    await expect(enginePriceCheck(env, "1", 55)).rejects.toThrow(/isn't one of the engine's prices/);
  });
});

describe("what K reads", () => {
  it("gives no wait estimate past a year", () => {
    expect(daysText(26630)).toBe("no reliable estimate (over a year at today's demand)");
    expect(daysText(Infinity)).toMatch(/no reliable estimate/);
    expect(daysText(12.4)).toBe("about 12 days");
    expect(daysText(1)).toBe("about a day");
  });

  it("rounds the weighted count of competing listings", () => {
    expect(listed(48.750000000000064)).toBe("49");
    expect(listed(4.55)).toBe("4.5");
    expect(listed(7)).toBe("7");
    const m = marketState(spares(), [{ total: 22 }, { total: 30 }], { now: NOW });
    expect(m.why).not.toMatch(/\d\.\d{3,}/);
  });
});

describe("postage above the typical", () => {
  it("prices as if the typical postage were charged, and says so", () => {
    expect(pricingPostage(18, 6.38)).toBe(6.38);
    expect(pricingPostage(4, 6.38)).toBe(4);
    expect(pricingPostage(null, 6.38)).toBe(6.38);
    expect(postageNote(18, 6.38)).toMatch(/Your postage \(£18\.00\) is above the typical £6\.38.*refund any overpaid postage and offer collection/);
  });

  it("keeps the item price where the market puts it, not cut to pay for cautious postage", () => {
    const market = marketState(spares(), [{ total: 25 }], { now: NOW });
    const asTypical = decide({ market, costs: { postage: pricingPostage(18, 6.38) } });
    const asCharged = decide({ market, costs: { postage: 18 } });
    expect(asTypical.price!).toBeGreaterThan(asCharged.price! + 8);
  });
});

describe("no repeated proposals while changes are off", () => {
  it("finds listings with a recent listing edit or price change, including dry runs K agreed to", async () => {
    const env = { store: memoryStore() } as Env;
    const p = (id: string, kind: string, item: string, status: string, ageDays: number) =>
      seedProposal(env.store, { id, kind, item_id: item, status, created_at: NOW - ageDays * DAY, expires_at: NOW + DAY, dry_run: 1 });
    await p("a", "revise", "maono", "agreed", 1);
    await p("b", "revise", "dock", "rejected", 1);
    await p("c", "revise", "lamp", "agreed", 9);
    await p("d", "price", "dyson", "agreed", 1);
    expect([...(await recentlyRevised(env, NOW))]).toEqual(["maono"]);
    expect([...(await recentlyRevised(env, NOW, "price"))]).toEqual(["dyson"]);
  });

  it("once writes are on, leftover dry runs stop holding a listing, but real suggestions still do", async () => {
    const env = { store: memoryStore(), WRITE_MODE: "approval" } as Env;
    const p = (id: string, kind: string, item: string, status: string, dry: number) =>
      seedProposal(env.store, { id, kind, item_id: item, status, created_at: NOW - DAY, expires_at: NOW + DAY, dry_run: dry });
    // From the read-only days: agreed as dry runs, never sent to eBay.
    await p("a", "revise", "maono", "agreed", 1);
    await p("b", "price", "dyson", "agreed", 1);
    // Real ones since go-live: waiting, approved, applied.
    await p("c", "revise", "lamp", "pending", 0);
    await p("d", "revise", "dock", "applied", 0);
    await p("e", "price", "kettle", "approved", 0);
    await p("f", "revise", "mug", "rejected", 0);
    expect([...(await recentlyRevised(env, NOW))].sort()).toEqual(["dock", "lamp"]);
    expect([...(await recentlyRevised(env, NOW, "price"))]).toEqual(["kettle"]);
    // While writes are off, the same dry runs hold as before.
    const off = { ...env, WRITE_MODE: "off" } as Env;
    expect([...(await recentlyRevised(off, NOW))].sort()).toEqual(["dock", "lamp", "maono"]);
  });
});

describe("a listing on K's own price isn't forgotten", () => {
  const input = { title: "Techlink Arena AA110B TV Stand", postage: 18 };
  const noMarket = async (): Promise<PriceResult> => ({ at: NOW, identity: {} as any, components: [], method: "single", decision: { strategy: "ask", price: null, total: null, options: [], why: "", confidence: 0, reason: "no_sales" } });
  const market = async (): Promise<PriceResult> => ({ at: NOW, identity: {} as any, components: [], method: "single", decision: { strategy: "compete", price: 49.99, total: 55, options: [], why: "Sales clear at £55.00.", confidence: 0.5 } });

  it("looks for a market about once a week, and keeps K's price while there's none", async () => {
    const env = { store: memoryStore() } as Env;
    await env.store.listings.setOwnPrice("1", 65, NOW - 7 * DAY);
    let looked = 0;
    const r = await priceOwned(env, "1", input, (await env.store.listings.getSettings("1"))!, async () => (looked++, noMarket()), NOW);
    expect(r.decision).toMatchObject({ strategy: "own", price: 65 });
    expect(looked).toBe(1);
    // Looked today: not again tomorrow.
    await priceOwned(env, "1", input, (await env.store.listings.getSettings("1"))!, async () => (looked++, noMarket()), NOW + DAY);
    expect(looked).toBe(1);
  });

  it("lifts K's price and competes as soon as comparable sales appear", async () => {
    const env = { store: memoryStore() } as Env;
    await env.store.listings.setOwnPrice("1", 65, NOW - 10 * DAY);
    const r = await priceOwned(env, "1", input, (await env.store.listings.getSettings("1"))!, market, NOW);
    expect(r.decision).toMatchObject({ strategy: "compete", price: 49.99, why: expect.stringMatching(/^Sales of this item or close matches have appeared, so your own price \(£65\.00\) is lifted/) });
    expect((await env.store.listings.getSettings("1"))!.own_price).toBeNull();
    expect(JSON.parse((await env.store.pricing.latestDecision("1"))!.result).decision.strategy).toBe("compete");
  });

  it("suggests reviewing it after 30 days unsold, and again 30 days after a dismissal", async () => {
    const env = { store: memoryStore() } as Env;
    const live = [{ itemId: "1", title: "TV stand", price: 65, watchers: 5, views7d: 2 }];
    const settings = (setAt: number) => new Map([["1", { own_price: 65, own_price_set_at: setAt }]]);
    const set = NOW - 31 * DAY;

    await fileOwnPriceReminders(env, live, settings(NOW - 29 * DAY), NOW);
    expect(await env.store.todos.list("open")).toHaveLength(0);

    await fileOwnPriceReminders(env, live, settings(set), NOW);
    const [todo] = await env.store.todos.list("open");
    expect(todo).toMatchObject({ kind: "answer", title: "Review your price: no sale in 31 days", question: "A new price for it? (Now £65.00)" });
    expect(todo.detail).toMatch(/5 watchers, 2 views in the last 7 days/);

    await env.store.todos.close(todo.id, "dismissed", "K", NOW);
    await fileOwnPriceReminders(env, live, settings(set), NOW + 20 * DAY);
    expect(await env.store.todos.list("open")).toHaveLength(0);
    await fileOwnPriceReminders(env, live, settings(set), NOW + 30 * DAY);
    expect(await env.store.todos.list("open")).toEqual([expect.objectContaining({ title: "Review your price: no sale in 61 days" })]);

    // Price cleared (or listing ended): the reminder closes.
    await fileOwnPriceReminders(env, live, new Map(), NOW + 31 * DAY);
    expect(await env.store.todos.list("open")).toHaveLength(0);
  });
});

describe("acting on a price check", () => {
  it("files the engine's price as a label through the usual checks, and refuses any other price", async () => {
    const { proposeEnginePrice } = await import("../src/pricing/actions");
    const { seedSnapshot } = await import("./fixtures");
    const env = { store: memoryStore(), EBAY_ENV: "production", WRITE_MODE: "off", SIGNING_KEY: "k", PUBLIC_URL: "https://x" } as Env;
    await seedSnapshot(env.store, Date.now(), [{ item_id: "178245985136", title: "Dyson", price: 39.99 }]);
    const engine: PriceResult = { at: Date.now(), identity: { product: "Dyson" } as any, components: [], method: "single", decision: { strategy: "compete", price: 35.99, total: 42.37, options: [{ total: 39, price: 32.99, daysToSell: 40, chance30: 0.5, keeps: 32.99, expectedValue: 30 }], why: "Sales clear at £33.00.", confidence: 0.5 } };
    await recordDecision(env, "178245985136", engine);

    expect(await proposeEnginePrice(env, "178245985136", 35.99)).toMatch(/A label to change it to £35\.99 is waiting/);
    const [p] = await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "price" }]);
    expect(p).toMatchObject({ item_id: "178245985136", status: "pending", dry_run: 1 });
    expect(JSON.parse(p.payload)).toMatchObject({ oldPrice: 39.99, newPrice: 35.99 });
    await expect(proposeEnginePrice(env, "178245985136", 20)).rejects.toThrow(/isn't one of the engine's prices/);
    expect(await proposeEnginePrice(env, "178245985136", 39.99)).toMatch(/already at £39\.99/);
  });
});

describe("Claude failing is never silent", () => {
  it("marks a word-rules identity with why, so the label says so", async () => {
    const { identify } = await import("../src/pricing/identify");
    const failing = { create: async () => { throw new Error("400 invalid schema"); } } as any;
    const id = await identify({ store: memoryStore() } as Env, { title: "Samsung SSG-4100GB 3D Glasses Lot of 2" }, failing);
    expect(id).toMatchObject({ by: "rules", fallback: expect.stringMatching(/^Claude couldn't identify it \(400 invalid schema\)/) });
  });

  it("keeps null out of every enum in a structured-output schema (it broke every identification once)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : f.endsWith(".ts") ? [`${d}/${f}`] : []));
    const offenders = walk("src").filter((f) => /enum:\s*\[[^\]]*\bnull\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
