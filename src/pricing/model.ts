// The pricing engine's maths (docs/pricing-engine.md). Pure functions only: no I/O, so every step is tested
// and explainable. Prices here are totals the buyer pays (item + postage), GBP.

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface MarketSale {
  /** Total paid: item price + postage. */
  total: number;
  /** Sale time, ms. */
  at: number;
  /** An accepted Best Offer whose real price is known. */
  bestOffer?: boolean;
  /** Evidence weight: 1 for an exact match, less for a close match (already adjusted to K's item). */
  weight?: number;
}

export interface ActiveListing {
  total: number;
  weight?: number;
}

/** Weighted quantile: the value below which a share q of the total weight lies (interpolated). */
export function weightedQuantile(items: { v: number; w: number }[], q: number): number | null {
  const xs = items.filter((x) => x.w > 0 && Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0].v;
  const total = xs.reduce((s, x) => s + x.w, 0);
  // Midpoint rule: each item sits at the middle of its weight.
  let acc = 0;
  const pos = xs.map((x) => {
    const p = (acc + x.w / 2) / total;
    acc += x.w;
    return p;
  });
  if (q <= pos[0]) return xs[0].v;
  if (q >= pos[pos.length - 1]) return xs[xs.length - 1].v;
  const k = pos.findIndex((p) => p >= q);
  const t = (q - pos[k - 1]) / (pos[k] - pos[k - 1]);
  return xs[k - 1].v + t * (xs[k].v - xs[k - 1].v);
}

const w = (x: { weight?: number }) => x.weight ?? 1;
const sumW = (xs: { weight?: number }[]) => xs.reduce((s, x) => s + w(x), 0);

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

/** Theil–Sen slope: the median of pairwise slopes. Robust to the odd mismatched sale. Units: y per day. */
export function theilSen(points: { x: number; y: number }[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (Math.abs(dx) >= 1) slopes.push((points[j].y - points[i].y) / dx);
    }
  return slopes.length >= 3 ? median(slopes) : null;
}

/**
 * Drops prices far outside the rest, so a mismatched £900 bundle can't move the market. The fence is at least
 * 35% of the median wide, so a real market dip (prices 20% lower for a while) is kept, not trimmed away.
 */
export function withoutOutliers<T extends { total: number }>(xs: T[]): T[] {
  const s = xs.map((x) => x.total).sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  if (q1 == null || q3 == null || xs.length < 4) return xs;
  const k = Math.max(1.5 * (q3 - q1), 0.35 * quantile(s, 0.5)!);
  return xs.filter((x) => x.total >= q1 - k && x.total <= q3 + k);
}

export type Regime = "normal" | "race_to_bottom" | "decline" | "thin";

export interface MarketState {
  /** Matched sales used, after outliers. */
  sales: number;
  /** Effective number of sales: exact matches count 1, close matches less. */
  effective: number;
  /** Recent clearing price: median of the last 30 days (60 or 90 if thin). */
  mNow: number | null;
  /** Long-run price brought to today's value (depreciation removed), seasonally neutral. */
  mLong: number | null;
  /** Lower quartile of long-run prices at today's value: below this, value is harmed. */
  valueFloor: number | null;
  /** Depreciation per 30 days, as a fraction (-0.03 = loses 3% a month). */
  trend30: number | null;
  /** Interquartile range of recent sales. */
  p25: number | null;
  p75: number | null;
  /** Matched sales per day over the last 28 days and the last 91. */
  demand28: number;
  demand91: number;
  /** Matched active listings, and the cheapest. */
  supply: number;
  cheapest: number | null;
  /** Weeks of supply at the recent sales rate; null with no recent sales. */
  weeksOfSupply: number | null;
  /** How far today's price sits below the long-run price (0.15 = 15% below). */
  dip: number | null;
  /** Typical days for a dip to recover, from this product's own history; null if it never recovered. */
  recoveryDays: number | null;
  regime: Regime;
  /** One line for K. */
  why: string;
}

export interface MarketOptions {
  now?: number;
  /** A dip deeper than this counts as a race to the bottom. */
  dipThreshold?: number;
  /** A monthly loss steeper than this counts as structural decline. */
  declineThreshold?: number;
}

