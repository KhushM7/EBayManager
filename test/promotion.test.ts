import { beforeEach, describe, expect, it } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import type { MarketState } from "../src/pricing/model";
import { isSaturated, PROMO, promotionAdvice, proposedRate, proposePromotions, type PromotionInput } from "../src/promotion";
import { toRecommendations } from "../src/ebay/sell";
import { LOCKED_KINDS } from "../src/rules";

const market = (over: Partial<MarketState> = {}): MarketState => ({
  sales: 20,
  effective: 20,
  mNow: 30,
  mLong: 31,
  valueFloor: 25,
  trend30: -0.01,
  p25: 27,
  p75: 33,
  demand28: 0.1,
  demand91: 0.1,
  supply: 40,
  cheapest: 26,
  weeksOfSupply: 57,
  dip: 0.03,
  recoveryDays: null,
  regime: "normal",
  why: "",
  ...over,
});

const input = (over: Partial<PromotionInput> = {}): PromotionInput => ({
  price: 27,
  postage: 3,
  floor: null,
  listedDays: 45,
  views7d: 10,
  impressions7d: 300,
  market: market(),
  suggestedRate: 8,
  ebayRecommends: true,
  currentRate: null,
  ...over,
});

describe("the proposed ad rate", () => {
  it("is 40% of eBay's suggestion, in half points, between 2% and 4%, and never over half the suggestion", () => {
    expect(proposedRate(8)).toBe(3);
    expect(proposedRate(12)).toBe(4);
    expect(proposedRate(5)).toBe(2);
    expect(proposedRate(4)).toBe(2);
    expect(proposedRate(3.5)).toBeNull(); // half is 1.75%, under eBay's minimum
    expect(proposedRate(null)).toBe(PROMO.minRate);
    for (const s of [4, 5, 6, 7, 8, 9, 10, 15, 20]) expect(proposedRate(s)!).toBeLessThanOrEqual(s / 2);
  });
});

describe("saturation", () => {
  it("needs weeks of supply over the mark, or many listings when there are no recent sales, and never a thin market", () => {
    expect(isSaturated(market())).toBe(true);
    expect(isSaturated(market({ weeksOfSupply: 3 }))).toBe(false);
    expect(isSaturated(market({ weeksOfSupply: null, supply: 12 }))).toBe(true);
    expect(isSaturated(market({ weeksOfSupply: null, supply: 3 }))).toBe(false);
    expect(isSaturated(market({ regime: "thin" }))).toBe(false);
    expect(isSaturated(null)).toBe(false);
  });
});

describe("promotion advice", () => {
  it("promotes a slow listing in a saturated market when the rate pays back, below eBay's suggestion", () => {
    const a = promotionAdvice(input());
    expect(a.action).toBe("promote");
    expect(a.rate).toBe(3);
    expect(a.rate!).toBeLessThanOrEqual(8 / 2);
    expect(a.payback!.valuePromoted).toBeGreaterThan(a.payback!.valueNow);
    expect(a.payback!.daysPromoted).toBeLessThan(a.payback!.daysNow);
    expect(a.why).toMatch(/eBay suggests 8%/);
  });

  it("doesn't promote in a thin or unsaturated market", () => {
    expect(promotionAdvice(input({ market: market({ regime: "thin" }) })).action).toBe("none");
    expect(promotionAdvice(input({ market: market({ weeksOfSupply: 2 }) })).action).toBe("none");
    expect(promotionAdvice(input({ market: null })).action).toBe("none");
  });

  it("waits on a new listing that's being seen", () => {
    expect(promotionAdvice(input({ listedDays: 10, impressions7d: 500 })).action).toBe("none");
    // ...but a new listing hardly anyone sees can be promoted.
    expect(promotionAdvice(input({ listedDays: 10, impressions7d: 40 })).action).toBe("promote");
  });

  it("doesn't promote when the rate doesn't pay back (a fast-selling market)", () => {
    const fast = market({ demand28: 3, demand91: 3, weeksOfSupply: 6.5, supply: 140 });
    const a = promotionAdvice(input({ market: fast }));
    expect(a.action).toBe("none");
    expect(a.why).toMatch(/doesn't cover/);
  });

  it("never lets the ad fee take the sale under K's floor", () => {
    const a = promotionAdvice(input({ floor: 26.5 }));
    expect(a.action).toBe("none");
    expect(a.why).toMatch(/floor/);
  });

  it("says no when half of eBay's suggestion is under the minimum", () => {
    expect(promotionAdvice(input({ suggestedRate: 3 })).action).toBe("none");
  });

  it("lowers an ad rate that's too high, and ends one that can't pay", () => {
    expect(promotionAdvice(input({ currentRate: 9 }))).toMatchObject({ action: "lower", rate: 3 });
    expect(promotionAdvice(input({ currentRate: 3 })).action).toBe("none");
    expect(promotionAdvice(input({ currentRate: 5, market: market({ regime: "thin" }) })).action).toBe("end");
  });
});

describe("eBay's ad suggestions", () => {
  it("reads the item rate and eBay's recommendation", () => {
    const recs = toRecommendations({
      listingRecommendations: [
        { listingId: "1", marketing: { ad: { bidPercentages: [{ basis: "TRENDING", value: "6.1" }, { basis: "ITEM", value: "7.5" }], promoteWithAd: "RECOMMENDED" } } },
        { listingId: "2", marketing: { ad: { promoteWithAd: "UNDETERMINED" } } },
      ],
    });
    expect(recs).toEqual([
      { listingId: "1", suggestedRate: 7.5, recommended: true },
      { listingId: "2", suggestedRate: null, recommended: false },
    ]);
  });
});

describe("promotion proposals", () => {
  let env: Env;
  beforeEach(() => {
    env = { DB: fakeD1(), EBAY_ENV: "production", WRITE_MODE: "off", NTFY_TOPIC: "" } as Env;
  });

  it("files a locked promote proposal, once, as a dry run while writes are off", async () => {
    const found = [{ itemId: "111", title: "Thing", advice: promotionAdvice(input()), suggestedRate: 8, ebayRecommends: true, currentRate: null }];
    expect(await proposePromotions(env, found)).toBe(1);
    expect(await proposePromotions(env, found)).toBe(0);
    const p = await env.DB.prepare("SELECT * FROM proposals").first<any>();
    expect(p).toMatchObject({ kind: "promote", item_id: "111", dry_run: 1 });
    expect(JSON.parse(p.payload)).toMatchObject({ action: "promote", rate: 3, suggestedRate: 8, campaign: "General (cost per sale)" });
    expect(LOCKED_KINDS).toContain("promote");
  });

  it("files nothing for advice of none", async () => {
    const found = [{ itemId: "1", title: "T", advice: promotionAdvice(input({ market: null })), suggestedRate: null, ebayRecommends: null, currentRate: null }];
    expect(await proposePromotions(env, found)).toBe(0);
  });
});
