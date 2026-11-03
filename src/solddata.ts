import type { Env } from "./env";

// Third-party sold-price data (docs/sold-price-data.md): Trawl (trawl.dev) and CompsAPI (compsapi.com), for
// ebay.co.uk. Neither is an official eBay API, so: only search words are sent (never K's item IDs or account),
// each provider has a hard monthly cap enforced here before any call, results are cached for 30 days, and the
// hosts below are the only ones this module may call.

export type Provider = "trawl" | "compsapi";

/** Hard monthly caps, matching the free tiers. A provider stops being called once its cap is reached. */
export const MONTHLY_CAP: Record<Provider, number> = { trawl: 250, compsapi: 100 };

const HOSTS: Record<Provider, string> = { trawl: "https://api.trawl.dev", compsapi: "https://api.compsapi.com" };
const CACHE_DAYS = 30;
const DAY = 86_400_000;

export interface SoldSale {
  provider: Provider;
  title: string;
  /** Item price paid, GBP, excluding postage. */
  price: number;
  /** Postage, GBP; null when unknown. */
  shipping: number | null;
  condition: string | null;
  dateSold: string | null;
  /** true: an accepted Best Offer at `price`. "listed": a Best Offer sale where only the listed price is known. */
  bestOffer: true | false | "listed" | null;
  url: string | null;
}

export interface SoldQuery {
  /** Words that must all appear in the title. */
  words: string;
  condition?: "new" | "used" | "parts";
  categoryId?: string;
  days?: number;
}

export const providerEnabled = (env: Env, p: Provider) => Boolean(p === "trawl" ? env.TRAWL_API_KEY : env.COMPSAPI_KEY);

const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

export async function usedThisMonth(env: Env, p: Provider): Promise<number> {
  const row = await env.DB.prepare("SELECT used FROM solddata_usage WHERE provider = ? AND month = ?").bind(p, month()).first<{ used: number }>();
  return row?.used ?? 0;
}

async function addUsage(env: Env, p: Provider, n: number) {
  if (n <= 0) return;
  await env.DB.prepare(
    "INSERT INTO solddata_usage (provider, month, used) VALUES (?, ?, ?) ON CONFLICT(provider, month) DO UPDATE SET used = used + excluded.used",
  )
    .bind(p, month(), n)
    .run();
}

export class QuotaReached extends Error {}

// Bump the version when parsing changes, so cached results are re-fetched in the new form.
const CACHE_VERSION = 2;
const cacheKey = (p: Provider, q: SoldQuery) =>
  JSON.stringify([CACHE_VERSION, p, q.words.toLowerCase().trim(), q.condition ?? "", q.categoryId ?? "", q.days ?? 365]);

// --- Provider calls ---

async function callTrawl(env: Env, q: SoldQuery): Promise<{ sales: SoldSale[]; cost: number }> {
  const u = new URL(`${HOSTS.trawl}/ebay/v1/sold`);
  u.searchParams.set("query", q.words);
  u.searchParams.set("site", "EBAY_GB");
  u.searchParams.set("max_pages", "1");
  if (q.condition) u.searchParams.set("condition", q.condition);
  if (q.categoryId) u.searchParams.set("category", q.categoryId);
  u.searchParams.set("date_from", new Date(Date.now() - (q.days ?? 365) * DAY).toISOString().slice(0, 10));
  const res = await fetch(u, { headers: { "x-api-key": env.TRAWL_API_KEY!, Accept: "application/json" } });
  if (res.status === 429 && !res.headers.get("Retry-After")) throw new QuotaReached("Trawl's monthly credits are used up");
  if (!res.ok) throw new Error(`Trawl search failed: ${res.status}`);
  const data: any = await res.json();
  return { sales: parseTrawl(data), cost: Number(data.credits_charged ?? res.headers.get("X-Credits-Charged") ?? 1) };
}

/**
 * Trawl's EBAY_GB sale_price includes eBay's Buyer Protection fee for private sellers (75p + 4% of the first
 * £300 + 2% from £300 to £4,000), which K's own sale prices don't. This takes it back out, so both are
 * measured the same way. (Business sellers' prices have no fee; their few sales come out slightly low.)
 */
export function withoutBuyerFee(paid: number): number {
  const x = paid <= 300 * 1.04 + 0.75 ? (paid - 0.75) / 1.04 : (paid - 6.75) / 1.02;
  return Math.round(Math.max(0, x) * 100) / 100;
}