/**
 * Splits a product's sold history into trend (depreciation), level and today's shock, then classifies the
 * market. Weekly medians of de-trended prices give the history of dips; a dip that, in the past, came back
 * within ~4 months marks today's dip as temporary.
 */
export function marketState(salesIn: MarketSale[], active: ActiveListing[], opts: MarketOptions = {}): MarketState {
  const now = opts.now ?? Date.now();
  const dipThreshold = opts.dipThreshold ?? 0.12;
  const declineThreshold = opts.declineThreshold ?? 0.06;
  const sales = withoutOutliers(salesIn.filter((s) => s.total > 0 && s.at <= now && s.at > now - 730 * DAY));
  const ageDays = (s: MarketSale) => (now - s.at) / DAY;
  const within = (d: number) => sales.filter((s) => ageDays(s) <= d);

  // The trend comes from history before today's market, so a current dip isn't mistaken for depreciation
  // (and then explained away). With little history, all sales are used.
  const older = sales.filter((s) => ageDays(s) > 45);
  // A trend through a handful of sales is noise (2026-11-06: three sales made a steep "trend" that put an air
  // fryer under both of its new sales), so it needs at least 6 sales' worth of evidence.
  const slope = sumW(sales) >= 6 ? theilSen((older.length >= 10 ? older : sales).map((s) => ({ x: -ageDays(s), y: Math.log(s.total) }))) : null;
  // Bring each sale to today's value: log price + slope * age.
  const today = (s: MarketSale) => s.total * Math.exp((slope ?? 0) * ageDays(s));
  const trend30 = slope == null ? null : Math.exp(slope * 30) - 1;

  // The recent window widens until it holds 3 sales' worth of evidence. Where even 180 days is thin, all
  // history is used, each sale brought to today's value by the trend.
  let recent = within(30);
  for (const d of [60, 90, 180]) if (sumW(recent) < 3) recent = within(d);
  const thinNow = sumW(recent) < 3;
  const recentPts = (thinNow ? sales.map((s) => ({ v: today(s), w: w(s) })) : recent.map((s) => ({ v: s.total, w: w(s) })));
  const mNow = weightedQuantile(recentPts, 0.5);

  const longRun = sales.filter((s) => ageDays(s) > 45);
  const base = (sumW(longRun) >= 5 ? longRun : sales).map((s) => ({ v: today(s), w: w(s) }));
  const mLong = weightedQuantile(base, 0.5);
  const valueFloor = weightedQuantile(base, 0.25);

  const demand28 = sumW(within(28)) / 28;
  const demand91 = sumW(within(91)) / 91;
  const activeTotals = active.filter((a) => a.total > 0).map((a) => a.total).sort((a, b) => a - b);
  const supply = sumW(active.filter((a) => a.total > 0));
  const rate = demand28 > 0 ? demand28 : demand91;
  const weeksOfSupply = rate > 0 ? supply / (rate * 7) : null;

  const dip = mNow != null && mLong != null && mLong > 0 ? (mLong - mNow) / mLong : null;
  const recoveryDays = pastRecovery(sales.map((s) => ({ at: s.at, v: today(s) })), mLong, dipThreshold, now);

  let regime: Regime = "normal";
  let why: string;
  const gbp = (x: number | null) => (x == null ? "?" : `£${x.toFixed(2)}`);
  const n90 = sumW(within(90));
  if (n90 < 3) {
    regime = "thin";
    why =
      `Few sales of this item (${Math.round(sumW(sales) * 10) / 10} matches' worth in 2 years, ${Math.round(n90 * 10) / 10} in 90 days), so the price leans on older and close matches: about ${gbp(mNow)} today.`;
  } else if (trend30 != null && trend30 <= -declineThreshold) {
    regime = "decline";
    why = `Value is falling about ${Math.round(-trend30 * 100)}% a month (newer models or fading demand), so waiting costs money.`;
  } else if (dip != null && dip >= dipThreshold && (weeksOfSupply == null || weeksOfSupply > 2)) {
    regime = "race_to_bottom";
    why =
      `Sales are clearing at ${gbp(mNow)}, ${Math.round(dip * 100)}% below the usual ${gbp(mLong)}, with ${listed(supply)} listed` +
      (recoveryDays != null ? `; past dips recovered in about ${Math.round(recoveryDays / 7)} weeks.` : "; past dips haven't clearly recovered.");
  } else {
    why =
      `Sales clear at ${gbp(mNow)} (usual ${gbp(mLong)}), ${listed(supply)} listed` +
      (weeksOfSupply != null ? `, about ${weeksOfSupply.toFixed(1)} weeks of supply.` : ".");
  }

  return {
    sales: sales.length,
    effective: Math.round(sumW(sales) * 10) / 10,
    mNow: mNow == null ? null : r2(mNow),
    mLong: mLong == null ? null : r2(mLong),
    valueFloor: valueFloor == null ? null : r2(valueFloor),
    trend30: trend30 == null ? null : Math.round(trend30 * 1000) / 1000,
    p25: weightedQuantile(recentPts, 0.25),
    p75: weightedQuantile(recentPts, 0.75),
    demand28,
    demand91,
    supply,
    cheapest: activeTotals[0] ?? null,
    weeksOfSupply: weeksOfSupply == null ? null : Math.round(weeksOfSupply * 10) / 10,
    dip: dip == null ? null : Math.round(dip * 1000) / 1000,
    recoveryDays,
    regime,
    why,
  };
}

