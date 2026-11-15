import { describe, expect, it } from "vitest";
import { decide, endNear, marketState, type Decision, type MarketSale, type MarketState } from "../src/pricing/model";

// 2026-11-15: two price screens whose cards and text disagreed. The cheaper option was held up to a floor the
// recommended price ignored (so "sells sooner" was the dearest card), and the text was written before the floor
// and the price ending moved the price. Now there's one floor, the options always ascend, and the reason is
// written for the price chosen, as an item price (the buyer pays postage on top).

const DAY = 86_400_000;
const now = Date.parse("2026-11-15T12:00:00Z");
const sale = (total: number, daysAgo: number, weight?: number): MarketSale => ({ total, at: now - daysAgo * DAY, weight });

function ordered(d: Decision) {
  expect(d.options).toHaveLength(3);
  expect(d.options[0].price).toBeLessThanOrEqual(d.options[1].price);
  expect(d.options[1].price).toBeLessThan(d.options[2].price);
  expect(d.options[1].price).toBe(d.price);
}

describe("the price, its options and its reason agree", () => {
  it("listings only, with a couple of dearer close sales: the cheaper option is never above the recommended", () => {
    const mk = marketState([sale(5.54, 20, 0.35), sale(6.2, 40, 0.35)], [{ total: 4.6 }, { total: 5.2 }], { now });
    const d = decide({ market: mk, costs: { postage: 2.26 }, evidence: { sold: [], active: [4.6, 5.2] } });
    expect(d.price).toBe(1.99);
    ordered(d);
    // Text in item prices: the £4.60 listing is £2.34 before postage.
    expect(d.why).toMatch(/2 listed in the same condition from £2\.34/);
  });

  it("holding at the cheaper end of many sales: the text names the price on the card", () => {
    const sold = Array.from({ length: 97 }, (_, i) => ({ total: i === 0 ? 4 : i === 96 ? 30.24 : 10, at: now }));
    const mk = { sales: 97, effective: 97, mNow: 10.5, mLong: 10.8, valueFloor: 7.565, trend30: 0, p25: 7.42, p75: 13, demand28: 0.2, demand91: 0.2, supply: 40, cheapest: 7.16, weeksOfSupply: 28, dip: 0.03, recoveryDays: null, regime: "normal", why: "" } as MarketState;
    const d = decide({ market: mk, costs: { postage: 2.89 }, evidence: { sold, active: [7.16, 9, 11] } });
    // £7.42 less £2.89 postage is £4.53; the nearest ending is £4.49, not £4.99 lifted by a second floor.
    expect(d.price).toBe(4.49);
    expect(d.why).toContain(`so this holds at £${d.price!.toFixed(2)} rather than chasing it down`);
    expect(d.why).toMatch(/cheapest listing \(£4\.27\)/);
    ordered(d);
    // Nothing cheaper is offered below the level it holds at: the first two options are the same price.
    expect(d.options[0].price).toBe(d.options[1].price);
  });

  it("says where each option sits among the listings and sales", () => {
    const sales = [sale(28.12, 171), sale(37.73, 48)];
    const d = decide({ market: marketState(sales, [{ total: 39.99 }, { total: 42 }], { now }), costs: { postage: 0 }, evidence: { sold: sales, active: [39.99, 42] } });
    expect(d.options[1].position).toEqual({ listed: 2, dearer: 2, sold: 2, soldAtOrAbove: 0 });
    ordered(d);
  });

  it("says when K's floor lifted the price", () => {
    const sales = [sale(28.12, 171), sale(37.73, 48)];
    const d = decide({ market: marketState(sales, [{ total: 31.5 }], { now }), costs: { postage: 0 }, floor: 33, evidence: { sold: sales, active: [31.5] } });
    expect(d.price).toBe(33);
    expect(d.why).toMatch(/Raised to your floor of £33\.00/);
    ordered(d);
  });
});

describe("nothing in the same condition", () => {
  // A used item where only new ones sold and are listed: each comparable was already adjusted to it (x0.7).
  const adjustedSales = [sale(21, 30, 0.35), sale(24.5, 60, 0.35), sale(28, 90, 0.35)];
  const adjustedListings = [26.6, 28];

  it("prices from the adjusted comparables, says so, and lowers its confidence", () => {
    const mk = marketState(adjustedSales, adjustedListings.map((total) => ({ total, weight: 0.35 })), { now });
    const d = decide({ market: mk, costs: { postage: 0 }, evidence: { sold: adjustedSales, active: adjustedListings, soldBasis: "adjusted", activeBasis: "adjusted" } });
    expect(d.strategy).toBe("compete");
    expect(d.price!).toBeLessThan(26.6);
    expect(d.price!).toBeGreaterThanOrEqual(21);
    expect(d.why).toMatch(/Nothing sold or listed in the same condition/);
    expect(d.why).toMatch(/set your own price if the adjustment looks wrong/);
    expect(d.confidence).toBeLessThan(0.3);
    ordered(d);
  });

  it("uses one or two adjusted sales rather than calling it 'no sales found'", () => {
    const two = [sale(5.54, 20, 0.35), sale(6.2, 40, 0.35)];
    const d = decide({ market: marketState(two, [], { now }), costs: { postage: 0 }, evidence: { sold: two, active: [], soldBasis: "adjusted" } });
    expect(d.strategy).toBe("compete");
    expect(d.why).toMatch(/2 close or different-condition sales/);
    ordered(d);
  });
});

describe("endNear", () => {
  it("takes the nearest .49 or .99, up or down", () => {
    expect(endNear(4.53)).toBe(4.49);
    expect(endNear(28.12)).toBe(27.99);
    expect(endNear(4.8)).toBe(4.99);
  });
});
