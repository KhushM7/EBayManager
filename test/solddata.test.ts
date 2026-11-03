import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import { estimate, parseCompsApi, parseTrawl, QuotaReached, searchSold, wordsFromTitle, type SoldSale } from "../src/solddata";
import { evaluateProviders, pickSales, score } from "../src/solddata-eval";

const sale = (price: number, extra: Partial<SoldSale> = {}): SoldSale => ({
  provider: "trawl",
  title: "Sony WH-1000XM4 headphones",
  price,
  shipping: 3,
  condition: "used",
  dateSold: "2026-10-01",
  bestOffer: false,
  url: null,
  ...extra,
});

describe("parsing", () => {
  it("reads Trawl's UK sales and flags Best Offers known only at the listed price", () => {
    const out = parseTrawl({
      currency: "GBP",
      results: [
        { title: "A", sale_price: 120, shipping_price: 0, condition: "used", date_sold: "2026-10-01T00:00:00Z", buying_format: "Buy It Now", item_link: "u1" },
        { title: "B", sale_price: 140, shipping_price: null, condition: "used", buying_format: "Best Offer", item_link: "u2" },
      ],
    });
    // Buyer Protection fee taken out: (120 - 0.75) / 1.04, (140 - 0.75) / 1.04.
    expect(out.map((s) => [s.price, s.shipping, s.bestOffer])).toEqual([
      [114.66, 0, false],
      [133.89, null, "listed"],
    ]);
    expect(parseTrawl({ currency: "USD", results: [{ title: "x", sale_price: 1 }] })).toEqual([]);
  });

  it("reads CompsAPI in GBP, using the implied rate when a row lacks its native price", () => {
    const out = parseCompsApi({
      items: [
        { title: "A", price: 100, native_price: 80, native_currency: "GBP", best_offer: true, url: "u1", shipping_cost: 5 },
        { title: "B", price: 50, native_price: null, best_offer: false, url: "u2" },
      ],
    });
    expect(out.map((s) => [s.price, s.bestOffer])).toEqual([
      [80, true],
      [40, false],
    ]);
    expect(out[0].shipping).toBeNull();
  });
});

describe("Buyer Protection fee", () => {
  it("takes eBay's fee back out of Trawl's UK prices", async () => {
    const { withoutBuyerFee } = await import("../src/solddata");
    // Same listings seen in both providers on 2026-11-03: CompsAPI £34.99 vs Trawl £37.09, £29.99 vs £31.89.
    expect(withoutBuyerFee(37.09)).toBeCloseTo(34.94, 2);
    expect(withoutBuyerFee(31.89)).toBeCloseTo(29.94, 2);
    // Above £300 the fee is 2% on the rest: an item of £500 pays 0.75 + 12 + 4 = £16.75.
    expect(withoutBuyerFee(516.75)).toBeCloseTo(500, 2);
  });
});

describe("estimate", () => {
  it("drops junk titles, outliers and Best Offers with only a listed price", () => {
    const sales = [
      ...[100, 105, 110, 115, 120].map((p) => sale(p)),
      sale(900),
      sale(20, { title: "Sony WH-1000XM4 spares or repair faulty" }),
      sale(150, { bestOffer: "listed" }),
      sale(98, { bestOffer: true }),
    ];
    const e = estimate(sales);
    expect(e.count).toBe(6);
    expect(e.median).toBe(107.5);
    expect(e.excluded).toBe(3);
    expect(e.bestOfferShare).toBeCloseTo(2 / 9, 2);
  });

  it("makes search words from a title", () => {
    expect(wordsFromTitle("TEST Sony WH-1000XM4 Headphones Black, Boxed - Excellent condition")).toBe("Sony WH-1000XM4 Headphones Black");
  });
});

