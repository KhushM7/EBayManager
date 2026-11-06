import type { Env } from "./env";
import { orderLines } from "./store";
import { getRecentOrders } from "./ebay/sell";
import { inputFromItem, priceItem } from "./pricing/engine";
import { getItem } from "./ebay/trading";
import { estimate, providerEnabled, searchSold, wordsFromTitle, type Provider, type SoldEstimate } from "./solddata";

// K's test (docs/sold-price-data.md, docs/pricing-engine.md): price 5 items K has already sold and compare
// with what K actually got. Three columns:
// - each provider on its own, with simple title words (how good is the raw data?);
// - the engine: both providers pooled, Claude's searches and match check, totals including postage, and the
//   market as it was on the day K sold (a backtest), so a later price change doesn't count against it.
// The provider with the smaller error is "used first" where only one is called.

type Column = Provider | "engine";

export interface EngineCell {
  count: number;
  /** Market clearing price (total, with postage) on the day K sold. */
  median: number | null;
  p25: number | null;
  p75: number | null;
  /** What the engine would have recommended then (total), and its strategy. */
  recommended: number | null;
  strategy: string;
  regime: string;
  query: string;
  errorPct: number | null;
  inBand: boolean | null;
  matchedBy: string;
  /** Close (adjusted) matches used alongside the exact ones. */
  close?: number;
  /** What Claude could see: "title", or "title, description, 3 photos". */
  seen?: string;
  note?: string;
}

export interface EvalItem {
  itemId: string;
  title: string;
  /** What K got: item price, or the total with postage for the engine column. */
  actual: number;
  actualTotal?: number | null;
  soldAt?: number | null;
  words: string;
  results: Partial<Record<Provider, (SoldEstimate & { errorPct: number | null; inBand: boolean | null }) | { error: string }>> & {
    engine?: EngineCell | { error: string };
  };
}

export interface EvalResult {
  at: number;
  items: EvalItem[];
  summary: Partial<Record<Column, { priced: number; meanErrorPct: number | null; inBand: number }>>;
  primary: Provider | null;
}

/** Up to n of K's sales spread across the price range, newest title first when prices repeat. */
export function pickSales<T extends { item_id: string; title: string; price: number }>(rows: T[], n = 5): T[] {
  const seen = new Set<string>();
  const distinct = rows.filter((r) => r.price > 0 && r.title && !seen.has(r.title.toLowerCase()) && seen.add(r.title.toLowerCase()));
  const byPrice = [...distinct].sort((a, b) => a.price - b.price);
  if (byPrice.length <= n) return byPrice;
  return Array.from({ length: n }, (_, i) => byPrice[Math.round((i * (byPrice.length - 1)) / (n - 1))]);
}

export function score(items: EvalItem[]): Pick<EvalResult, "summary" | "primary"> {
  const summary: EvalResult["summary"] = {};
  for (const p of ["trawl", "compsapi", "engine"] as Column[]) {
    if (!items.some((i) => i.results[p])) continue;
    const priced = items
      .map((i) => i.results[p])
      .filter((r): r is { errorPct: number; inBand: boolean } & any => !!r && "errorPct" in r && r.errorPct != null);
    summary[p] = {
      priced: priced.length,
      meanErrorPct: priced.length ? Math.round((priced.reduce((s, r) => s + r.errorPct, 0) / priced.length) * 10) / 10 : null,
      inBand: priced.filter((r) => r.inBand).length,
    };
  }
  // The more accurate provider leads; coverage breaks ties and outweighs accuracy on fewer than 3 items.
  const ranked = (Object.entries(summary) as [Column, NonNullable<EvalResult["summary"][Column]>][])
    .filter(([c, s]) => c !== "engine" && s.priced > 0)
    .sort(([, a], [, b]) => (a.priced >= 3) !== (b.priced >= 3) ? (a.priced >= 3 ? -1 : 1) : (a.meanErrorPct ?? 999) - (b.meanErrorPct ?? 999) || b.priced - a.priced);
  return { summary, primary: (ranked[0]?.[0] as Provider) ?? null };
}

const DAY = 86_400_000;
const pct = (est: number, actual: number) => Math.round((Math.abs(est - actual) / actual) * 1000) / 10;