/**
 * From weekly medians of de-trended prices, find earlier dips below (1 - threshold) of the long-run level and
 * how many days each took to get back within half the threshold. Returns the median recovery, or null when no
 * earlier dip is seen or none recovered (then a dip is treated as possibly structural).
 */
export function pastRecovery(points: { at: number; v: number }[], level: number | null, threshold: number, now: number): number | null {
  if (level == null || points.length < 8) return null;
  const weeks = new Map<number, number[]>();
  for (const p of points) {
    const w = Math.floor((now - p.at) / (7 * DAY));
    if (w < 6) continue; // the current dip isn't history yet
    weeks.set(w, [...(weeks.get(w) ?? []), p.v]);
  }
  const series = [...weeks.entries()].sort((a, b) => b[0] - a[0]).map(([w, vs]) => ({ w, m: median(vs)! }));
  const recoveries: number[] = [];
  let dipStart: number | null = null;
  for (const { w, m } of series) {
    const gap = (level - m) / level;
    if (dipStart == null && gap >= threshold) dipStart = w;
    else if (dipStart != null && gap <= threshold / 2) {
      recoveries.push((dipStart - w) * 7);
      dipStart = null;
    }
  }
  return recoveries.length ? median(recoveries) : null;
}

// --- The sale model ---

export interface SaleParams {
  /** Price sensitivity as a fraction of the market price: how much cheaper doubles the odds. */
  tau: number;
  /** K's conversion relative to an average seller (1 = average). */
  alpha: number;
}

export const DEFAULT_PARAMS: SaleParams = { tau: 0.08, alpha: 1 };

/**
 * Chance per day of selling at total price p. K gets a fair share of demand among `supply` competitors, more
 * when cheaper than the market price m, less when dearer (a logistic in the relative price).
 */
export function hazard(p: number, m: number, demandPerDay: number, supply: number, params: SaleParams = DEFAULT_PARAMS): number {
  const share = (demandPerDay * params.alpha) / (supply + 1);
  const rel = (p - m) / (params.tau * m);
  // 2 / (1 + e^rel): equals the fair share at the market price, up to double when far cheaper.
  return Math.min(0.95, share * (2 / (1 + Math.exp(rel))));
}

export const daysToSell = (h: number) => (h > 0 ? 1 / h : Infinity);

/** A wait for K to read: estimates past a year mean the model has too little demand to go on, so none is given. */
export const daysText = (d: number | null | undefined) =>
  d == null || !Number.isFinite(d) || d > 365 ? "no reliable estimate (over a year at today's demand)" : d <= 1 ? "about a day" : `about ${Math.round(d)} days`;

