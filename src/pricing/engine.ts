import type { Env } from "../env";
import type { MessagesApi } from "../claude";
import { searchActiveComps, type Comp } from "../ebay/browse";
import { getItem } from "../ebay/trading";
import { itemNumber, poolSales, providerEnabled, searchSold, type Provider, type SoldSale } from "../solddata";
import { identify, IDENTITY_VERSION, matchTitles, type Component, type Grade, type Identity } from "./identify";
import {
  charmPrice,
  decide,
  DEFAULT_PARAMS,
  marketState,
  type Costs,
  type Decision,
  type MarketSale,
  type MarketState,
  type SaleParams,
} from "./model";

// The pricing engine end to end (docs/pricing-engine.md): identify → gather (both sold-data providers
// pooled, plus eBay's active listings) → match → market state → decide. A bundle is priced as the sum of
// its parts, each found and matched on its own. Nothing here writes to eBay: the result feeds proposals.

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface PriceInput {
  itemId?: string | null;
  title: string;
  condition?: string | null;
  specifics?: Record<string, string>;
  description?: string | null;
  /** Listing photo URLs (eBay-hosted); the first three help Claude identify the item. */
  photos?: string[];
  /** Days the listing has been up, for the staleness cost of holding. */
  listedDays?: number;
  /** Postage K charges; null if unknown (then the market's typical postage is assumed). */
  postage?: number | null;
  floor?: number | null;
  current?: number | null;
  /** eBay item numbers left out of the evidence (K's own listing or sale). */
  excludeItemIds?: string[];
  /** Sold history to search back over, days (default 730; CompsAPI gives at most 365). */
  days?: number;
  /** Backtest: price as if on this date (ms), using only sales before it and no live listings. */
  asOf?: number;
}

export interface ComponentResult {
  name: string;
  query: string;
  valued: boolean;
  market: MarketState;
  decision: Decision;
  /** Typical postage in this market, used when K's isn't known. */
  typicalPostage: number;
  found: { sold: number; active: number };
  /** Exact and close matches; close ones count CLOSE_WEIGHT each, at their adjusted price. */
  matched: { sold: number; active: number; closeSold: number; closeActive: number; by: "claude" | "rules" };
  evidence: {
    sold: { title: string; total: number; date: string | null; url: string | null; grade: Grade["grade"]; factor: number }[];
    active: { title: string; total: number; url: string; grade: Grade["grade"]; factor: number }[];
  };
  errors: string[];
}

export interface PriceResult {
  at: number;
  identity: Identity;
  components: ComponentResult[];
  decision: Decision;
  /** "sum of parts" for a bundle, else "single". */
  method: "single" | "sum of parts";
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2 : null;
};

export async function paramsFor(env: Env, group: string): Promise<SaleParams> {
  const row = await env.DB.prepare("SELECT tau, alpha FROM pricing_params WHERE grp IN (?, 'all') ORDER BY grp = 'all' LIMIT 1")
    .bind(group)
    .first<{ tau: number; alpha: number }>()
    .catch(() => null);
  return row ? { tau: row.tau, alpha: row.alpha } : DEFAULT_PARAMS;
}

/** How much a close (adjusted) comparable counts against an exact one. */
export const CLOSE_WEIGHT = 0.35;

async function cachedIdentity(env: Env, input: PriceInput, api?: MessagesApi): Promise<Identity> {
  // Redone when the listing's title, condition, description or first photo changes.
  const key = `v${IDENTITY_VERSION}|${input.title}|${input.condition ?? ""}|${(input.description ?? "").length}|${input.photos?.[0] ?? ""}`;
  const hit = await env.DB.prepare("SELECT identity FROM item_identity WHERE key = ?").bind(key).first<{ identity: string }>();
  if (hit) return JSON.parse(hit.identity);
  const id = await identify(env, input, api);
  if (id.by === "claude")
    await env.DB.prepare("INSERT OR REPLACE INTO item_identity (key, item_id, identity, at) VALUES (?, ?, ?, ?)")
      .bind(key, input.itemId ?? null, JSON.stringify(id), Date.now())
      .run();
  return id;
}

