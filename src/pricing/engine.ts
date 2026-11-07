import type { Env } from "../env";
import type { MessagesApi } from "../claude";
import { searchActiveComps, type Comp } from "../ebay/browse";
import { getItem } from "../ebay/trading";
import { push } from "../notify";
import { itemNumber, poolSales, providerEnabled, searchSold, type Provider, type SoldSale } from "../solddata";
import { identify, identifyByRules, IDENTITY_VERSION, matchTitles, type Component, type Grade, type Identity } from "./identify";
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
import { r2, list } from "../util";

// The pricing engine end to end (docs/pricing-engine.md): identify → gather (both sold-data providers
// pooled, plus eBay's active listings) → match → market state → decide. A bundle is priced as the sum of
// its parts, each found and matched on its own. Nothing here writes to eBay: the result feeds proposals.

const DAY = 86_400_000;

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
  /** K's facts about the item (src/pricing/identify.ts), e.g. an answer to the engine's question. */
  factsFromK?: string | null;
  /** Other names the product is sold under, from published sources (a new listing's spec lookup). */
  aliases?: string[];
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
  const row = await env.store.pricing.paramsFor(group).catch(() => null);
  return row ? { tau: row.tau, alpha: row.alpha } : DEFAULT_PARAMS;
}

/** Sales found under a component's main query below which its other searches are tried too. */
export const ENOUGH_SALES = 5;

/** How much a close (adjusted) comparable counts against an exact one. */
export const CLOSE_WEIGHT = 0.35;

async function cachedIdentity(env: Env, input: PriceInput, api?: MessagesApi): Promise<Identity> {
  // Redone when the listing's title, condition, description or first photo changes, or K's facts do (added
  // only when there are some, so identities cached before facts existed still hit).
  const facts = input.factsFromK?.trim();
  const key = `v${IDENTITY_VERSION}|${input.title}|${input.condition ?? ""}|${(input.description ?? "").length}|${input.photos?.[0] ?? ""}${facts ? `|k:${facts}` : ""}${input.aliases?.length ? `|a:${input.aliases.join(";")}` : ""}`;
  const hit = await env.store.pricing.getIdentity(key);
  if (hit) return JSON.parse(hit);
  const id = await identify(env, input, api);
  if (id.by === "claude")
    await env.store.pricing.putIdentity(key, input.itemId ?? null, JSON.stringify(id), Date.now());
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
  let gathered = (await gatherSold(env, c.query, input.days ?? 730, errors)).filter((s) => !exclude.has(itemNumber(s.url) ?? ""));
  // Too few sales under the main query: the same product under its other names, or more broadly (identify.ts,
  // alternates). Each search counts against the providers' monthly caps and is cached for 30 days; the
  // matching pass below still grades every title against this exact product, so a broad search can't price it
  // from different things.
  const searched = [c.query];
  const words = (q: string) => q.toLowerCase().split(/s+/).filter(Boolean);
  const empty: string[][] = gathered.length ? [] : [words(c.query)];
  for (const q of c.alternates ?? []) {
    if (gathered.length >= ENOUGH_SALES) break;
    // Searches need every word: one that adds words to a search that found nothing can't find anything either.
    if (empty.some((e) => e.every((w) => words(q).includes(w)))) continue;
    searched.push(q);
    const more = (await gatherSold(env, q, input.days ?? 730, errors)).filter((s) => !exclude.has(itemNumber(s.url) ?? ""));
    if (!more.length) empty.push(words(q));
    gathered = poolSales(gathered, more);
  }
  if (searched.length > 1) errors.push(`Few sales under "${c.query}", so also searched: ${searched.slice(1).map((q) => `"${q}"`).join(", ")}.`);
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
    activeAll = (await searchActiveComps(env, searched.at(-1)!, { limit: 100 })).comps.filter((a) => !exclude.has(a.itemId.split("|")[1] ?? a.itemId));
    if (searched.length > 1 && activeAll.length < ENOUGH_SALES) {
      const more = (await searchActiveComps(env, c.query, { limit: 100 })).comps.filter((a) => !exclude.has(a.itemId.split("|")[1] ?? a.itemId));
      const seen = new Set(activeAll.map((a) => a.itemId));
      activeAll = [...activeAll, ...more.filter((a) => !seen.has(a.itemId))];
    }
  } catch (e) {
    errors.push(`eBay active listings: ${e instanceof Error ? e.message : String(e)}`);
  }

  // One matching pass over sold and active titles together.
  // Each title with the condition the provider or eBay reports, so a used sale isn't taken for a new item's
  // exact match (2026-11-06: one used sale graded exact priced an unused air fryer at £11 against new sales at £28 to £40).
  const withCondition = (t: string, cond: string | null | undefined) => (cond && cond.trim() ? `${t} [condition: ${cond.trim().slice(0, 30)}]` : t);
  const titles = [...soldAll.map((s) => withCondition(s.title, s.condition)), ...activeAll.map((a) => withCondition(a.title, a.condition))];
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

  // Same-condition evidence first (K, 2026-11-06): when there are exact sales, close and different-condition
  // ones (a used sale against an unused item) are set aside; they count only when there's nothing else.
  const exactSold = sold.filter((s) => s.g.grade === "exact");
  const exactActive = active.filter((a) => a.g.grade === "exact");
  const useSold = exactSold.length ? exactSold : sold;
  const useActive = exactActive.length ? exactActive : active;
  const setAside = sold.length - useSold.length;
  const asOfSale = (s: { dateSold: string | null }) => (s.dateSold ? Date.parse(s.dateSold) || asOf - 30 * DAY : asOf - 30 * DAY);
  // Each comparable is adjusted to K's item (as a valuer adjusts a comparable sale) and weighted by how close it is.
  const sales: MarketSale[] = useSold.map((s) => ({
    total: r2(total(s.price, s.shipping) * s.g.factor),
    at: asOfSale(s),
    bestOffer: s.bestOffer === true,
    weight: weight(s.g),
  }));
  const market = marketState(
    sales,
    useActive.map((a) => ({ total: r2(total(a.price, a.shipping) * a.g.factor), weight: weight(a.g) })),
    { now: marketAt },
  );
  const postage = pricingPostage(input.postage, typicalPostage);
  const costs: Costs = { postage };
  const single = identity.components.length === 1;
  const minorFault = identity.condition === "parts" && identity.fault === "minor";
  const evidence = { sold: exactSold.map((s) => ({ total: total(s.price, s.shipping), at: asOfSale(s) })), active: exactActive.map((a) => total(a.price, a.shipping)) };
  const decision = decide({ market, costs, params, floor: single ? input.floor : null, current: single ? input.current : null, listedDays: input.listedDays, minorFault, evidence });
  if (setAside) decision.why += ` ${setAside} close or different-condition sale${setAside === 1 ? "" : "s"} set aside, as there are sales in the same condition.`;
  if (single && input.postage != null && postage < input.postage) decision.why += postageNote(input.postage, postage);

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
  const last = await env.store.pricing.lastMarketAt(key);
  if (last && at - last < DAY) return; // at most one a day per search
  const share = Math.max(market.demand28, market.demand91) / (market.supply + 1);
  // One document per search per day; each listing once (the first, as INSERT OR IGNORE kept).
  const seen = new Set<string>();
  const items = active
    .slice(0, 100)
    .filter((a) => !seen.has(a.itemId) && seen.add(a.itemId))
    .map((a) => ({ item_id: a.itemId, total: r2(a.price + (a.shipping ?? postage)) }));
  await env.store.pricing.writeMarket(key, at, { grp: group, market: market.mNow, share, items });
}