/** How many listings compete, for K: close matches count part of one, so it's rounded. */
export const listed = (supply: number) => (Number.isInteger(supply) ? String(supply) : supply < 10 ? supply.toFixed(1) : String(Math.round(supply)));
export const chanceWithin = (h: number, days: number) => 1 - Math.exp(-h * days);

export interface Costs {
  /** Postage K charges the buyer (part of the total). */
  postage: number;
  /** Final value fee as a fraction of the total (0 for UK private sellers). */
  feeRate?: number;
  /** Fixed fee per order. */
  feeFixed?: number;
  /** Promoted Listings rate as a fraction. */
  adRate?: number;
  /** Holding cost per day, GBP. */
  holdPerDay?: number;
  /** Impatience per day. */
  discountPerDay?: number;
}

/** What K keeps from a sale at total price p, before K's own postage cost (which postage charged covers). */
export function net(p: number, c: Costs): number {
  return p - p * ((c.feeRate ?? 0) + (c.adRate ?? 0)) - (c.feeFixed ?? 0) - c.postage;
}

/** Expected present value of listing at p and waiting for a buyer: (h·net − c) / (h + δ). */
export function value(p: number, h: number, c: Costs): number {
  const hold = c.holdPerDay ?? 0.02;
  const delta = c.discountPerDay ?? 0.001;
  return (h * net(p, c) - hold) / (h + delta);
}

/** "own": K set the price (no sales to price from); the engine reports it and never changes it. */
export type Strategy = "compete" | "hold" | "clear" | "ask" | "own";

export interface PriceOption {
  /** Total the buyer pays. */
  total: number;
  /** Item price K lists (total - postage). */
  price: number;
  daysToSell: number;
  chance30: number;
  keeps: number;
  expectedValue: number;
}

export interface Decision {
  strategy: Strategy;
  /** Recommended item price (excluding postage), or null when asking. */
  price: number | null;
  total: number | null;
  options: PriceOption[];
  why: string;
  /** 0 to 1. */
  confidence: number;
  question?: string;
  /** Why it asks: it can't tell what the item is, or it knows but no sales of it or anything close exist. */
  reason?: "unidentified" | "no_sales";
}

export interface DecideInput {
  market: MarketState;
  costs: Costs;
  params?: SaleParams;
  /** K's floor, item price. */
  floor?: number | null;
  /** Current item price, for the step guardrail. */
  current?: number | null;
  /** Max step per change (fraction); a bigger move is shown but capped. */
  maxStep?: number;
  /** Days the listing has already been up: long-listed items carry a staleness cost. */
  listedDays?: number;
  /**
   * Spares or repair with one known, simple fault and everything else stated working (Claude's reading of the
   * listing). Such an item is better than the typical spares listing, whose faults are unknown, so it's priced
   * at the middle of spares sales instead of the cheaper end (K, 2026-11-05).
   */
  minorFault?: boolean;
  /** Same-condition sales and listings, for the seller's rule (sellerTarget). */
  evidence?: SellerEvidence;
}

/** The longest wait the engine will advise holding for. */
export const MAX_HOLD_DAYS = 120;
/** After this many days listed, each further day costs double: stale listings lose search ranking and look suspect. */
export const STALE_AFTER_DAYS = 60;

const option = (total: number, m: number, d: number, n: number, c: Costs, params: SaleParams): PriceOption => {
  const h = hazard(total, m, d, n, params);
  return {
    total: r2(total),
    price: r2(total - c.postage),
    daysToSell: Math.round(daysToSell(h)),
    chance30: Math.round(chanceWithin(h, 30) * 100) / 100,
    keeps: r2(net(total, c)),
    expectedValue: r2(value(total, h, c)),
  };
};

/** Round to a price ending buyers expect: .99 under £20, whole pounds .99 or .49 above. */
export function charmPrice(x: number): number {
  if (x < 2) return r2(x);
  if (x < 20) return Math.floor(x) + 0.99 > x + 0.5 ? Math.floor(x) - 0.01 : Math.floor(x) + 0.99;
  const base = Math.floor(x);
  return x - base >= 0.49 ? base + 0.49 : base - 0.01;
}

