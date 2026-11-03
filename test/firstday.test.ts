import { describe, expect, it } from "vitest";
import { auditListing, rankFindings, settingsFindings, soldFindings, soldSummary, unsoldReason, type SaleRow } from "../src/firstday";
import { toPolicies } from "../src/ebay/sell";
import { toAspects } from "../src/ebay/browse";
import { toSeller, toSold, toUnsold } from "../src/ebay/history";
import { parseTradingResponse } from "../src/ebay/trading";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const DAY = 86_400_000;

const goodItem = {
  ItemID: "111",
  Title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones Black, Boxed with Case",
  PrimaryCategory: { CategoryID: "112529" },
  ItemSpecifics: { NameValueList: [{ Name: "Brand", Value: "Sony" }, { Name: "Model", Value: "WH-1000XM4" }, { Name: "Colour", Value: "Black" }, { Name: "Type", Value: "Over-ear" }] },
  Description: "<p>" + "Fully working, light wear on the headband, boxed with the case and cable. ".repeat(4) + "</p>",
  PictureDetails: { PictureURL: ["https://i/1", "https://i/2", "https://i/3", "https://i/4", "https://i/5", "https://i/6"] },
  ConditionID: "3000",
  ConditionDescription: "Light wear on the headband.",
  ReturnPolicy: { ReturnsAcceptedOption: "ReturnsAccepted", ReturnsWithinOption: "Days_30", ShippingCostPaidByOption: "Buyer" },
  DispatchTimeMax: "2",
  BestOfferDetails: { BestOfferEnabled: "true" },
  ShippingDetails: { ShippingServiceOptions: { ShippingServiceCost: { "#text": "3.5" } } },
  SellingStatus: { CurrentPrice: { "#text": "120" } },
  ListingDetails: { StartTime: new Date(NOW - 40 * DAY).toISOString(), ViewItemURL: "https://www.ebay.co.uk/itm/111" },
  WatchCount: "2",
};

describe("checking one listing", () => {
  it("finds nothing wrong with a complete listing", () => {
    const a = auditListing(goodItem, { aspects: [{ name: "Brand", required: true }, { name: "Model", required: false }], now: NOW });
    expect(a.findings).toEqual([]);
    expect(a).toMatchObject({ price: 120, postage: 3.5, photos: 6, specifics: 4, bestOffer: true, listedDays: 40 });
  });

  it("flags a weak listing: short title, missing specifics, thin description, few photos, returns refused", () => {
    const weak = {
      ...goodItem,
      Title: "Headphones",
      ItemSpecifics: undefined,
      Description: "Good",
      PictureDetails: { PictureURL: "https://i/1" },
      ConditionDescription: "",
      ReturnPolicy: { ReturnsAcceptedOption: "ReturnsNotAccepted" },
      BestOfferDetails: { BestOfferEnabled: "false" },
    };
    const a = auditListing(weak, {
      aspects: [{ name: "Brand", required: true }, { name: "Model", required: false }, { name: "Colour", required: false }, { name: "Type", required: false }],
      now: NOW,
    });
    const titles = a.findings.map((f) => f.title);
    expect(titles).toEqual(
      expect.arrayContaining(["Returns not accepted", "Short title", "Required item specifics missing", "3 recommended item specifics missing", "Thin description", "1 photo", "No condition note", "Best Offer off"]),
    );
    expect(a.missingRequired).toEqual(["Brand"]);
    expect(a.findings.find((f) => f.title === "Short title")!.fix).toBe("claude");
    expect(a.findings.find((f) => f.title === "Returns not accepted")!.fix).toBe("proposal");
  });

  it("leaves a listing on a business return policy to that policy's finding", () => {
    const onPolicy = { ...goodItem, ReturnPolicy: { ReturnsAcceptedOption: "ReturnsNotAccepted" }, SellerProfiles: { SellerReturnProfile: { ReturnProfileID: "9" } } };
    expect(auditListing(onPolicy, { now: NOW }).findings.map((f) => f.title)).not.toContain("Returns not accepted");
  });

  it("compares the price with the engine's latest decision", () => {
    const pricing = { decision: { strategy: "compete", price: 100, total: 103.5, options: [], why: "Normal market.", confidence: 0.6 } } as any;
    const a = auditListing(goodItem, { pricing, now: NOW });
    expect(a.findings).toEqual([expect.objectContaining({ title: "Above the market by 20%", severity: "high", fix: "proposal" })]);
    const ask = { decision: { strategy: "ask", price: null, total: null, options: [], why: "", confidence: 0, question: "Which model?" } } as any;
    expect(auditListing(goodItem, { pricing: ask, now: NOW }).findings[0]).toMatchObject({ title: "Engine needs your answer", detail: "Which model?", fix: "you" });
  });
});

