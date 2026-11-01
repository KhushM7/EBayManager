import { describe, expect, it } from "vitest";
import { parseTradingResponse, toActiveListing } from "../src/ebay/trading";
import { summarize } from "../src/ebay/browse";
import { signDecision, verifyDecision } from "../src/proposals";
import { handleRpc } from "../src/mcp";
import type { Env } from "../src/env";

const env = { SIGNING_KEY: "test-key" } as Env;

describe("Trading parsing", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>
<ActiveList><ItemArray><Item><ItemID>123</ItemID><Title>Sony WH-1000XM4</Title>
<SellingStatus><CurrentPrice currencyID="GBP">120.0</CurrentPrice></SellingStatus>
<QuantityAvailable>1</QuantityAvailable><WatchCount>4</WatchCount>
<ListingDetails><StartTime>2026-08-01T10:00:00.000Z</StartTime><ViewItemURL>https://www.ebay.co.uk/itm/123</ViewItemURL></ListingDetails>
</Item></ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList>
</GetMyeBaySellingResponse>`;

  it("reads an active listing", () => {
    const doc = parseTradingResponse("GetMyeBaySelling", xml);
    const item = toActiveListing([doc.ActiveList.ItemArray.Item].flat()[0]);
    expect(item).toMatchObject({ itemId: "123", price: 120, currency: "GBP", watchCount: 4, quantityAvailable: 1 });
  });

  it("throws on Failure", () => {
    const bad = `<GetItemResponse><Ack>Failure</Ack><Errors><LongMessage>Invalid token</LongMessage></Errors></GetItemResponse>`;
    expect(() => parseTradingResponse("GetItem", bad)).toThrow("Invalid token");
  });
});

describe("comp summary", () => {
  it("gives low, median, high", () => {
    expect(summarize([10, 20, 30, 40, 50, 0])).toEqual({ low: 14, median: 30, high: 46 });
    expect(summarize([])).toEqual({ low: null, median: null, high: null });
  });
});

describe("approval links", () => {
  it("only accepts the matching signature and decision", async () => {
    const sig = await signDecision(env, "p1", "approve");
    expect(await verifyDecision(env, "p1", "approve", sig)).toBe(true);
    expect(await verifyDecision(env, "p1", "reject", sig)).toBe(false);
    expect(await verifyDecision(env, "p2", "approve", sig)).toBe(false);
  });
});

describe("MCP", () => {
  it("lists tools and has no direct price-setting tool", async () => {
    const res: any = await handleRpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("propose_price_change");
    expect(names.some((n: string) => /^(set|revise|update)_price/.test(n))).toBe(false);
  });
});