/**
 * A .99/.49 ending just under the listing being undercut (the ceiling), both item prices: the nearest ending
 * above x when it's still at least 25p under the ceiling (under £36: £35.49, not £34.99), else the one below.
 */
export function charmBelow(x: number, ceiling: number): number {
  const step = x < 20 ? 1 : 0.5;
  const up = r2(Math.ceil((x + 0.01) / step) * step - 0.01);
  if (up >= x && up <= ceiling - 0.25) return up;
  let p = Math.min(charmPrice(x), x);
  for (let i = 0; i < 6 && p >= ceiling - 0.005; i++) p = charmPrice(p - 0.5);
  return p >= ceiling - 0.005 ? r2(ceiling - 0.01) : p;
}

/**
 * The price ending follows the strategy (Backus, Blake & Tadelis on eBay: round asking prices draw offers sooner
 * but sell 5-8% lower; precise ones signal a patient seller). Compete: the usual .99/.49 endings. Hold: a precise
 * price (e.g. £41.85). Clear: a round price (whole pounds, or fives above £50), never above the target.
 */
export function endPrice(x: number, strategy: Strategy): number {
  if (x < 2) return r2(x);
  if (strategy === "clear") return x >= 50 ? Math.floor(x / 5) * 5 : Math.floor(x);
  if (strategy === "hold") {
    let p = Math.round(x * 20) / 20;
    const cents = Math.round((p % 1) * 100);
    if ([0, 45, 49, 50, 95, 99].includes(cents)) p -= 0.1;
    return r2(p);
  }
  return charmPrice(x);
}

// --- The seller's rule (K, 2026-11-06) ---
//
// How K prices, and the engine's anchor for an ordinary sale:
// 1. What buyers pay comes from sales in the same condition only. Close or different-condition matches (a used
//    sale against an unused item) count only when there's nothing else.
// 2. With few such sales the value is their middle (two sales at £28 and £37: about £33); with many, the recent
//    median. No trend is fitted through a handful of sales.
// 3. Same-condition listings priced far above what buyers pay (more than OVERPRICED times the value, or 15% above
//    the dearest sale) are ignored: nobody buys at £55 what sells at £28 to £37.
// 4. With realistic competition, price just under the cheapest listing, to be the one bought next, even above
//    past sales. Never below the lowest same-condition sale to chase a cheap listing: then it sits at that sale.
// 5. With no realistic competition, price at what buyers pay.

/** Listings above this multiple of what buyers pay are taken as overpriced and ignored. */
export const OVERPRICED = 1.3;
/** How far under the cheapest realistic listing to go (total, GBP): the larger of 50p and 1.5%. */
export const undercut = (cheapest: number) => Math.max(0.5, cheapest * 0.015);
/** Below this many same-condition sales, their middle is the value (no trend, no recency weighting). */
export const FEW_SALES = 6;

export interface SellerEvidence {
  /** Same-condition sales (exact matches), totals the buyer paid. */
  sold: { total: number; at: number }[];
  /** Same-condition live listings (exact matches), totals. */
  active: number[];
}

export interface SellerTarget {
  /** The total to aim at (item + postage). */
  total: number;
  /** What buyers pay for it, and the range of same-condition sales. */
  value: number | null;
  low: number | null;
  high: number | null;
  /** The cheapest realistic same-condition listing, if any. */
  cheapest: number | null;
  /** The total below which it won't go to chase a listing. */
  floor: number | null;
  basis: "under_cheapest" | "sales" | "lowest_sale" | "listings_only";
  why: string;
}

