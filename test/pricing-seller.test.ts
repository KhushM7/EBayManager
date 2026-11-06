import { describe, expect, it } from "vitest";
import { charmBelow, decide, marketState, sellerTarget, type MarketSale } from "../src/pricing/model";

// K's way of pricing (2026-11-06), on the air fryer that started it: two new sales at £28.12 and £37.73, one used
// sale at £12.79. Prices are totals (free postage here, so item price = total).

const DAY = 86_400_000;
const now = Date.parse("2026-11-06T12:00:00Z");
const sale = (total: number, daysAgo: number): MarketSale => ({ total, at: now - daysAgo * DAY });
const newSales = [sale(28.12, 171), sale(37.73, 48)];

function price(sold: MarketSale[], active: number[], opts: { usedToo?: boolean; floor?: number } = {}) {
  // What the engine hands over: the market from same-condition sales, and the same-condition evidence.
  const mk = marketState(sold, active.map((total) => ({ total })), { now });
  return decide({ market: mk, costs: { postage: 0 }, floor: opts.floor ?? null, evidence: { sold: sold.map((s) => ({ total: s.total, at: s.at })), active } });
}

describe("the seller's rule", () => {
  it("prices between two same-condition sales when nothing is listed", () => {
    const d = price(newSales, []);
    expect(d.price).toBeGreaterThan(28.12);
    expect(d.price).toBeLessThan(37.73);
    expect(d.price).toBe(32.49); // the middle (£32.93), at a .49 ending below it
    expect(d.why).toMatch(/2 sales in the same condition at £28.12 to £37.73, and nothing listed/);
  });

  it("goes just under the cheapest realistic listing, even above past sales", () => {
    const d = price(newSales, [39.99, 42]);
    expect(d.price).toBeLessThan(39.99);
    expect(d.price).toBeGreaterThanOrEqual(38.99);
    expect(d.why).toMatch(/just under the cheapest of 2 listings in the same condition \(£39\.99\)/);
  });

  it("goes just under a cheaper listing too, down to the lowest sale", () => {
    expect(price(newSales, [31.5]).price).toBe(30.99);
  });

  it("ignores listings far above what buyers pay, and prices at what they pay", () => {
    const d = price(newSales, [55, 60]);
    expect(d.price).toBe(32.49);
    expect(d.why).toMatch(/2 listings above £43\.39 ignored as more than buyers pay/);
  });

  it("ignores only the overpriced ones when listings are mixed", () => {
    expect(price(newSales, [36, 59.99]).price).toBe(35.49);
  });

  it("won't chase a listing below the lowest same-condition sale", () => {
    const d = price(newSales, [22]);
    expect(d.price).toBe(27.99); // held at the lowest sale (£28.12), at its ending
    expect(d.why).toMatch(/cheapest listing \(£22\.00\) is below the lowest of those, so this holds at £28\.12/);
  });

  it("prices from listings alone when nothing has sold, just under the cheapest", () => {
    const d = price([], [30, 32.5, 70]);
    expect(d.strategy).toBe("compete");
    expect(d.price).toBe(29.49);
    expect(d.confidence).toBeLessThan(0.2);
    expect(d.why).toMatch(/No sales found, but 2 listed/);
  });

  it("still asks when there's nothing at all", () => {
    expect(price([], []).strategy).toBe("ask");
  });

  it("never prices below K's floor", () => {
    expect(price(newSales, [31.5], { floor: 33 }).price).toBe(33);
  });

  it("uses the recent median and lower quartile when there are many sales", () => {
    const many = Array.from({ length: 12 }, (_, i) => sale(30 + (i % 4), 5 + i * 6));
    const t = sellerTarget({ sold: many.map((s) => ({ total: s.total, at: s.at })), active: [] }, marketState(many, [], { now }))!;
    expect(t.basis).toBe("sales");
    expect(t.value).toBeGreaterThanOrEqual(30);
    expect(t.value).toBeLessThanOrEqual(33);
  });

  it("doesn't fit a trend through a handful of sales", () => {
    // Three sales falling fast would have projected a lower price today; with under 6 there's no trend.
    expect(marketState([sale(40, 200), sale(30, 100), sale(25, 10)], [], { now }).trend30).toBeNull();
  });

  it("ends a price below the listing it undercuts", () => {
    expect(charmBelow(39.49, 39.99)).toBe(39.49);
    expect(charmBelow(19.6, 19.99)).toBeLessThan(19.99);
    expect(charmBelow(12.6, 12.9)).toBeLessThan(12.9);
  });
});