describe("sold history", () => {
  const rows: SaleRow[] = [
    { title: "A", price: 20, at: Date.parse("2025-03-10"), fees: null, startedAt: Date.parse("2025-03-01"), asked: 25 },
    { title: "B", price: 40, at: Date.parse("2025-03-20"), fees: null, startedAt: null, asked: null },
    { title: "C", price: 30, at: Date.parse("2026-09-01"), fees: 3, startedAt: Date.parse("2026-08-02"), asked: 30 },
  ];

  it("summarises sales, months, days to sell, fees and asking against sold", () => {
    const s = soldSummary(rows);
    expect(s).toMatchObject({ count: 3, revenue: 90, median: 30, first: "2025-03-10", last: "2026-09-01", avgDaysToSell: 19.5, timedSales: 2, feeShare: 0.1 });
    expect(s.byMonth).toEqual([
      { month: "2025-03", sales: 2, revenue: 60 },
      { month: "2026-09", sales: 1, revenue: 30 },
    ]);
    expect(s.top[0]).toMatchObject({ title: "B", price: 40 });
    const f = soldFindings(s).map((x) => x.title);
    expect(f).toContain("1 sold 10%+ under the asking price");
    expect(f).toContain("Fees took 10% of revenue");
  });

  it("reads eBay's sold and unsold lists", () => {
    const doc = parseTradingResponse(
      "GetMyeBaySelling",
      `<GetMyeBaySellingResponse><Ack>Success</Ack>
        <SoldList><OrderTransactionArray><OrderTransaction><Transaction><Item><ItemID>5</ItemID><Title>Sold thing</Title>
          <ListingDetails><StartTime>2026-09-01T00:00:00Z</StartTime></ListingDetails></Item>
          <TransactionPrice currencyID="GBP">15.0</TransactionPrice><CreatedDate>2026-09-20T00:00:00Z</CreatedDate></Transaction></OrderTransaction></OrderTransactionArray></SoldList>
        <UnsoldList><ItemArray><Item><ItemID>6</ItemID><Title>Unsold thing</Title><BuyItNowPrice currencyID="GBP">12.0</BuyItNowPrice>
          <ListingDetails><StartTime>2026-08-01T00:00:00Z</StartTime><EndTime>2026-08-31T00:00:00Z</EndTime></ListingDetails>
          <WatchCount>3</WatchCount><HitCount>80</HitCount></Item></ItemArray></UnsoldList>
      </GetMyeBaySellingResponse>`,
    );
    expect(toSold(doc)).toEqual([{ itemId: "5", title: "Sold thing", price: 15, soldAt: "2026-09-20T00:00:00Z", startTime: "2026-09-01T00:00:00Z" }]);
    const [u] = toUnsold(doc);
    expect(u).toMatchObject({ itemId: "6", price: 12, watchers: 3, views: 80 });
    expect(unsoldReason(u, NOW)).toMatchObject({ days: 30, likely: expect.stringMatching(/price was probably a little high/) });
    expect(unsoldReason({ ...u, watchers: 0, views: 5 }, NOW).likely).toMatch(/weren't finding it/);
    expect(unsoldReason({ ...u, watchers: 0, views: 60 }, NOW).likely).toMatch(/photos/);
  });
});

describe("settings", () => {
  it("reads business policies and checks K's return rule", () => {
    const p = toPolicies(
      {
        returnPolicies: [
          { returnPolicyId: "r1", name: "Returns 30", returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "BUYER" },
          { returnPolicyId: "r2", name: "No returns", returnsAccepted: false },
          { returnPolicyId: "r3", name: "Free returns", returnsAccepted: true, returnPeriod: { value: 1, unit: "MONTH" }, returnShippingCostPayer: "SELLER" },
        ],
      },
      { fulfillmentPolicies: [{ fulfillmentPolicyId: "f1", name: "RM 2nd", handlingTime: { value: 5, unit: "DAY" }, shippingOptions: [{ optionType: "DOMESTIC", shippingServices: [{ shippingServiceCode: "UK_RoyalMailSecondClassStandard", shippingCost: { value: "3.20" } }] }] }] },
      { paymentPolicies: [{ paymentPolicyId: "p1", name: "Pay", immediatePay: true }] },
    );
    expect(p.returns[2]).toEqual({ id: "r3", name: "Free returns", accepted: true, periodDays: 30, buyerPaysReturnPostage: false });
    expect(p.postage[0]).toMatchObject({ handlingDays: 5, services: [{ service: "UK_RoyalMailSecondClassStandard", cost: 3.2, free: false }] });
    const f = settingsFindings(p, toSeller({ User: { UserID: "k", SellerInfo: { SellerBusinessType: "Commercial" } } }));
    expect(f.map((x) => [x.severity, x.title])).toEqual([
      ["high", 'Return policy "No returns" doesn\'t accept returns'],
      ["high", 'Return policy "Free returns": you pay return postage'],
      ["low", 'Postage policy "RM 2nd": 5-day handling'],
      ["high", "Registered as a business seller"],
    ]);
  });

  it("reads the aspects eBay requires or recommends", () => {
    expect(
      toAspects({
        aspects: [
          { localizedAspectName: "Brand", aspectConstraint: { aspectRequired: true, aspectUsage: "RECOMMENDED" } },
          { localizedAspectName: "Colour", aspectConstraint: { aspectRequired: false, aspectUsage: "RECOMMENDED" } },
          { localizedAspectName: "Obscure", aspectConstraint: { aspectRequired: false, aspectUsage: "OPTIONAL" } },
        ],
      }),
    ).toEqual([
      { name: "Brand", required: true },
      { name: "Colour", required: false },
    ]);
  });

  it("ranks the most important findings first", () => {
    const r = rankFindings([
      { area: "listing", severity: "low", title: "a", detail: "", fix: "you" },
      { area: "listing", severity: "high", title: "b", detail: "", fix: "claude" },
      { area: "listing", severity: "medium", title: "c", detail: "", fix: "you" },
    ]);
    expect(r.map((x) => x.title)).toEqual(["b", "c", "a"]);
  });
});