export function sellerTarget(ev: SellerEvidence, mk: MarketState): SellerTarget | null {
  const gbp = (x: number) => `£${x.toFixed(2)}`;
  const sold = ev.sold.map((x) => x.total).filter((x) => x > 0).sort((a, b) => a - b);
  let value: number | null = null;
  let low: number | null = null;
  let high: number | null = null;
  let floor: number | null = null;
  if (sold.length) {
    low = sold[0];
    high = sold[sold.length - 1];
    if (sold.length < FEW_SALES) {
      value = median(sold);
      floor = low;
    } else {
      value = mk.mNow ?? median(sold);
      floor = mk.p25 ?? quantile(sold, 0.25);
    }
  }
  const active = ev.active.filter((x) => x > 0).sort((a, b) => a - b);
  const ceiling = value != null ? Math.max(value * OVERPRICED, (high ?? value) * 1.15) : active.length ? median(active)! * OVERPRICED : null;
  const realistic = ceiling == null ? active : active.filter((x) => x <= ceiling);
  const ignored = active.length - realistic.length;
  const cheapest = realistic[0] ?? null;
  const salesText = sold.length ? (sold.length === 1 ? `one sale in the same condition at ${gbp(sold[0])}` : `${sold.length} sales in the same condition at ${gbp(low!)} to ${gbp(high!)}`) : "";
  const ignoredText = ignored ? ` ${ignored} listing${ignored === 1 ? "" : "s"} above ${gbp(ceiling!)} ignored as more than buyers pay.` : "";

  if (cheapest != null) {
    const under = cheapest - undercut(cheapest);
    if (floor != null && under < floor)
      return {
        total: r2(floor), value, low, high, cheapest, floor, basis: "lowest_sale",
        why: `Buyers paid: ${salesText}. The cheapest listing (${gbp(cheapest)}) is below ${sold.length < FEW_SALES ? "the lowest of those" : "the cheaper end of those"}, so this holds at ${gbp(floor)} rather than chasing it down.${ignoredText}`,
      };
    return {
      total: r2(under), value, low, high, cheapest, floor, basis: value == null ? "listings_only" : "under_cheapest",
      why: value == null
        ? `No sales found, but ${realistic.length} listed in the same condition from ${gbp(cheapest)}: priced just under the cheapest to sell first. Low confidence until something sells.${ignoredText}`
        : `Priced just under the cheapest of ${realistic.length} listing${realistic.length === 1 ? "" : "s"} in the same condition (${gbp(cheapest)}), to be the one bought next. Buyers paid: ${salesText}.${ignoredText}`,
    };
  }
  if (value == null) return null;
  return {
    total: r2(value), value, low, high, cheapest: null, floor, basis: "sales",
    why: `${salesText[0].toUpperCase()}${salesText.slice(1)}, and ${active.length ? "no realistically priced listing" : "nothing listed"} to compete with, so it's priced at what buyers pay${sold.length > 1 && sold.length < FEW_SALES ? ": the middle of those sales" : ""}.${ignoredText}`,
  };
}

/**
 * Picks the strategy and price for one item. The grid runs from the value floor to above the usual price;
 * V(p) balances a faster sale against a higher price under today's market.
 */