export async function evaluateProviders(env: Env): Promise<EvalResult> {
  // Load K's recent sold history (read-only; eBay gives 90 days). Older sales come from the imported report.
  for (const days of [730, 90]) {
    try {
      const orders = await getRecentOrders(env, days);
      if (orders.length) await env.store.orders.insertIfAbsent(orders);
      break;
    } catch {
      // Try the shorter window.
    }
  }

  // Per-unit price, and the order total (with postage) when the order was just this one item.
  const rows = orderLines(await env.store.orders.all())
    .filter((l) => l.status == null || l.status !== "CANCELLED")
    .map((l) => {
      const qty = Math.max(l.quantity ?? 0, 1);
      return {
        item_id: l.item_id,
        title: l.title,
        price: l.price == null ? (null as unknown as number) : l.price / qty,
        created_at: l.created_at,
        total: l.items_in_order === 1 && qty === 1 ? l.total : null,
      };
    })
    .sort((a, b) => b.created_at - a.created_at);
  // The providers hold about a year of sales, so a backtest of an older sale has little to go on. Prefer
  // sales from the last 11 months; top up with older ones only if there aren't 5.
  const covered = rows.filter((r) => r.created_at > Date.now() - 330 * DAY);
  const picked = covered.length >= 5 || !rows.length ? pickSales(covered.length ? covered : rows) : [...pickSales(covered), ...pickSales(rows.filter((r) => !covered.includes(r)), 5 - pickSales(covered).length)];
  if (!picked.length) throw new Error("No sales found on the eBay account yet, so there's nothing to compare against.");

  const items: EvalItem[] = [];
  for (const sale of picked) {
    const actualTotal = sale.total != null && sale.total >= sale.price ? sale.total : null;
    const item: EvalItem = {
      itemId: sale.item_id,
      title: sale.title,
      actual: sale.price,
      actualTotal,
      soldAt: sale.created_at,
      words: wordsFromTitle(sale.title),
      results: {},
    };
    for (const p of ["trawl", "compsapi"] as Provider[]) {
      if (!providerEnabled(env, p)) continue;
      try {
        const { sales } = await searchSold(env, p, { words: item.words, days: 365 });
        // K's own sale is the answer, so it can't be part of the estimate.
        const est = estimate(
          sales.filter((s) => !s.url?.includes(sale.item_id)),
          { ownTitle: sale.title },
        );
        const errorPct = est.median == null ? null : pct(est.median, sale.price);
        const inBand = est.p25 == null || est.p75 == null ? null : sale.price >= est.p25 && sale.price <= est.p75;
        item.results[p] = { ...est, errorPct, inBand };
      } catch (e) {
        item.results[p] = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    if (providerEnabled(env, "trawl") || providerEnabled(env, "compsapi")) {
      try {
        const postage = actualTotal != null ? Math.round((actualTotal - sale.price) * 100) / 100 : null;
        // The sold listing's description and photos, while eBay still has them (read-only GetItem).
        let facts: { description?: string | null; photos?: string[]; specifics?: Record<string, string>; condition?: string | null } = {};
        try {
          const it = inputFromItem(await getItem(env, sale.item_id));
          facts = { description: it.description, photos: it.photos, specifics: it.specifics, condition: it.condition };
        } catch {
          // Ended too long ago: the title alone.
        }
        const r = await priceItem(env, { title: sale.title, ...facts, postage, excludeItemIds: [sale.item_id], asOf: sale.created_at });
        const m = r.components.length === 1 ? r.components[0].market : null;
        // Bundles: the market price is the sum of the parts' clearing prices plus one postage.
        const marketTotal =
          r.components.length > 1
            ? r.components.every((c) => c.market.mNow != null)
              ? r.components.reduce((s, c) => s + c.market.mNow! - c.typicalPostage, 0) + (postage ?? 0)
              : null
            : m?.mNow ?? null;
        // Compare like with like: totals when K's postage is known, else item prices.
        const typical = r.components[0]?.typicalPostage ?? 0;
        const target = actualTotal ?? sale.price;
        const est = marketTotal == null ? null : actualTotal != null ? marketTotal : marketTotal - typical;
        item.results.engine = {
          count: r.components.reduce((s, c) => s + c.matched.sold, 0),
          median: marketTotal == null ? null : Math.round(marketTotal * 100) / 100,
          p25: m?.p25 ?? null,
          p75: m?.p75 ?? null,
          recommended: r.decision.total,
          strategy: r.decision.strategy,
          regime: r.components.map((c) => c.market.regime).join(" + ") || "unidentified",
          query: r.components.map((c) => c.query).join(" + ") || r.identity.question || "",
          errorPct: est == null ? null : pct(est, target),
          inBand: m?.p25 == null || m?.p75 == null || actualTotal == null ? null : actualTotal >= m.p25 && actualTotal <= m.p75,
          matchedBy: r.components[0]?.matched.by ?? r.identity.by,
          close: r.components.reduce((s, c) => s + c.matched.closeSold, 0),
          seen: ["title", facts.description ? "description" : "", facts.photos?.length ? `${Math.min(3, facts.photos.length)} photos` : ""].filter(Boolean).join(", "),
          note:
            r.components.flatMap((c) => c.errors.filter((e) => e.startsWith("No provider data"))).join(" ") ||
            (sale.created_at < Date.now() - 365 * DAY ? "Sold over a year ago: the providers have little data from before then." : undefined),
        };
      } catch (e) {
        item.results.engine = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    items.push(item);
  }

  const result: EvalResult = { at: Date.now(), items, ...score(items) };
  await env.store.kv.setJson("solddata_eval", result);
  if (result.primary) await env.store.kv.set("solddata_primary", result.primary);
  return result;
}
