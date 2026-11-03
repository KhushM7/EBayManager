import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import type { MessagesApi } from "../src/claude";
import { isJunk, itemNumber, poolSales, wordsFromTitle, type SoldSale } from "../src/solddata";
import { identify, identifyByRules, matchTitles } from "../src/pricing/identify";
import { priceItem, recordDecision, sumOfParts } from "../src/pricing/engine";
import { learnParams } from "../src/pricing/learn";
import { evaluateCombine, evaluateSplit, suggestBundles } from "../src/pricing/bundles";

const DAY = 86_400_000;

/** A stand-in for the Messages API that answers each job by its system prompt. */
function fakeClaude(answer: (system: string, prompt: string) => unknown) {
  const calls: { system: string; prompt: string }[] = [];
  const api: MessagesApi = {
    async create(params) {
      const system = (params.system as any[])[0].text as string;
      const prompt = (params.messages[0].content as string) ?? "";
      calls.push({ system, prompt });
      return {
        id: "m",
        type: "message",
        role: "assistant",
        model: "x",
        content: [{ type: "text", text: JSON.stringify(answer(system, prompt)) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
  return { api, calls };
}

const sold = (title: string, price: number, extra: Partial<SoldSale> = {}): SoldSale => ({
  provider: "trawl",
  title,
  price,
  shipping: null,
  condition: "used",
  dateSold: null,
  bestOffer: false,
  url: null,
  ...extra,
});

describe("search fixes", () => {
  it("keeps model digits", () => {
    expect(wordsFromTitle("Samsung Galaxy Buds 2 Pro Graphite")).toBe("Samsung Galaxy Buds 2 Pro Graphite");
  });

  it("doesn't call a sale junk for words that are in K's own title", () => {
    expect(isJunk("3D Glasses Lot of 2 Pairs", "LG 3D Glasses Lot of 2")).toBe(false);
    expect(isJunk("3D Glasses Lot of 2 Pairs", "LG 3D Glasses")).toBe(true);
    expect(isJunk("Glasses lot spares or repair", "Glasses Lot of 2")).toBe(true);
  });

  it("reads item numbers from eBay links", () => {
    expect(itemNumber("https://www.ebay.co.uk/itm/178305344332")).toBe("178305344332");
    expect(itemNumber("https://www.ebay.co.uk/itm/sony-headphones/178305344332?hash=x")).toBe("178305344332");
    expect(itemNumber(null)).toBeNull();
  });

  it("pools both providers, each sale once, keeping the known Best Offer price and Trawl's postage", () => {
    const url = "https://www.ebay.co.uk/itm/111111111111";
    const pooled = poolSales(
      [sold("A", 50, { url, bestOffer: "listed", shipping: 3.5 }), sold("B", 20, { url: "https://www.ebay.co.uk/itm/222222222222" })],
      [sold("A", 42, { provider: "compsapi", url, bestOffer: true }), sold("C", 30)],
    );
    expect(pooled).toHaveLength(3);
    const a = pooled.find((s) => s.title === "A")!;
    expect([a.price, a.bestOffer, a.shipping, a.provider]).toEqual([42, true, 3.5, "compsapi"]);
  });
});

describe("identify and match", () => {
  const env = { DB: fakeD1(), ANTHROPIC_API_KEY: "k" } as Env;

  it("uses Claude's identification, including a bundle's parts", async () => {
    const { api, calls } = fakeClaude(() => ({
      product: "Amazon Fire TV Stick 4K with Alexa Voice Remote",
      group: "streaming devices",
      condition: "used",
      components: [
        { name: "Fire TV Stick 4K", query: "Fire TV Stick 4K", valued: true },
        { name: "Alexa Voice Remote", query: "Alexa Voice Remote 3rd Gen", valued: true },
        { name: "Manual", query: "manual", valued: false },
      ],
      priceable: true,
      question: null,
    }));
    const id = await identify(env, { title: "Fire TV Stick 4K + Alexa remote + manual" }, api);
    expect(id.by).toBe("claude");
    expect(id.components.map((c) => c.valued)).toEqual([true, true, false]);
    expect(calls[0].prompt).toContain("Fire TV Stick 4K + Alexa remote");
  });

  it("falls back to word rules without a key, and asks when the title is too vague", async () => {
    const id = await identify({ DB: fakeD1() } as Env, { title: "Lights" });
    expect(id.by).toBe("rules");
    expect(id.priceable).toBe(false);
    expect(identifyByRules("Samsung Galaxy Buds 2 Pro").components[0].query).toBe("Samsung Galaxy Buds 2 Pro");
  });

  it("grades listings with Claude in batches of 60, and ignores numbers out of range", async () => {
    const { api, calls } = fakeClaude(() => ({ exact: [1, 999], close: [{ n: 3, factor: 0.5 }] }));
    const identity = { ...identifyByRules("Sony WH-1000XM4"), by: "claude" as const };
    const titles = Array.from({ length: 150 }, (_, i) => `Title ${i}`);
    const out = await matchTitles(env, identity, identity.components[0], titles, "Sony WH-1000XM4", api);
    expect(calls).toHaveLength(3);
    expect(out.matches.map((g) => g.i)).toEqual([0, 2, 60, 62, 120, 122]);
    expect(out.matches[1]).toEqual({ i: 2, grade: "close", factor: 0.5 });
  });

  it("retries a batch whose reply didn't fit in halves, and never falls back to looser word rules", async () => {
    let n = 0;
    const api: MessagesApi = {
      async create() {
        n++;
        // The first (full) batch runs out of room; the halves succeed.
        return {
          content: [{ type: "text", text: n === 1 ? '{"exact": [1' : JSON.stringify({ exact: [1], close: [] }) }],
          stop_reason: n === 1 ? "max_tokens" : "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        } as any;
      },
    };
    const identity = { ...identifyByRules("Samsung SSG-4100GB"), by: "claude" as const };
    const titles = Array.from({ length: 40 }, () => "Samsung SSG-4100GB 3D glasses");
    const out = await matchTitles(env, identity, identity.components[0], titles, "Samsung SSG-4100GB Lot of 2", api);
    expect(out.by).toBe("claude");
    expect(out.matches.map((g) => g.i)).toEqual([0, 20]);
  });

  it("shows Claude the listing photos and description, and never guesses the condition", async () => {
    const { api, calls } = fakeClaude(() => ({ product: "x", group: "g", condition: "unknown", keyFacts: [], components: [{ name: "x", query: "x y", valued: true }], priceable: true, question: null }));
    const raw: any[] = [];
    const spy: MessagesApi = { create: async (p) => (raw.push(p), api.create(p)) };
    const photos = ["https://i.ebayimg.com/a.jpg", "http://bad", "https://i.ebayimg.com/b.jpg"];
    await identify(env, { title: "Sensor bin", description: "<p>Used <b>twice</b>, 45L</p>", photos }, spy);
    const content = raw[0].messages[0].content;
    expect(content.filter((b: any) => b.type === "image").map((b: any) => b.source.url)).toEqual(["https://i.ebayimg.com/a.jpg", "https://i.ebayimg.com/b.jpg"]);
    expect(calls[0].system).toMatch(/Otherwise unknown/);
    expect(content.at(-1).text).toContain("Used twice , 45L");
    expect(identifyByRules("Sensor bin 45L").condition).toBe("unknown");
  });
});

describe("thin markets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prices from a few exact sales plus adjusted close ones instead of asking", async () => {
    const now = Date.now();
    const item = (title: string, p: number, daysAgo: number, id: string) => ({ title, price: p, native_price: p, native_currency: "GBP", last_sold: new Date(now - daysAgo * DAY).toISOString(), url: `https://www.ebay.co.uk/itm/${id}` });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("compsapi")
          ? // 2 exact at £25; 4 close (the 50L at £30, K's 45L worth 0.8 of it: £24).
            Response.json({ items: [item("Sensor bin 45L", 25, 5, "100000000001"), item("Sensor bin 45L", 25, 6, "100000000002"), ...[1, 2, 3, 4].map((k) => item("Sensor bin 50L", 30, 10 + k, `20000000000${k}`))] })
          : new Response("no", { status: 500 }),
      ),
    );
    const { api } = fakeClaude((system, prompt) =>
      system.includes("identify")
        ? { product: "Sensor bin 45L", group: "bins", condition: "used", keyFacts: [], components: [{ name: "Sensor bin 45L", query: "sensor bin 45L", valued: true }], priceable: true, question: null }
        : {
            exact: prompt
              .split("\n")
              .filter((l) => /^\d+\. Sensor bin 45L/.test(l))
              .map((l) => Number(l.split(".")[0])),
            close: prompt
              .split("\n")
              .filter((l) => /^\d+\. Sensor bin 50L/.test(l))
              .map((l) => ({ n: Number(l.split(".")[0]), factor: 0.8 })),
          },
    );
    const r = await priceItem({ DB: fakeD1(), EBAY_ENV: "sandbox", COMPSAPI_KEY: "ck", ANTHROPIC_API_KEY: "k" } as Env, { title: "Sensor bin 45L", postage: 0 }, api);
    const c = r.components[0];
    expect(c.matched).toMatchObject({ sold: 2, closeSold: 4 });
    expect(c.market.effective).toBeCloseTo(3.4, 1);
    expect(c.market.mNow).toBeGreaterThan(24);
    expect(c.market.mNow).toBeLessThan(25); // exact sales weigh more than the adjusted close ones
    expect(r.decision.strategy).not.toBe("ask");
    expect(r.decision.price).toBeGreaterThan(20);
    expect(r.decision.confidence).toBeLessThan(0.3);
  });
});

describe("pricing an item end to end", () => {
  afterEach(() => vi.unstubAllGlobals());

  function market(now: number) {
    // CompsAPI and Trawl each report 20 sales of £40 + £4 postage over 100 days, plus an accessory and K's own.
    const sales = Array.from({ length: 20 }, (_, i) => ({ i, at: new Date(now - (i * 5 + 1) * DAY).toISOString() }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("trawl"))
          return Response.json({
            currency: "GBP",
            results: [
              ...sales.map(({ i, at }) => ({ title: "Sony WH-1000XM4", sale_price: 40 * 1.04 + 0.75, shipping_price: 4, date_sold: at, item_link: `https://www.ebay.co.uk/itm/9000000000${String(i).padStart(2, "0")}` })),
              { title: "Case for Sony WH-1000XM4", sale_price: 8, shipping_price: 2, date_sold: sales[0].at, item_link: "https://www.ebay.co.uk/itm/800000000001" },
              { title: "Sony WH-1000XM4", sale_price: 20, shipping_price: 4, date_sold: sales[0].at, item_link: "https://www.ebay.co.uk/itm/555555555555" },
            ],
          });
        if (u.includes("compsapi"))
          // The same 20 sales: pooled, they count once.
          return Response.json({ items: sales.map(({ i, at }) => ({ title: "Sony WH-1000XM4", price: 50, native_price: 40, native_currency: "GBP", last_sold: at, url: `https://www.ebay.co.uk/itm/9000000000${String(i).padStart(2, "0")}` })) });
        if (u.includes("oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
        if (u.includes("item_summary"))
          return Response.json({ total: 6, itemSummaries: [39, 41, 43, 45, 47, 49].map((p, i) => ({ itemId: `v1|70${i}|0`, title: "Sony WH-1000XM4", price: { value: String(p) }, shippingOptions: [{ shippingCost: { value: "4.00" } }] })) });
        return new Response("not found", { status: 404 });
      }),
    );
  }

  const env = () =>
    ({ DB: fakeD1(), EBAY_ENV: "sandbox", EBAY_MARKETPLACE: "EBAY_GB", EBAY_APP_ID: "a", EBAY_CERT_ID: "c", TRAWL_API_KEY: "tk", COMPSAPI_KEY: "ck", ANTHROPIC_API_KEY: "k" }) as Env;

  it("pools, matches with Claude, prices on totals, leaves K's own sale out, and records a snapshot", async () => {
    const now = Date.now();
    market(now);
    const e = env();
    const { api } = fakeClaude((system, prompt) =>
      system.includes("identify")
        ? { product: "Sony WH-1000XM4", group: "headphones", condition: "used", components: [{ name: "Sony WH-1000XM4", query: "Sony WH-1000XM4", valued: true }], priceable: true, question: null }
        : // Everything except the case.
          { exact: prompt.split("\n").filter((l) => /^\d+\. Sony/.test(l)).map((l) => Number(l.split(".")[0])), close: [] },
    );
    const r = await priceItem(e, { itemId: "555555555555", title: "Sony WH-1000XM4 headphones", postage: 4, excludeItemIds: ["555555555555"] }, api);
    const c = r.components[0];
    expect(c.found.sold).toBe(21); // 20 pooled + the case; K's own sale is gone
    expect(c.matched).toEqual({ sold: 20, active: 6, closeSold: 0, closeActive: 0, by: "claude" });
    expect(c.market.mNow).toBe(44); // £40 + £4 postage
    expect(c.typicalPostage).toBe(4);
    expect(r.decision.strategy).toBe("compete");
    expect(r.decision.price).toBeGreaterThan(36);
    expect(r.decision.price).toBeLessThanOrEqual(40);
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM market_snapshots").first<any>()).n).toBe(6);

    await recordDecision(e, "555555555555", r);
    expect((await e.DB.prepare("SELECT strategy, grp FROM price_decisions").first<any>())).toEqual({ strategy: "compete", grp: "headphones" });
  });

  it("asks rather than guessing when Claude can't identify the item", async () => {
    market(Date.now());
    const { api } = fakeClaude(() => ({ product: "ceiling lights", group: "lighting", condition: "used", components: [{ name: "lights", query: "ceiling lights", valued: true }], priceable: false, question: "Which brand and model are the lights?" }));
    const r = await priceItem(env(), { title: "Designer ceiling lights" }, api);
    expect(r.decision.strategy).toBe("ask");
    expect(r.decision.question).toMatch(/brand/);
    expect(r.components).toHaveLength(0);
  });
});

describe("bundles", () => {
  const part = (name: string, total: number, postage: number, strategy = "compete") =>
    ({
      name,
      valued: true,
      typicalPostage: postage,
      market: { why: "", regime: "normal" },
      decision: { strategy, total, price: total - postage, confidence: 0.8, options: [0.92, 1, 1.08].map((f) => ({ total: total * f, daysToSell: 10, chance30: 0.9 })) },
    }) as any;

  it("prices a bundle as the sum of its parts with one postage", () => {
    const d = sumOfParts([part("TV stick", 30, 3), part("Remote", 15, 3)], 3.5);
    expect(d.price).toBeCloseTo(38.99, 2); // £27 + £12, charm-priced
    expect(d.total).toBeCloseTo(42.49, 2);
    expect(d.why).toMatch(/TV stick £27\.00, Remote £12\.00/);
  });

  it("prices from the main part when a lesser part has no sales, naming what wasn't counted; asks only for the main part", () => {
    const d = sumOfParts([part("TV stick", 30, 3), { ...part("Mystery", 0, 0, "ask"), market: { why: "thin" } }], 3);
    expect(d.strategy).toBe("compete");
    expect(d.price).toBeCloseTo(26.99, 2);
    expect(d.why).toMatch(/Not counted, no sales found: Mystery/);
    expect(sumOfParts([{ ...part("Mystery", 0, 0, "ask"), market: { why: "thin" } }, part("TV stick", 30, 3)], 3).strategy).toBe("ask");
  });

  it("recommends combining slow items with a related popular one only when it's worth it", async () => {
    const slow = { itemId: "1", title: "Galaxy Buds case", price: 6, listedDays: 120, watchers: 0, daysToSell: 300 };
    const popular = { itemId: "2", title: "Galaxy Buds 2 Pro", price: 60, listedDays: 5, watchers: 3, daysToSell: 12 };
    const e = evaluateCombine([slow, popular]);
    expect(e.daysTogether).toBeLessThan(e.daysSeparately);

    const { api } = fakeClaude(() => ({
      suggestions: [
        { kind: "combine", itemIds: ["1", "3"], title: "Galaxy Buds with case", reason: "Same buyer." },
        { kind: "combine", itemIds: ["1", "nope"], title: "x", reason: "y" },
      ],
    }));
    const slowCharger = { itemId: "3", title: "Samsung charger", price: 8, listedDays: 200, watchers: 0, daysToSell: 400 };
    const advice = await suggestBundles({ DB: fakeD1(), ANTHROPIC_API_KEY: "k" } as Env, [slow, popular, slowCharger], api);
    expect(advice).toHaveLength(1);
    expect(advice[0].together).toBeGreaterThan(advice[0].separately);
  });

  it("recommends splitting a bundle whose parts are worth clearly more", () => {
    const e = evaluateSplit({ itemId: "9", title: "Console + 5 games", price: 80, listedDays: 10, watchers: 1, daysToSell: 20, parts: [{ name: "Console", price: 90 }, { name: "Games", price: 40 }] });
    expect(e.separately).toBeGreaterThan(e.together * 1.15 + 5);
  });
});

describe("learning from snapshots", () => {
  it("fits parameters from gone and remaining listings", async () => {
    const env = { DB: fakeD1() } as Env;
    const now = Date.now();
    const rows: unknown[][] = [];
    // Cheap listings vanish within a week; dear ones stay. Across 10 searches.
    for (let k = 0; k < 10; k++)
      for (let i = 0; i < 10; i++) {
        const total = 30 + i * 2;
        rows.push([`q${k}`, now - 10 * DAY, `i${k}-${i}`, total, "headphones", 40, 0.05]);
        if (total > 40) rows.push([`q${k}`, now - 3 * DAY, `i${k}-${i}`, total, "headphones", 40, 0.05]);
      }
    await env.DB.batch(rows.map((r) => env.DB.prepare("INSERT INTO market_snapshots (key, taken_at, item_id, total, grp, market, share) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(...r)));
    const out = await learnParams(env, now);
    expect(out.outcomes).toBe(100);
    const p = await env.DB.prepare("SELECT * FROM pricing_params WHERE grp = 'headphones'").first<any>();
    expect(p.n).toBe(100);
    // Strongly price-driven: sharper than the default 0.08.
    expect(p.tau).toBeLessThan(0.08);
  });
});

describe("backtests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the nearest later sales, and says so, when no provider data predates the sale", async () => {
    const now = Date.now();
    const soldAt = now - 120 * DAY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("compsapi")
          ? Response.json({
              items: [10, 20, 30, 40, 50, 90].map((d, k) => ({ title: "Galaxy Buds+", price: 25, native_price: 25, native_currency: "GBP", last_sold: new Date(soldAt + d * DAY).toISOString(), url: `https://www.ebay.co.uk/itm/30000000000${k}` })),
            })
          : new Response("no", { status: 500 }),
      ),
    );
    const { api } = fakeClaude((system, prompt) =>
      system.includes("identify")
        ? { product: "Galaxy Buds+", group: "headphones", condition: "used", keyFacts: [], components: [{ name: "Galaxy Buds+", query: "Galaxy Buds+", valued: true }], priceable: true, question: null }
        : { exact: prompt.split("\n").filter((l) => /^\d+\. Galaxy/.test(l)).map((l) => Number(l.split(".")[0])), close: [] },
    );
    const r = await priceItem({ DB: fakeD1(), EBAY_ENV: "sandbox", COMPSAPI_KEY: "ck", ANTHROPIC_API_KEY: "k" } as Env, { title: "Galaxy Buds+", postage: 0, asOf: soldAt }, api);
    const c = r.components[0];
    expect(c.matched.sold).toBe(5); // the sale 90 days later is too far
    expect(c.market.mNow).toBe(25);
    expect(c.errors.join(" ")).toMatch(/used sales from up to 60 days after/);
  });
});