/**
 * The postage the engine prices with. K sets postage on the high side for big items, offers collection, and
 * refunds any overpaid postage (K, 2026-11-05), so a postage above the market's typical isn't held against
 * the price: the engine prices as if the typical postage were charged.
 */
export function pricingPostage(kPostage: number | null | undefined, typical: number): number {
  return kPostage == null ? typical : Math.min(kPostage, typical);
}

export const postageNote = (kPostage: number, typical: number) =>
  ` Your postage (£${kPostage.toFixed(2)}) is above the typical £${typical.toFixed(2)} for this item; priced as if buyers paid the typical postage, since you refund any overpaid postage and offer collection.`;

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
      reason: "unidentified",
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
    const empty: Decision = { strategy: "ask", price: null, total: null, options: [], why: "The listing doesn't say exactly what the item is.", confidence: 0, question: identity.question ?? "Which brand and model is it?", reason: "unidentified" };
    return { at, identity, components: [], decision: empty, method: "single" };
  }
  const params = await paramsFor(env, identity.group);
  const components: ComponentResult[] = [];
  for (const c of identity.components) {
    if (!c.valued && identity.components.length > 1) continue; // manuals and cables aren't searched
    components.push(await priceComponent(env, identity, c, input, params, api));
  }
  const bundle = components.length > 1;
  const typical = bundle ? Math.max(...components.map((c) => c.typicalPostage)) : 0;
  const decision = bundle ? sumOfParts(components, pricingPostage(input.postage, typical), input.floor) : components[0].decision;
  if (bundle && input.postage != null && pricingPostage(input.postage, typical) < input.postage) decision.why += postageNote(input.postage, typical);
  if (identity.fallback) {
    // Word rules stood in for Claude: say so, and don't let the price look surer than it is.
    decision.why = `${identity.fallback}, so simple word rules were used: check this price. ${decision.why}`;
    decision.confidence = Math.round(decision.confidence * 0.5 * 100) / 100;
  }
  return { at, identity, components, decision, method: bundle ? "sum of parts" : "single" };
}

