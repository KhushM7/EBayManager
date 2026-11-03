import { describe, expect, it } from "vitest";
import {
  charmPrice,
  decide,
  endPrice,
  weightedQuantile,
  fitParams,
  hazard,
  marketState,
  outcomesFromSnapshots,
  theilSen,
  type MarketSale,
  type Outcome,
} from "../src/pricing/model";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3);
// A tiny deterministic random source, so the synthetic markets are the same every run.
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);

/** Sales every `every` days over `days`, price from `level(ageDays)` with ±5% noise. */
function history(days: number, every: number, level: (age: number) => number, seed = 1): MarketSale[] {
  const r = rng(seed);
  const out: MarketSale[] = [];
  for (let age = 1; age <= days; age += every) out.push({ total: Math.round(level(age) * (0.95 + r() * 0.1) * 100) / 100, at: NOW - age * DAY });
  return out;
}
const active = (n: number, at: number) => Array.from({ length: n }, (_, i) => ({ total: at + i }));
const costs = { postage: 4 };

describe("market state", () => {
  it("finds a steady market normal, with recent and long-run prices agreeing", () => {
    const m = marketState(history(400, 3, () => 40), active(10, 38), { now: NOW });
    expect(m.regime).toBe("normal");
    expect(m.mNow).toBeGreaterThan(38);
    expect(m.mNow).toBeLessThan(42);
    expect(Math.abs(m.mLong! - 40)).toBeLessThan(1.5);
    expect(m.weeksOfSupply).toBeGreaterThan(3);
  });

  it("measures depreciation and calls a steep one a decline", () => {
    // Loses 8% a month.
    const m = marketState(history(300, 3, (age) => 40 * Math.exp((Math.log(0.92) / 30) * -age)), active(5, 30), { now: NOW });
    expect(m.trend30).toBeCloseTo(-0.08, 1);
    expect(m.regime).toBe("decline");
  });

  it("calls a flooded, crashed market a race to the bottom, and sees past dips recover", () => {
    // Usual £40; a dip to £30 from 30 to 18 weeks ago that recovered; today £31 with 40 listed.
    const level = (age: number) => (age < 21 ? 31 : age > 126 && age < 210 ? 30 : 40);
    const m = marketState(history(500, 2, level), active(40, 30), { now: NOW });
    expect(m.regime).toBe("race_to_bottom");
    expect(m.dip).toBeGreaterThan(0.15);
    expect(m.recoveryDays).toBeGreaterThan(50);
    expect(m.recoveryDays).toBeLessThan(120);
  });

  it("is thin with under 3 sales in 90 days", () => {
    expect(marketState(history(400, 60, () => 40), [], { now: NOW }).regime).toBe("thin");
  });

  it("ignores one mismatched outlier", () => {
    const sales = [...history(60, 3, () => 40), { total: 900, at: NOW - 2 * DAY }];
    expect(marketState(sales, [], { now: NOW }).mNow).toBeLessThan(42);
  });
});

describe("sale model", () => {
  it("sells faster when cheaper, and at the market price gets a fair share", () => {
    const fair = hazard(40, 40, 1, 9);
    expect(fair).toBeCloseTo(0.1, 5);
    expect(hazard(36, 40, 1, 9)).toBeGreaterThan(fair);
    expect(hazard(44, 40, 1, 9)).toBeLessThan(fair);
  });
});