export function decide(input: DecideInput): Decision {
  const { market: mk, costs } = input;
  const params = input.params ?? DEFAULT_PARAMS;
  const postage = costs.postage;
  const floorTotal = Math.max((input.floor ?? 0) + postage, mk.valueFloor ?? 0);

  const target = input.evidence ? sellerTarget(input.evidence, mk) : null;
  // Only with no usable evidence at all does it ask; a thin market still gets a (low-confidence) price, and
  // same-condition listings alone price it just under the cheapest.
  if ((mk.mNow == null || mk.mLong == null || mk.effective < 1) && target?.basis === "listings_only") {
    const m = target.cheapest!;
    const price = Math.max(charmBelow(target.total - postage, m - postage), input.floor ?? 0);
    const d0 = 1 / 90;
    const chosen = option(price + postage, m, d0, input.evidence!.active.length, costs, params);
    return {
      strategy: "compete",
      price: r2(price),
      total: chosen.total,
      options: [option(Math.max(floorTotal, chosen.total * 0.92), m, d0, input.evidence!.active.length, costs, params), chosen, option(chosen.total * 1.08, m, d0, input.evidence!.active.length, costs, params)],
      why: target.why,
      confidence: 0.15,
    };
  }
  if (mk.mNow == null || mk.mLong == null || mk.effective < 1) {
    return {
      strategy: "ask",
      price: null,
      total: null,
      options: [],
      why: mk.why,
      confidence: 0,
      question: "No sales of this item or anything close were found, so it can't be priced from the market. What price do you want for it?",
      reason: "no_sales",
    };
  }

  const d = Math.max(mk.demand28, mk.demand91, 1 / 180);
  const n = mk.supply;
  const grid: number[] = [];
  const lo = Math.min(mk.mNow, mk.mLong) * 0.7;
  const hi = Math.max(mk.mNow, mk.mLong) * 1.25;
  for (let t = lo; t <= hi; t += Math.max(0.25, (hi - lo) / 80)) grid.push(t);

  const best = (m: number, dd: number, nn: number, from: number, to: number) => {
    let top: PriceOption | null = null;
    for (const t of grid) {
      if (t < from || t > to) continue;
      const o = option(t, m, dd, nn, costs, params);
      if (!top || o.expectedValue > top.expectedValue) top = o;
    }
    return top ?? option(Math.max(from, Math.min(to, m)), m, dd, nn, costs, params);
  };

  let strategy: Strategy;
  let pick: PriceOption;
  let why = mk.why;

  if (mk.regime === "race_to_bottom") {
    // Sell now into today's market, or hold at the recovered price and accept a wait?
    const now = best(mk.mNow, d, n, floorTotal, Infinity);
    const recovery = mk.recoveryDays;
    let held: PriceOption | null = null;
    if (recovery != null && recovery <= MAX_HOLD_DAYS) {
      const after = best(mk.mLong, Math.max(mk.demand91, d), n, floorTotal, mk.mLong);
      // Value of holding = wait for recovery (paying holding cost, doubled once the listing is stale,
      // discounted) then sell at the recovered price.
      const delta = costs.discountPerDay ?? 0.001;
      const hold = costs.holdPerDay ?? 0.02;
      const stale = Math.max(0, (input.listedDays ?? 0) + recovery - Math.max(STALE_AFTER_DAYS, input.listedDays ?? 0));
      const v = Math.exp(-delta * recovery) * after.expectedValue - hold * (recovery + stale);
      held = { ...after, daysToSell: after.daysToSell + Math.round(recovery), expectedValue: r2(v) };
    }
    if (held && held.expectedValue > now.expectedValue * 1.1) {
      strategy = "hold";
      pick = held;
      why += ` Holding at £${held.price.toFixed(2)} is worth about £${(held.expectedValue - now.expectedValue).toFixed(2)} more than selling into the dip.`;
    } else {
      strategy = "compete";
      pick = now;
      why += held ? " Waiting isn't worth enough here, so it competes now." : "";
    }
  } else if (mk.regime === "decline") {
    strategy = "clear";
    // Price for a quick sale: within the cheaper part of today's sales, best value there.
    pick = best(mk.mNow, d, n, floorTotal, mk.p25 ?? mk.mNow);
  } else {
    strategy = "compete";
    if (input.minorFault) {
      // Better than the typical spares listing: from the middle of spares sales to halfway to the upper quartile.
      const from = Math.max(floorTotal, mk.mNow);
      const to = Math.max(from, mk.mNow + 0.5 * Math.max(0, (mk.p75 ?? mk.mNow) - mk.mNow));
      pick = best(mk.mNow, d, n, from, to);
      why += " One known fault with the rest working, so it's priced at the middle of spares sales, not the cheap end.";
    } else if (target) {
      // K's rule (sellerTarget): just under the cheapest realistic listing, or what buyers pay with none.
      const t = Math.max(floorTotal, target.total);
      pick = option(t, target.value ?? mk.mNow, d, n, costs, params);
      why = target.why;
    } else {
      // Keep inside the cheaper half of current sales, so the listing is picked early, without harming value.
      const from = Math.max(floorTotal, Math.min(mk.p25 ?? mk.mNow, mk.mNow));
      const to = Math.max(from, (mk.p25 ?? mk.mNow) + 0.55 * ((mk.p75 ?? mk.mNow) - (mk.p25 ?? mk.mNow)));
      pick = best(mk.mNow, d, n, from, to);
    }
  }

  // The price ending suits the strategy; never below the floor; and never up to the listing it undercuts.
  let price = Math.max(endPrice(pick.price, strategy), input.floor ?? 0);
  if (target?.basis === "under_cheapest" && strategy === "compete" && !input.minorFault) price = Math.max(charmBelow(pick.price, target.cheapest! - postage), input.floor ?? 0);
  let capped = false;
  const step = input.maxStep ?? 0.1;
  if (input.current && Math.abs(price - input.current) / input.current > step) {
    price = r2(input.current * (price > input.current ? 1 + step : 1 - step));
    capped = true;
  }
  const chosen = option(price + postage, strategy === "hold" ? mk.mLong : mk.mNow, d, n, costs, params);
  if (capped) why += ` Moved by the 10% step limit; the full target is £${endPrice(pick.price, strategy).toFixed(2)}.`;

  // Three options for K: quicker, recommended, higher.
  const ref = strategy === "hold" ? mk.mLong : mk.mNow;
  const options = [
    option(Math.max(floorTotal, chosen.total * 0.92), ref, d, n, costs, params),
    chosen,
    option(chosen.total * 1.08, ref, d, n, costs, params),
  ];

  // Confidence grows with the evidence (close matches count less) and falls with how spread out prices are.
  const spread = mk.p25 != null && mk.p75 != null && mk.mNow > 0 ? (mk.p75 - mk.p25) / mk.mNow : 0.5;
  const confidence = Math.min(1, mk.effective / 15) * (1 - Math.min(0.5, spread)) * (mk.regime === "thin" ? 0.6 : 1);
  return { strategy, price: r2(price), total: chosen.total, options, why, confidence: Math.round(confidence * 100) / 100 };
}