/** Keeps the decision for learning and for the price label's track record. */
export async function recordDecision(env: Env, itemId: string | null, r: PriceResult) {
  const m = r.components[0]?.market;
  await env.store.pricing.recordDecision({
    item_id: itemId,
    at: r.at,
    grp: r.identity.group,
    strategy: r.decision.strategy,
    price: r.decision.price,
    total: r.decision.total,
    market_price: m?.mNow ?? null,
    predicted_days: r.decision.options[1]?.daysToSell ?? null,
    result: JSON.stringify(r).slice(0, 60_000),
  });
}

const num = (v: any): number | null => {
  const n = Number(typeof v === "object" && v != null ? v["#text"] : v);
  return Number.isFinite(n) ? n : null;
};

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

/**
 * How often the engine looks again for a market for an own-priced listing: the nightly price review re-checks a
 * listing every 6 days, so the look happens there, and the review proposes the engine's price the same night.
 */
export const OWN_PRICE_RECHECK_DAYS = 6;

/** K's own price for a listing with no market to price from: the engine reports it and never moves it. */
export function ownPriceResult(input: PriceInput, own: number): PriceResult {
  return {
    at: Date.now(),
    identity: { ...identifyByRules(input.title), priceable: true, question: null },
    components: [],
    decision: {
      strategy: "own",
      price: own,
      total: r2(own + (input.postage ?? 0)),
      options: [],
      why: "Your own price: there were no sales of this item or anything close to price it from. The engine looks for a market about once a week and prices it as soon as one appears; clear it on Listings to let it price now.",
      confidence: 1,
    },
    method: "single",
  };
}

/**
 * A listing on K's own price. About once a week the engine looks again for a market (K, 2026-11-05: an
 * own-priced listing mustn't be forgotten); as soon as sales of the item or something close turn up, K's price
 * is lifted, K is told, and the engine's price is returned (the nightly review then proposes it as usual).
 */
export async function priceOwned(
  env: Env,
  itemId: string,
  input: PriceInput,
  s: { own_price: number | null; own_price_set_at?: number | null; own_checked_at?: number | null },
  marketCheck: () => Promise<PriceResult>,
  now = Date.now(),
): Promise<PriceResult> {
  const ownPrice = s.own_price!;
  if (now - (s.own_checked_at ?? s.own_price_set_at ?? 0) >= OWN_PRICE_RECHECK_DAYS * DAY) {
    const market = await marketCheck();
    if (market.decision.strategy !== "ask") {
      await env.store.listings.setOwnPrice(itemId, null);
      market.decision.why = `Sales of this item or close matches have appeared, so your own price (£${ownPrice.toFixed(2)}) is lifted and the engine prices it again. ${market.decision.why}`;
      await recordDecision(env, itemId, market);
      await push(env, "A market for your item appeared", `${input.title.slice(0, 60)}: comparable sales found. The engine prices it again; any change comes as a label.`, undefined, `market-${itemId}`).catch(() => {});
      return market;
    }
    await env.store.listings.markOwnChecked(itemId, now);
  }
  const own = ownPriceResult(input, ownPrice);
  await recordDecision(env, itemId, own);
  return own;
}

/** Prices one of K's live listings (read-only eBay calls) and records the decision. */
export async function priceListing(env: Env, itemId: string, api?: MessagesApi): Promise<PriceResult> {
  const input = inputFromItem(await getItem(env, itemId));
  const s = await env.store.listings.getSettings(itemId);
  if (s?.own_price != null)
    return priceOwned(env, itemId, input, s, () => priceItem(env, { ...input, itemId, floor: s.floor_price ?? null, factsFromK: s.notes ?? null, excludeItemIds: [itemId] }, api));
  const r = await priceItem(env, { ...input, itemId, floor: s?.floor_price ?? null, factsFromK: s?.notes ?? null, excludeItemIds: [itemId] }, api);
  await recordDecision(env, itemId, r);
  return r;
}

/**
 * A price for one of K's listings for Claude's checks and Best Offer answers. Always a fresh check, so eBay's
 * live listings (the main benchmark: what the item sells for now) are searched every time; sold data and title
 * grades come from their caches. Only if the fresh check fails (eBay or a provider down) does the latest result
 * from the last `fallbackDays` stand in.
 */
export async function currentPricing(env: Env, itemId: string, fallbackDays = 3, api?: MessagesApi): Promise<PriceResult | null> {
  const stored = async () => {
    const row = await env.store.pricing.latestDecision(itemId, Date.now() - fallbackDays * DAY);
    return row ? (JSON.parse(row.result) as PriceResult) : null;
  };
  if (!providerEnabled(env, "trawl") && !providerEnabled(env, "compsapi")) return stored();
  return priceListing(env, itemId, api).catch(stored);
}