describe("calling providers", () => {
  let env: Env;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) =>
      String(url).includes("trawl")
        ? Response.json({ currency: "GBP", results: [{ title: "Sony", sale_price: 100, item_link: "x" }], credits_charged: 1 })
        : Response.json({ items: [{ title: "Sony", price: 125, native_price: 100, native_currency: "GBP" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    env = { DB: fakeD1(), TRAWL_API_KEY: "tk", COMPSAPI_KEY: "ck" } as Env;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends only search words, for the UK site, with each provider's key header", async () => {
    await searchSold(env, "trawl", { words: "Sony WH-1000XM4", condition: "used" });
    await searchSold(env, "compsapi", { words: "Sony WH-1000XM4" });
    const [tUrl, tInit] = fetchMock.mock.calls[0];
    const [cUrl, cInit] = fetchMock.mock.calls[1];
    expect(new URL(tUrl).searchParams.get("site")).toBe("EBAY_GB");
    expect(new URL(tUrl).searchParams.get("query")).toBe("Sony WH-1000XM4");
    expect(tInit.headers["x-api-key"]).toBe("tk");
    expect(new URL(cUrl).searchParams.get("site")).toBe("UK");
    expect(cInit.headers["X-API-Key"]).toBe("ck");
    expect(cInit.headers["User-Agent"]).toMatch(/EBayManager/);
    expect([...new URL(tUrl).searchParams.keys(), ...new URL(cUrl).searchParams.keys()]).not.toContain("item_id");
  });

  it("serves a repeated search from the cache without spending", async () => {
    await searchSold(env, "trawl", { words: "Sony" });
    const again = await searchSold(env, "trawl", { words: "sony " });
    expect(again.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at the monthly cap before calling, and treats the provider's quota error the same", async () => {
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO solddata_usage (provider, month, used) VALUES ('compsapi', ?, 100)").bind(month).run();
    await expect(searchSold(env, "compsapi", { words: "Sony" })).rejects.toThrow(QuotaReached);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async () => new Response("{}", { status: 429 }));
    await expect(searchSold(env, "trawl", { words: "Sony" })).rejects.toThrow(QuotaReached);
  });

  it("isn't used without a key", async () => {
    await expect(searchSold({ ...env, TRAWL_API_KEY: undefined } as Env, "trawl", { words: "x" })).rejects.toThrow(/no API key/);
  });
});

describe("K's test: price items K has sold, compare with what K got", () => {
  it("picks sales spread across the price range", () => {
    const rows = [5, 10, 20, 40, 80, 160, 320].map((p, i) => ({ item_id: String(i), title: `Item ${i}`, price: p }));
    expect(pickSales(rows).map((r) => r.price)).toEqual([5, 20, 40, 160, 320]);
  });

  it("prefers the more accurate provider once it covers 3 items", () => {
    const r = (errorPct: number) => ({ count: 5, median: 1, p25: 1, p75: 1, bestOfferShare: 0, excluded: 0, errorPct, inBand: errorPct < 10 });
    const items = [1, 2, 3].map((i) => ({ itemId: String(i), title: "t", actual: 10, words: "t", results: { trawl: r(15), compsapi: r(5) } }));
    expect(score(items).primary).toBe("compsapi");
    expect(score(items).summary.compsapi).toEqual({ priced: 3, meanErrorPct: 5, inBand: 3 });
  });

  it("runs end to end, leaving K's own sale out of the estimate", async () => {
    const env = { DB: fakeD1(), EBAY_ENV: "sandbox", EBAY_MARKETPLACE: "EBAY_GB", TRAWL_API_KEY: "tk", COMPSAPI_KEY: "ck" } as Env;
    await env.DB.prepare(
      "INSERT INTO ebay_tokens (id, access_token, access_expires_at, refresh_token, refresh_expires_at, scopes) VALUES (1, 't', ?, 'r', ?, 's')",
    )
      .bind(Date.now() + 3_600_000, Date.now() + 3_600_000)
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/sell/fulfillment/"))
          return Response.json({
            orders: [{ orderId: "o1", creationDate: "2026-10-01T00:00:00Z", pricingSummary: { total: { value: "100" } }, lineItems: [{ legacyItemId: "111", title: "Sony WH-1000XM4 Headphones", quantity: 1, lineItemCost: { value: "100" } }] }],
          });
        if (String(url).includes("trawl"))
          return Response.json({
            currency: "GBP",
            results: [
              { title: "Sony WH-1000XM4", sale_price: 100, item_link: "https://www.ebay.co.uk/itm/111" },
              // Trawl prices include the Buyer Protection fee; these come back to 90, 95 and 110.
              ...[94.35, 99.55, 115.15].map((p) => ({ title: "Sony WH-1000XM4", sale_price: p, item_link: "x" })),
            ],
          });
        return Response.json({ items: [80, 85, 90].map((p) => ({ title: "Sony WH-1000XM4", price: p, native_price: p, native_currency: "GBP" })) });
      }),
    );
    const r = await evaluateProviders(env);
    vi.unstubAllGlobals();
    expect(r.items).toHaveLength(1);
    const t = r.items[0].results.trawl as any;
    expect(t.count).toBe(3);
    expect(t.median).toBe(95);
    expect(t.errorPct).toBe(5);
    expect((r.items[0].results.compsapi as any).errorPct).toBe(15);
    expect(r.summary.trawl).toEqual({ priced: 1, meanErrorPct: 5, inBand: 1 });
    expect(r.primary).toBe("trawl");
  });
});