// --- Learning ---

export interface Outcome {
  /** Total price relative to the market price at listing: p / m. */
  rel: number;
  /** Days observed. */
  days: number;
  sold: boolean;
  /** Fair share of demand per day at the time: d / (n + 1). */
  share: number;
}

/**
 * Fits tau and alpha by maximum likelihood on survival data (sold after t days, or still unsold: censored),
 * with a grid search, then shrinks toward the prior by the amount of data. Returns the prior with < 5 outcomes.
 */
export function fitParams(outcomes: Outcome[], prior: SaleParams = DEFAULT_PARAMS, priorWeight = 20): SaleParams & { n: number } {
  if (outcomes.length < 5) return { ...prior, n: outcomes.length };
  let bestLl = -Infinity;
  let fit = prior;
  for (let tau = 0.02; tau <= 0.4; tau += 0.01)
    for (let alpha = 0.1; alpha <= 4; alpha *= 1.1) {
      let ll = 0;
      for (const o of outcomes) {
        const h = Math.min(0.95, o.share * alpha * (2 / (1 + Math.exp((o.rel - 1) / tau))));
        // Exponential survival: log f = log h − h t (sold), log S = −h t (unsold).
        ll += (o.sold ? Math.log(Math.max(h, 1e-9)) : 0) - h * o.days;
      }
      if (ll > bestLl) (bestLl = ll), (fit = { tau, alpha });
    }
  const w = outcomes.length / (outcomes.length + priorWeight);
  return {
    tau: Math.round((w * fit.tau + (1 - w) * prior.tau) * 1000) / 1000,
    alpha: Math.round(Math.exp(w * Math.log(fit.alpha) + (1 - w) * Math.log(prior.alpha)) * 1000) / 1000,
    n: outcomes.length,
  };
}

/**
 * Turns two Browse snapshots of the same search into outcomes: a listing gone before its natural end is
 * counted as probably sold; one still there is censored. This is where most learning comes from, since K
 * sells about one item a month.
 */
export function outcomesFromSnapshots(
  before: { itemId: string; total: number }[],
  after: { itemId: string }[],
  days: number,
  market: number,
  share: number,
): Outcome[] {
  const still = new Set(after.map((a) => a.itemId));
  return before.map((b) => ({ rel: b.total / market, days, sold: !still.has(b.itemId), share }));
}
