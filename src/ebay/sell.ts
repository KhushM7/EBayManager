import type { Env } from "../env";
import { userToken } from "./auth";
import { ebayHosts } from "./hosts";

// Read-only REST calls to the Sell APIs (Fulfillment orders, Analytics traffic). GET only; nothing here
// changes the account, and the read-only scopes cover both.

async function sellGet(env: Env, path: string): Promise<any> {
  const res = await fetch(`${ebayHosts(env).api}${path}`, {
    headers: {
      Authorization: `Bearer ${await userToken(env)}`,
      "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export interface Order {
  orderId: string;
  createdAt: number;
  total: number | null;
  fees: number | null;
  currency: string | null;
  status: string | null;
  items: { itemId: string; title: string; quantity: number; price: number | null }[];
}

export function toOrder(o: any): Order {
  return {
    orderId: String(o.orderId),
    createdAt: Date.parse(o.creationDate),
    total: o.pricingSummary?.total?.value != null ? Number(o.pricingSummary.total.value) : null,
    fees: o.totalMarketplaceFee?.value != null ? Number(o.totalMarketplaceFee.value) : null,
    currency: o.pricingSummary?.total?.currency ?? null,
    status: o.orderFulfillmentStatus ?? null,
    items: (o.lineItems ?? []).map((li: any) => ({
      itemId: String(li.legacyItemId ?? li.lineItemId),
      title: String(li.title ?? ""),
      quantity: Number(li.quantity ?? 1),
      price: li.lineItemCost?.value != null ? Number(li.lineItemCost.value) : null,
    })),
  };
}

/** Orders created in the last `days` days, across pages. */
export async function getRecentOrders(env: Env, days = 90): Promise<Order[]> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const out: Order[] = [];
  for (let offset = 0; ; offset += 200) {
    const data = await sellGet(env, `/sell/fulfillment/v1/order?filter=${encodeURIComponent(`creationdate:[${from}..]`)}&limit=200&offset=${offset}`);
    out.push(...(data.orders ?? []).map(toOrder));
    if (!data.next || (data.orders ?? []).length === 0) return out;
  }
}

const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** Views and impressions per listing over the last 7 days. */
export async function getTraffic7d(env: Env): Promise<{ itemId: string; views: number; impressions: number }[]> {
  const end = new Date(Date.now() - 86_400_000);
  const start = new Date(end.getTime() - 6 * 86_400_000);
  const filter = `marketplace_ids:{${env.EBAY_MARKETPLACE}},date_range:[${yyyymmdd(start)}..${yyyymmdd(end)}]`;
  const data = await sellGet(
    env,
    `/sell/analytics/v1/traffic_report?dimension=LISTING&metric=LISTING_VIEWS_TOTAL,LISTING_IMPRESSION_TOTAL&filter=${encodeURIComponent(filter)}`,
  );
  return parseTraffic(data);
}

export function parseTraffic(data: any): { itemId: string; views: number; impressions: number }[] {
  const keys: string[] = (data.header?.metrics ?? []).map((m: any) => m.key);
  const at = (rec: any, key: string) => Number(rec.metricValues?.[keys.indexOf(key)]?.value ?? 0);
  return (data.records ?? []).map((rec: any) => ({
    itemId: String(rec.dimensionValues?.[0]?.value),
    views: at(rec, "LISTING_VIEWS_TOTAL"),
    impressions: at(rec, "LISTING_IMPRESSION_TOTAL"),
  }));
}
