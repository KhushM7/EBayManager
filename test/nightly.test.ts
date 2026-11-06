import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import { withEbayTokens } from "./fixtures";
import type { Env } from "../src/env";
import { healthFlags, type ListingFacts } from "../src/health";
import { parseTraffic, toOrder } from "../src/ebay/sell";
import { runNightly } from "../src/nightly";
import { metrics } from "../src/api";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-02T02:00:00Z");
const base: ListingFacts = {
  itemId: "1",
  title: "Mug",
  price: 6,
  watchCount: 0,
  startTime: new Date(NOW - 40 * DAY).toISOString(),
  views7d: null,
  impressions7d: null,
  pendingProposals: 0,
  lastPriceChangeAt: null,
};

describe("health rules", () => {
  it("flags a stale listing and a watched one that isn't selling", () => {
    expect(healthFlags(base, NOW).map((f) => f.flag)).toEqual(["stale"]);
    expect(healthFlags({ ...base, watchCount: 4 }, NOW).map((f) => f.flag)).toEqual(["watched_not_selling"]);
  });

  it("flags low views and low click-through only when traffic is known", () => {
    expect(healthFlags({ ...base, watchCount: 1, views7d: 2, impressions7d: 50 }, NOW).map((f) => f.flag)).toEqual(["low_views"]);
    expect(healthFlags({ ...base, watchCount: 1, views7d: 1, impressions7d: 400 }, NOW).map((f) => f.flag)).toEqual([
      "low_views",
      "low_click_through",
    ]);
  });

  it("leaves alone listings with a pending proposal or a recent price change", () => {
    expect(healthFlags({ ...base, pendingProposals: 1 }, NOW)).toEqual([]);
    expect(healthFlags({ ...base, lastPriceChangeAt: NOW - 2 * DAY }, NOW)).toEqual([]);
  });

  it("gives new listings time", () => {
    expect(healthFlags({ ...base, startTime: new Date(NOW - 3 * DAY).toISOString(), views7d: 0 }, NOW)).toEqual([]);
  });
});

describe("Sell API parsing", () => {
  it("reads an order", () => {
    const o = toOrder({
      orderId: "11-1",
      creationDate: "2026-10-30T10:00:00.000Z",
      orderFulfillmentStatus: "FULFILLED",
      pricingSummary: { total: { value: "7.35", currency: "GBP" } },
      totalMarketplaceFee: { value: "0.95", currency: "GBP" },
      lineItems: [{ legacyItemId: "110591497601", title: "Mug", quantity: 1, lineItemCost: { value: "4.50" } }],
    });
    expect(o).toMatchObject({ orderId: "11-1", total: 7.35, fees: 0.95, status: "FULFILLED" });
    expect(o.items[0]).toEqual({ itemId: "110591497601", title: "Mug", quantity: 1, price: 4.5 });
  });

  it("reads a traffic report by metric key, whatever the order", () => {
    const rows = parseTraffic({
      header: { metrics: [{ key: "LISTING_IMPRESSION_TOTAL" }, { key: "LISTING_VIEWS_TOTAL" }] },
      records: [{ dimensionValues: [{ value: "42" }], metricValues: [{ value: 300 }, { value: 7 }] }],
    });
    expect(rows).toEqual([{ itemId: "42", views: 7, impressions: 300 }]);
  });
});

describe("nightly run", () => {
  let env: Env;
  const selling = `<GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray><Item><ItemID>1</ItemID><Title>Mug</Title>
    <SellingStatus><CurrentPrice currencyID="GBP">6.0</CurrentPrice></SellingStatus><QuantityAvailable>1</QuantityAvailable><WatchCount>0</WatchCount>
    <ListingDetails><StartTime>2026-09-01T10:00:00.000Z</StartTime></ListingDetails></Item></ItemArray>
    <PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>`;

  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/ws/api.dll")) return new Response(selling);
        if (String(url).includes("/sell/fulfillment/")) return Response.json({ orders: [] });
        return new Response("Not available in Sandbox", { status: 500 });
      }),
    );
    env = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", EBAY_SITE_ID: "3", EBAY_MARKETPLACE: "EBAY_GB", NTFY_TOPIC: "" } as Env;
    await withEbayTokens(env.store);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("snapshots, flags by rule, survives a failing step and skips triage without a key", async () => {
    const r = await runNightly(env);
    expect(r.steps.snapshot).toBe("1 listings");
    expect(r.steps.orders).toBe("0 orders");
    expect(r.steps.traffic).toMatch(/^failed: /);
    expect(r.steps.health).toBe("1 flagged");
    expect(r.steps.triage).toBe("skipped: no ANTHROPIC_API_KEY");
    expect(r.flagged[0].flags[0].flag).toBe("stale");

    const m = await metrics(env);
    expect(m.listings).toHaveLength(1);
    expect(m.listings[0]).toMatchObject({ active: 1, asking: 6, watchers: 0 });
    expect(m.flags.map((f) => f.flag)).toEqual(["stale"]);
    expect(m.lastNightly.steps.health).toBe("1 flagged");
  });
});
