import type { Env } from "../env";
import { assertRest } from "./allowlist";
import { compsAccess } from "./auth";

export interface Comp {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  condition: string;
  url: string;
}

export interface CompSummary {
  activeCount: number;
  low: number | null;
  median: number | null;
  high: number | null;
  comps: Comp[];
}

/** Active competing listings: the supply side of saturation. Sold prices come from Terapeak or Marketplace Insights. */
export async function searchActiveComps(
  env: Env,
  q: string,
  opts: { conditionIds?: string[]; categoryId?: string; limit?: number } = {},
): Promise<CompSummary> {
  const { token, api } = await compsAccess(env);
  const u = new URL(`${api}/buy/browse/v1/item_summary/search`);
  u.searchParams.set("q", q);
  u.searchParams.set("limit", String(opts.limit ?? 50));
  const filters = ["buyingOptions:{FIXED_PRICE}"];
  if (opts.conditionIds?.length) filters.push(`conditionIds:{${opts.conditionIds.join("|")}}`);
  u.searchParams.set("filter", filters.join(","));
  if (opts.categoryId) u.searchParams.set("category_ids", opts.categoryId);

  assertRest("GET", u.toString());
  const res = await fetch(u, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE,
    },
  });
  if (!res.ok) throw new Error(`Browse search failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const comps: Comp[] = (data.itemSummaries ?? []).map((s: any) => ({
    itemId: s.itemId,
    title: s.title,
    price: Number(s.price?.value ?? 0),
    currency: s.price?.currency ?? "",
    condition: s.condition ?? "",
    url: s.itemWebUrl,
  }));
  return { activeCount: Number(data.total ?? comps.length), ...summarize(comps.map((c) => c.price)), comps };
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)) * 100) / 100;
}

export function summarize(prices: number[]) {
  const s = prices.filter((p) => p > 0).sort((a, b) => a - b);
  return { low: percentile(s, 0.1), median: percentile(s, 0.5), high: percentile(s, 0.9) };
}