export function parseTrawl(data: any): SoldSale[] {
  if (data?.currency && data.currency !== "GBP") return [];
  return (data?.results ?? [])
    .filter((r: any) => Number.isFinite(Number(r.sale_price)))
    .map((r: any) => ({
      provider: "trawl" as const,
      title: String(r.title ?? ""),
      price: withoutBuyerFee(Number(r.sale_price)),
      shipping: r.shipping_price == null ? null : Number(r.shipping_price),
      condition: r.condition ?? null,
      dateSold: r.date_sold ?? null,
      // Trawl's sale_price is the listed price on Best Offer sales (outside Collectibles).
      bestOffer: /best offer/i.test(String(r.buying_format ?? "")) ? ("listed" as const) : false,
      url: r.item_link ?? null,
    }));
}

async function callCompsApi(env: Env, q: SoldQuery): Promise<{ sales: SoldSale[]; cost: number }> {
  const u = new URL(`${HOSTS.compsapi}/v1/sold`);
  u.searchParams.set("q", q.words);
  u.searchParams.set("site", "UK");
  u.searchParams.set("native_price", "1");
  u.searchParams.set("best_offer", "1");
  u.searchParams.set("size", "240");
  u.searchParams.set("days", String(Math.min(q.days ?? 365, 365)));
  if (q.condition) u.searchParams.set("condition", q.condition);
  if (q.categoryId) u.searchParams.set("category", q.categoryId);
  const res = await fetch(u, { headers: { "X-API-Key": env.COMPSAPI_KEY!, "User-Agent": "EBayManager/1.0", Accept: "application/json" } });
  if (res.status === 429 && !res.headers.get("Retry-After")) throw new QuotaReached("CompsAPI's monthly requests are used up");
  if (!res.ok) throw new Error(`CompsAPI search failed: ${res.status}`);
  return { sales: parseCompsApi(await res.json()), cost: 1 };
}

/** CompsAPI prices are USD; GBP comes from native_price. Rows without it use the rate implied by the others. */
export function parseCompsApi(data: any): SoldSale[] {
  const items: any[] = data?.items ?? [];
  const rates = items
    .filter((i) => i.native_currency === "GBP" && Number(i.native_price) > 0 && Number(i.price) > 0)
    .map((i) => Number(i.native_price) / Number(i.price))
    .sort((a, b) => a - b);
  const rate = rates.length ? rates[Math.floor(rates.length / 2)] : null;
  return items
    .map((i): SoldSale | null => {
      const gbp = i.native_currency === "GBP" && Number(i.native_price) > 0 ? Number(i.native_price) : rate && Number(i.price) > 0 ? Number(i.price) * rate : null;
      if (gbp == null) return null;
      return {
        provider: "compsapi",
        title: String(i.title ?? ""),
        price: Math.round(gbp * 100) / 100,
        // CompsAPI's shipping_cost is a per-listing average, not what the buyer paid: postage comes from elsewhere.
        shipping: null,
        condition: i.condition ?? null,
        dateSold: i.last_sold ?? null,
        bestOffer: i.best_offer === true ? true : i.best_offer === false ? false : null,
        url: i.url ?? null,
      };
    })
    .filter((s): s is SoldSale => s !== null);
}

/** Sold sales for a search: from the 30-day cache, else one call within the provider's monthly cap. */
export async function searchSold(env: Env, p: Provider, q: SoldQuery): Promise<{ sales: SoldSale[]; cached: boolean }> {
  if (!providerEnabled(env, p)) throw new Error(`${p} isn't set up (no API key)`);
  const key = cacheKey(p, q);
  const hit = await env.DB.prepare("SELECT sales FROM solddata_cache WHERE key = ? AND fetched_at > ?")
    .bind(key, Date.now() - CACHE_DAYS * DAY)
    .first<{ sales: string }>();
  if (hit) return { sales: JSON.parse(hit.sales), cached: true };

  if ((await usedThisMonth(env, p)) >= MONTHLY_CAP[p]) throw new QuotaReached(`${p} has used this month's ${MONTHLY_CAP[p]} searches`);
  const { sales, cost } = p === "trawl" ? await callTrawl(env, q) : await callCompsApi(env, q);
  await addUsage(env, p, cost);
  await env.DB.prepare("INSERT OR REPLACE INTO solddata_cache (key, provider, fetched_at, sales) VALUES (?, ?, ?, ?)")
    .bind(key, p, Date.now(), JSON.stringify(sales))
    .run();
  return { sales, cached: false };
}

