import { describe, expect, it } from "vitest";
import { listingImage, parseTradingResponse, toActiveListing } from "../src/ebay/trading";
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
<PictureDetails><GalleryURL>https://i.ebayimg.com/images/g/abc/s-l140.jpg</GalleryURL></PictureDetails>
<ListingDetails><StartTime>2026-08-01T10:00:00.000Z</StartTime><ViewItemURL>https://www.ebay.co.uk/itm/123</ViewItemURL></ListingDetails>
</Item></ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList>
</GetMyeBaySellingResponse>`;

  it("reads an active listing", () => {
    const doc = parseTradingResponse("GetMyeBaySelling", xml);
    const item = toActiveListing([doc.ActiveList.ItemArray.Item].flat()[0]);
    expect(item).toMatchObject({ itemId: "123", price: 120, currency: "GBP", watchCount: 4, quantityAvailable: 1, imageUrl: "https://i.ebayimg.com/images/g/abc/s-l500.jpg" });
  });

  it("keeps only https pictures on eBay's picture hosts", () => {
    expect(listingImage({ PictureDetails: { PictureURL: ["https://i.ebayimg.com/00/s/x/s-l1600.jpg"] } })).toBe("https://i.ebayimg.com/00/s/x/s-l500.jpg");
    expect(listingImage({ PictureDetails: { GalleryURL: "http://i.ebayimg.com/a.jpg" } })).toBeNull();
    expect(listingImage({ PictureDetails: { GalleryURL: "https://evil.example/ebayimg.com.jpg" } })).toBeNull();
    expect(listingImage({ PictureDetails: { GalleryURL: "https://i.ebayimg.com.evil.example/a.jpg" } })).toBeNull();
    expect(listingImage({})).toBeNull();
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
  it("only accepts the matching signature, decision and expiry", async () => {
    const exp = Date.now() + 60_000;
    const sig = await signDecision(env, "p1", "approve", exp);
    expect(await verifyDecision(env, "p1", "approve", exp, sig)).toBe(true);
    expect(await verifyDecision(env, "p1", "reject", exp, sig)).toBe(false);
    expect(await verifyDecision(env, "p2", "approve", exp, sig)).toBe(false);
    expect(await verifyDecision(env, "p1", "approve", exp + 1, sig)).toBe(false);
  });

  it("rejects an expired link even with a valid signature", async () => {
    const exp = Date.now() - 1;
    const sig = await signDecision(env, "p1", "approve", exp);
    expect(await verifyDecision(env, "p1", "approve", exp, sig)).toBe(false);
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