/** Sold sales for one search from every provider that's set up, pooled, each eBay sale once. */
export async function gatherSold(env: Env, query: string, days: number, errors: string[]): Promise<SoldSale[]> {
  const lists: SoldSale[][] = [];
  for (const p of ["compsapi", "trawl"] as Provider[]) {
    if (!providerEnabled(env, p)) continue;
    try {
      lists.push((await searchSold(env, p, { words: query, days: p === "compsapi" ? Math.min(days, 365) : days })).sales);
    } catch (e) {
      errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return poolSales(...lists);
}

async function priceComponent(env: Env, identity: Identity, c: Component, input: PriceInput, params: SaleParams, api?: MessagesApi): Promise<ComponentResult> {
  const errors: string[] = [];
  const exclude = new Set(input.excludeItemIds ?? []);
  const asOf = input.asOf ?? Date.now();
  const backtest = input.asOf != null && Date.now() - input.asOf > 14 * DAY;
  const gathered = (await gatherSold(env, c.query, input.days ?? 730, errors)).filter((s) => !exclude.has(itemNumber(s.url) ?? ""));
  let soldAll = gathered.filter((s) => !s.dateSold || Date.parse(s.dateSold) <= asOf);
  let marketAt = asOf;
  // Backtest only: providers return the latest few hundred sales, so for a popular item nothing may predate
  // an older sale. Then the nearest sales after it (up to 60 days) stand in, and the result says so.
  if (backtest && soldAll.length < 5) {
    const later = gathered.filter((s) => s.dateSold && Date.parse(s.dateSold) > asOf && Date.parse(s.dateSold) <= asOf + 60 * DAY);
    if (later.length > soldAll.length) {
      soldAll = [...soldAll, ...later];
      marketAt = Math.max(...later.map((s) => Date.parse(s.dateSold!)));
      errors.push(`No provider data from before ${new Date(asOf).toISOString().slice(0, 10)}: used sales from up to 60 days after it.`);
    }
  }
  let activeAll: Comp[] = [];
  if (!backtest) try {
    activeAll = (await searchActiveComps(env, c.query, { limit: 100 })).comps.filter((a) => !exclude.has(a.itemId.split("|")[1] ?? a.itemId));
  } catch (e) {
    errors.push(`eBay active listings: ${e instanceof Error ? e.message : String(e)}`);
  }

  // One matching pass over sold and active titles together.
  const titles = [...soldAll.map((s) => s.title), ...activeAll.map((a) => a.title)];
  const { matches, by } = await matchTitles(env, identity, c, titles, input.title, api);
  const grades = new Map(matches.map((g) => [g.i, g]));
  // Best Offer sales whose accepted price isn't known would overstate the market, so they're left out.
  const sold = soldAll
    .map((s, i) => ({ ...s, g: grades.get(i)! }))
    .filter((s) => s.g && s.bestOffer !== "listed" && s.price > 0);
  const active = activeAll.map((a, i) => ({ ...a, g: grades.get(soldAll.length + i)! })).filter((a) => a.g && a.price > 0);
  const weight = (g: Grade) => (g.grade === "exact" ? 1 : CLOSE_WEIGHT);

  // Postage: known postage in this market, else K's.
  const knownPostage = [...sold.map((s) => s.shipping), ...active.map((a) => a.shipping)].filter((x): x is number => x != null);
  const typicalPostage = r2(median(knownPostage) ?? input.postage ?? 0);
  const total = (price: number, shipping: number | null) => r2(price + (shipping ?? typicalPostage));

  // Each comparable is adjusted to K's item (as a valuer adjusts a comparable sale) and weighted by how close it is.
  const sales: MarketSale[] = sold.map((s) => ({
    total: r2(total(s.price, s.shipping) * s.g.factor),
    at: s.dateSold ? Date.parse(s.dateSold) || asOf - 30 * DAY : asOf - 30 * DAY,
    bestOffer: s.bestOffer === true,
    weight: weight(s.g),
  }));
  const market = marketState(
    sales,
    active.map((a) => ({ total: r2(total(a.price, a.shipping) * a.g.factor), weight: weight(a.g) })),
    { now: marketAt },
  );
  const postage = input.postage ?? typicalPostage;
  const costs: Costs = { postage };
  const single = identity.components.length === 1;
  const decision = decide({ market, costs, params, floor: single ? input.floor : null, current: single ? input.current : null, listedDays: input.listedDays });

  // Only exact matches teach the sale model which prices sell.
  if (!backtest) await recordSnapshot(env, c.query, identity.group, active.filter((a) => a.g.grade === "exact"), typicalPostage, market).catch(() => {});

  return {
    name: c.name,
    query: c.query,
    valued: c.valued,
    market,
    decision,
    typicalPostage,
    found: { sold: soldAll.length, active: activeAll.length },
    matched: {
      sold: sold.filter((s) => s.g.grade === "exact").length,
      active: active.filter((a) => a.g.grade === "exact").length,
      closeSold: sold.filter((s) => s.g.grade === "close").length,
      closeActive: active.filter((a) => a.g.grade === "close").length,
      by,
    },
    evidence: {
      sold: sold
        .slice()
        .sort((a, b) => (a.g.grade === b.g.grade ? String(b.dateSold).localeCompare(String(a.dateSold)) : a.g.grade === "exact" ? -1 : 1))
        .slice(0, 8)
        .map((s) => ({ title: s.title, total: total(s.price, s.shipping), date: s.dateSold?.slice(0, 10) ?? null, url: s.url, grade: s.g.grade, factor: s.g.factor })),
      active: active
        .map((a) => ({ title: a.title, total: total(a.price, a.shipping), url: a.url, grade: a.g.grade, factor: a.g.factor }))
        .sort((a, b) => a.total - b.total)
        .slice(0, 8),
    },
    errors,
  };
}

/** Today's matched active listings, kept so the engine can learn which prices sold (step 7). */
async function recordSnapshot(env: Env, query: string, group: string, active: Comp[], postage: number, market: MarketState) {
  if (!active.length || market.mNow == null) return;
  const key = query.toLowerCase().trim();
  const at = Date.now();
  const last = await env.DB.prepare("SELECT MAX(taken_at) AS t FROM market_snapshots WHERE key = ?").bind(key).first<{ t: number | null }>();
  if (last?.t && at - last.t < DAY) return; // at most one a day per search
  const share = Math.max(market.demand28, market.demand91) / (market.supply + 1);
  await env.DB.batch(
    active.slice(0, 100).map((a) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO market_snapshots (key, taken_at, item_id, total, grp, market, share) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(key, at, a.itemId, r2(a.price + (a.shipping ?? postage)), group, market.mNow, share),
    ),
  );
}

/** Adds up a bundle's parts: each part priced on its own market, postage charged once. */
export function sumOfParts(parts: ComponentResult[], postage: number, floor?: number | null): Decision {
  // A part with no evidence at all doesn't block the price when the main part (listed first) is priced:
  // it's left out and named, so K can add its value. Only an unpriced main part makes it ask.
  const all = parts.filter((p) => p.valued);
  const missing = all.slice(1).filter((p) => p.decision.strategy === "ask");
  const valued = all.filter((p) => !missing.includes(p));
  const ask = valued.find((p) => p.decision.strategy === "ask");
  if (!valued.length || ask)
    return {
      strategy: "ask",
      price: null,
      total: null,
      options: [],
      why: ask ? `No reliable price for "${ask.name}". ${ask.market.why}` : "No part of this bundle could be priced.",
      confidence: 0,
      question: ask ? `What exactly is the "${ask.name}" (brand and model)?` : "What's in this bundle?",
    };
  // Each part's item price is its market total less that market's postage.
  const itemPrice = (p: ComponentResult, i: number) => Math.max(0, (p.decision.options[i]?.total ?? p.decision.total!) - p.typicalPostage);
  const options = [0, 1, 2].map((i) => {
    const price = r2(valued.reduce((s, p) => s + itemPrice(p, i), 0));
    const slowest = Math.max(...valued.map((p) => p.decision.options[i]?.daysToSell ?? 0));
    return { total: r2(price + postage), price, daysToSell: slowest, chance30: Math.min(...valued.map((p) => p.decision.options[i]?.chance30 ?? 0)), keeps: price, expectedValue: price };
  });
  const price = Math.max(charmPrice(options[1].price), floor ?? 0);
  const strategies = [...new Set(valued.map((p) => p.decision.strategy))];
  return {
    strategy: strategies.length === 1 ? strategies[0] : "compete",
    price,
    total: r2(price + postage),
    options,
    why:
      `Sum of the parts, each priced on its own market: ` +
      valued.map((p) => `${p.name} £${itemPrice(p, 1).toFixed(2)}`).join(", ") +
      `. One postage charge instead of ${valued.length}. No bundle premium or discount is applied until real sales of this bundle show one.` +
      (missing.length ? ` Not counted, no sales found: ${missing.map((p) => p.name).join(", ")}.` : ""),
    confidence: Math.min(...valued.map((p) => p.decision.confidence)) * (missing.length ? 0.7 : 1),
  };
}

export async function priceItem(env: Env, input: PriceInput, api?: MessagesApi): Promise<PriceResult> {
  const identity = await cachedIdentity(env, input, api);
  const at = Date.now();
  if (!identity.priceable) {
    const empty: Decision = { strategy: "ask", price: null, total: null, options: [], why: "The listing doesn't say exactly what the item is.", confidence: 0, question: identity.question ?? "Which brand and model is it?" };
    return { at, identity, components: [], decision: empty, method: "single" };
  }
  const params = await paramsFor(env, identity.group);
  const components: ComponentResult[] = [];
  for (const c of identity.components) {
    if (!c.valued && identity.components.length > 1) continue; // manuals and cables aren't searched
    components.push(await priceComponent(env, identity, c, input, params, api));
  }
  const bundle = components.length > 1;
  const decision = bundle ? sumOfParts(components, input.postage ?? Math.max(...components.map((c) => c.typicalPostage)), input.floor) : components[0].decision;
  return { at, identity, components, decision, method: bundle ? "sum of parts" : "single" };
}

/** Keeps the decision for learning and for the price label's track record. */
export async function recordDecision(env: Env, itemId: string | null, r: PriceResult) {
  const m = r.components[0]?.market;
  await env.DB.prepare(
    `INSERT INTO price_decisions (item_id, at, grp, strategy, price, total, market_price, predicted_days, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      itemId,
      r.at,
      r.identity.group,
      r.decision.strategy,
      r.decision.price,
      r.decision.total,
      m?.mNow ?? null,
      r.decision.options[1]?.daysToSell ?? null,
      JSON.stringify(r).slice(0, 60_000),
    )
    .run();
}

const num = (v: any): number | null => {
  const n = Number(typeof v === "object" && v != null ? v["#text"] : v);
  return Number.isFinite(n) ? n : null;
};
const list = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * What the buyer pays for postage on one of K's listings. A cost of 0 counts as free postage only when eBay
 * marks the service FreeShipping; otherwise a 0 means eBay works the cost out for each buyer (calculated or
 * eBay-set postage), so it's unknown here and the market's typical postage is used instead.
 */
export function postageOf(item: any): { cost: number | null; kind: "free" | "flat" | "calculated" | "collection" | "unknown"; service: string | null } {
  if (item?.ShipToLocations === "None") return { cost: null, kind: "collection", service: null };
  const opts = list<any>(item?.ShippingDetails?.ShippingServiceOptions);
  const service = opts[0]?.ShippingService ? String(opts[0].ShippingService) : null;
  if (opts.some((o) => String(o.FreeShipping) === "true")) return { cost: 0, kind: "free", service };
  const costs = opts.map((o) => num(o.ShippingServiceCost)).filter((x): x is number => x != null && x > 0);
  if (costs.length) return { cost: Math.min(...costs), kind: "flat", service };
  const type = String(item?.ShippingDetails?.ShippingType ?? "");
  return { cost: null, kind: /calculated/i.test(type) || opts.length ? "calculated" : "unknown", service };
}

/** What the engine needs from a Trading API GetItem result. */
export function inputFromItem(item: any): PriceInput {
  const specifics: Record<string, string> = {};
  for (const nv of list<any>(item?.ItemSpecifics?.NameValueList)) specifics[String(nv.Name)] = list(nv.Value).join(", ");
  const postage = postageOf(item);
  return {
    itemId: String(item?.ItemID ?? ""),
    title: String(item?.Title ?? ""),
    condition: item?.ConditionDisplayName ?? null,
    specifics,
    description: typeof item?.Description === "string" ? item.Description : null,
    postage: postage.cost,
    photos: list<any>(item?.PictureDetails?.PictureURL).map(String).filter((u) => u.startsWith("https://")),
    listedDays: item?.ListingDetails?.StartTime ? Math.max(0, Math.round((Date.now() - Date.parse(item.ListingDetails.StartTime)) / DAY)) : undefined,
    current: num(item?.SellingStatus?.CurrentPrice) ?? num(item?.StartPrice),
  };
}

/** Prices one of K's live listings (read-only eBay calls) and records the decision. */
export async function priceListing(env: Env, itemId: string, api?: MessagesApi): Promise<PriceResult> {
  const input = inputFromItem(await getItem(env, itemId));
  const s = await env.DB.prepare("SELECT floor_price FROM item_settings WHERE item_id = ?").bind(itemId).first<{ floor_price: number | null }>();
  const r = await priceItem(env, { ...input, itemId, floor: s?.floor_price ?? null, excludeItemIds: [itemId] }, api);
  await recordDecision(env, itemId, r);
  return r;
}

/** The engine's latest result for one of K's listings if recent enough, else a fresh check (or null). */
export async function currentPricing(env: Env, itemId: string, maxAgeDays = 3, api?: MessagesApi): Promise<PriceResult | null> {
  const row = await env.DB.prepare("SELECT result FROM price_decisions WHERE item_id = ? AND at > ? ORDER BY at DESC LIMIT 1")
    .bind(itemId, Date.now() - maxAgeDays * DAY)
    .first<{ result: string }>();
  if (row) return JSON.parse(row.result);
  if (!providerEnabled(env, "trawl") && !providerEnabled(env, "compsapi")) return null;
  return priceListing(env, itemId, api).catch(() => null);
}
