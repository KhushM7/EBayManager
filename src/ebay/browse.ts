import type { Env } from "../env";
import { assertRest } from "./allowlist";
import { appToken, compsAccess } from "./auth";
import { ebayHosts } from "./hosts";

export interface Comp {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  condition: string;
  url: string;
  /** Cheapest postage shown, GBP; null when not shown (collection only or calculated). */
  shipping: number | null;
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
    shipping: cheapestPostage(s.shippingOptions),
  }));
  return { activeCount: Number(data.total ?? comps.length), ...summarize(comps.map((c) => c.price)), comps };
}

/** Item specifics eBay requires or recommends for a category (Taxonomy, EBAY_GB tree 3), most important first. */
export async function categoryAspects(env: Env, categoryId: string): Promise<{ name: string; required: boolean }[]> {
  const u = new URL(`${ebayHosts(env).api}/commerce/taxonomy/v1/category_tree/3/get_item_aspects_for_category`);
  u.searchParams.set("category_id", categoryId);
  assertRest("GET", u.toString());
  const res = await fetch(u, { headers: { Authorization: `Bearer ${await appToken(env)}` } });
  if (!res.ok) throw new Error(`Taxonomy aspects failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return toAspects(await res.json());
}

export interface CategoryOption {
  id: string;
  name: string;
  /** Parent categories, top first, e.g. "Home, Furniture & DIY > Vacuum Cleaners". */
  path: string;
}

/** eBay's suggested categories for a product description (Taxonomy, EBAY_GB tree 3), best first. Read-only. */
export async function categorySuggestions(env: Env, q: string): Promise<CategoryOption[]> {
  const u = new URL(`${ebayHosts(env).api}/commerce/taxonomy/v1/category_tree/3/get_category_suggestions`);
  u.searchParams.set("q", q.slice(0, 350));
  assertRest("GET", u.toString());
  const res = await fetch(u, { headers: { Authorization: `Bearer ${await appToken(env)}` } });
  if (!res.ok) throw new Error(`Category suggestions failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return toCategoryOptions(await res.json());
}

export function toCategoryOptions(data: any): CategoryOption[] {
  return (data?.categorySuggestions ?? []).slice(0, 8).map((s: any) => ({
    id: String(s.category?.categoryId ?? ""),
    name: String(s.category?.categoryName ?? ""),
    path: [...(s.categoryTreeNodeAncestors ?? [])]
      .reverse()
      .map((a: any) => String(a.categoryName ?? ""))
      .filter((n: string) => n && n !== "Root")
      .join(" > "),
  })).filter((c: CategoryOption) => c.id && c.name);
}

export interface AspectDetail {
  name: string;
  required: boolean;
  /** eBay's suggested values (the first 40); with selectionOnly, the only values eBay accepts. */
  values: string[];
  selectionOnly: boolean;
  multiple: boolean;
}

/** A category's required and recommended item specifics with their allowed values (Taxonomy). Read-only. */
export async function categoryAspectDetails(env: Env, categoryId: string): Promise<AspectDetail[]> {
  const u = new URL(`${ebayHosts(env).api}/commerce/taxonomy/v1/category_tree/3/get_item_aspects_for_category`);
  u.searchParams.set("category_id", categoryId);
  assertRest("GET", u.toString());
  const res = await fetch(u, { headers: { Authorization: `Bearer ${await appToken(env)}` } });
  if (!res.ok) throw new Error(`Taxonomy aspects failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return toAspectDetails(await res.json());
}

export function toAspectDetails(data: any): AspectDetail[] {
  return (data?.aspects ?? [])
    .filter((a: any) => a.aspectConstraint?.aspectRequired || a.aspectConstraint?.aspectUsage === "RECOMMENDED")
    .map((a: any) => ({
      name: String(a.localizedAspectName),
      required: a.aspectConstraint?.aspectRequired === true,
      values: (a.aspectValues ?? []).slice(0, 40).map((v: any) => String(v.localizedValue)),
      selectionOnly: a.aspectConstraint?.aspectMode === "SELECTION_ONLY",
      multiple: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
    }));
}

export function toAspects(data: any): { name: string; required: boolean }[] {
  return (data?.aspects ?? [])
    .filter((a: any) => a.aspectConstraint?.aspectRequired || a.aspectConstraint?.aspectUsage === "RECOMMENDED")
    .map((a: any) => ({ name: String(a.localizedAspectName), required: a.aspectConstraint?.aspectRequired === true }));
}

function cheapestPostage(options: any[] | undefined): number | null {
  const costs = (options ?? []).map((o) => Number(o?.shippingCost?.value)).filter(Number.isFinite);
  return costs.length ? Math.min(...costs) : null;
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