// --- From sales to an estimate ---

const JUNK = /\b(lot|job ?lot|bundle|joblot|spares|for parts|faulty|broken|box only|empty box|manual only|case only|read description)\b/gi;

/**
 * A junk title, unless the junk words are part of what K is selling: "Lot of 2 Pairs" is junk for a single
 * pair, but the right comparison for K's own "3D Glasses Lot of 2".
 */
export function isJunk(title: string, ownTitle?: string): boolean {
  const own = (ownTitle ?? "").toLowerCase();
  return [...title.matchAll(JUNK)].some((m) => !own.includes(m[0].toLowerCase()));
}

export interface SoldEstimate {
  count: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  /** Share of sales that were Best Offers (accepted, or listed price only). */
  bestOfferShare: number;
  /** Sales left out: junk titles, outliers, or Best Offers known only at the listed price. */
  excluded: number;
}

const quantile = (s: number[], q: number) => {
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return Math.round((s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)) * 100) / 100;
};

/**
 * Item price excluding postage, which is how K's own sales are recorded. Junk titles and outliers (outside
 * 1.5 IQR) are dropped, and so are Best Offer sales whose accepted price isn't known, since the listed price
 * overstates what the buyer paid.
 */
export function estimate(sales: SoldSale[], opts: { excludeTitle?: (t: string) => boolean; ownTitle?: string } = {}): SoldEstimate {
  const usable = sales.filter((s) => s.price > 0 && !isJunk(s.title, opts.ownTitle) && !opts.excludeTitle?.(s.title) && s.bestOffer !== "listed");
  const prices = usable.map((s) => s.price).sort((a, b) => a - b);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const kept = q1 == null || q3 == null ? prices : prices.filter((p) => p >= q1 - 1.5 * (q3 - q1) && p <= q3 + 1.5 * (q3 - q1));
  const bo = sales.filter((s) => s.bestOffer === true || s.bestOffer === "listed").length;
  return {
    count: kept.length,
    median: quantile(kept, 0.5),
    p25: quantile(kept, 0.25),
    p75: quantile(kept, 0.75),
    bestOfferShare: sales.length ? Math.round((bo / sales.length) * 100) / 100 : 0,
    excluded: sales.length - kept.length,
  };
}

/** Search words from a title: brand, model and key attributes, without filler and condition words. */
export function wordsFromTitle(title: string, max = 6): string {
  const stop = new Set(["test", "the", "a", "an", "and", "with", "for", "of", "in", "new", "used", "brand", "boxed", "unboxed", "genuine", "great", "good", "very", "condition", "free", "postage", "uk", "fast", "rare", "complete", "excellent", "working", "tested"]);
  return title
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .split(/\s+/)
    // Single characters are dropped, except digits: the "2" in "Buds 2 Pro" is a different product.
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !stop.has(w.toLowerCase()))
    .slice(0, max)
    .join(" ");
}

/** eBay item number from a listing URL, for removing the same sale seen by both providers. */
export function itemNumber(url: string | null): string | null {
  return url?.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/)?.[1] ?? null;
}

/**
 * Both providers' sales as one list, each eBay sale once. Where both saw it, the record with the real price
 * wins (CompsAPI knows accepted Best Offer prices; Trawl has only the listed price), and gaps such as
 * postage are filled from the other.
 */
export function poolSales(...lists: SoldSale[][]): SoldSale[] {
  const byId = new Map<string, SoldSale>();
  const rest: SoldSale[] = [];
  for (const s of lists.flat()) {
    const id = itemNumber(s.url);
    const had = id ? byId.get(id) : undefined;
    if (!id) rest.push(s);
    else if (!had) byId.set(id, s);
    else {
      const [known, other] = had.bestOffer === "listed" && s.bestOffer !== "listed" ? [s, had] : [had, s];
      byId.set(id, {
        ...known,
        shipping: known.shipping ?? other.shipping,
        dateSold: known.dateSold ?? other.dateSold,
        condition: known.condition ?? other.condition,
      });
    }
  }
  return [...byId.values(), ...rest];
}