describe("decide", () => {
  it("competes at the cheaper end of current sales, above the value floor", () => {
    const m = marketState(history(400, 3, () => 40), active(10, 38), { now: NOW });
    const d = decide({ market: m, costs });
    expect(d.strategy).toBe("compete");
    expect(d.total!).toBeGreaterThanOrEqual(m.p25! - 0.6);
    expect(d.total!).toBeLessThanOrEqual(m.mNow! + 0.5);
    expect(d.total!).toBeGreaterThanOrEqual(m.valueFloor! - 0.6);
    expect(d.options).toHaveLength(3);
    expect(d.options[0].daysToSell).toBeLessThanOrEqual(d.options[2].daysToSell);
  });

  it("holds out at a higher price in a temporary race to the bottom", () => {
    const level = (age: number) => (age < 21 ? 31 : age > 126 && age < 210 ? 30 : 40);
    const m = marketState(history(500, 2, level), active(40, 30), { now: NOW });
    const d = decide({ market: m, costs });
    expect(d.strategy).toBe("hold");
    expect(d.total!).toBeGreaterThan(m.mNow! * 1.1);
    expect(d.why).toMatch(/Holding/);
  });

  it("doesn't hold for a dip with no history of recovering", () => {
    const m = marketState(history(500, 2, (age) => (age < 21 ? 31 : 40)), active(40, 30), { now: NOW });
    expect(m.regime).toBe("race_to_bottom");
    expect(m.recoveryDays).toBeNull();
    expect(decide({ market: m, costs }).strategy).toBe("compete");
  });

  it("clears in a structural decline", () => {
    const m = marketState(history(300, 3, (age) => 40 * Math.exp((Math.log(0.92) / 30) * -age)), active(5, 30), { now: NOW });
    expect(decide({ market: m, costs }).strategy).toBe("clear");
  });

  it("asks K when there's nothing to go on", () => {
    const d = decide({ market: marketState([], [], { now: NOW }), costs });
    expect(d.strategy).toBe("ask");
    expect(d.price).toBeNull();
    expect(d.question).toBeTruthy();
  });

  it("never goes below K's floor and moves at most 10% a step", () => {
    const m = marketState(history(400, 3, () => 40), active(10, 38), { now: NOW });
    expect(decide({ market: m, costs, floor: 39 }).price!).toBeGreaterThanOrEqual(39);
    const capped = decide({ market: m, costs, current: 60 });
    expect(capped.price).toBe(54);
    expect(capped.why).toMatch(/step limit/);
  });
});

describe("learning", () => {
  it("recovers how price-sensitive buyers are from sold and unsold outcomes", () => {
    const r = rng(7);
    const truth = { tau: 0.15, alpha: 1.5 };
    const outcomes: Outcome[] = [];
    for (let i = 0; i < 400; i++) {
      const rel = 0.8 + r() * 0.5;
      const share = 0.05;
      const h = share * truth.alpha * (2 / (1 + Math.exp((rel - 1) / truth.tau)));
      const t = -Math.log(1 - r()) / h;
      outcomes.push(t <= 30 ? { rel, days: t, sold: true, share } : { rel, days: 30, sold: false, share });
    }
    const fit = fitParams(outcomes, undefined, 0);
    expect(fit.tau).toBeGreaterThan(0.1);
    expect(fit.tau).toBeLessThan(0.21);
    expect(fit.alpha).toBeGreaterThan(1.2);
    expect(fit.alpha).toBeLessThan(1.9);
  });

  it("stays at the prior with little data, and shrinks toward it with some", () => {
    expect(fitParams([{ rel: 1, days: 3, sold: true, share: 0.1 }])).toEqual({ tau: 0.08, alpha: 1, n: 1 });
  });

  it("reads gone listings between snapshots as probable sales", () => {
    const o = outcomesFromSnapshots([{ itemId: "a", total: 30 }, { itemId: "b", total: 50 }], [{ itemId: "b" }], 7, 40, 0.1);
    expect(o).toEqual([
      { rel: 0.75, days: 7, sold: true, share: 0.1 },
      { rel: 1.25, days: 7, sold: false, share: 0.1 },
    ]);
  });
});

describe("helpers", () => {
  it("Theil–Sen ignores an outlier", () => {
    const pts = [0, 1, 2, 3, 4, 5].map((x) => ({ x, y: 2 * x }));
    pts.push({ x: 6, y: 100 });
    expect(theilSen(pts)).toBe(2);
  });

  it("ends prices by strategy: precise to hold, round to clear", () => {
    expect(endPrice(41.97, "hold")).toBe(41.85);
    expect(endPrice(42.3, "hold")).toBe(42.3);
    expect(endPrice(37.6, "clear")).toBe(37);
    expect(endPrice(63, "clear")).toBe(60);
    expect(endPrice(34.7, "compete")).toBe(34.49);
  });

  it("weights evidence", () => {
    expect(weightedQuantile([{ v: 10, w: 1 }, { v: 20, w: 1 }], 0.5)).toBe(15);
    expect(weightedQuantile([{ v: 10, w: 3 }, { v: 20, w: 1 }], 0.5)!).toBeLessThan(15);
    expect(weightedQuantile([], 0.5)).toBeNull();
  });

  it("charm-prices", () => {
    expect(charmPrice(12.3)).toBe(11.99);
    expect(charmPrice(12.7)).toBe(12.99);
    expect(charmPrice(34.7)).toBe(34.49);
    expect(charmPrice(34.3)).toBe(33.99);
  });
});
