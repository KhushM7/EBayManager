import type { Env } from "../env";
import { userToken } from "./auth";
import { assertRest } from "./allowlist";
import { ebayHosts } from "./hosts";
import { watched } from "../services";

// Read-only REST calls to the Sell APIs (Fulfillment orders, Analytics traffic). GET only; nothing here
// changes the account, and the read-only scopes cover both.

async function sellGet(env: Env, path: string): Promise<any> {
  assertRest("GET", `${ebayHosts(env).api}${path}`);
  const token = await userToken(env);
  const res = await watched(env, "ebay", () =>
    fetch(`${ebayHosts(env).api}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE,
        Accept: "application/json",
      },
    }),
  );
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
/** Orders created in the last `days` days (up to two years), in 90-day windows: eBay answers at most 90 days per lookup. */
export async function getRecentOrders(env: Env, days = 90): Promise<Order[]> {
  const DAY = 86_400_000;
  const now = Date.now();
  const out: Order[] = [];
  for (let end = now; end > now - Math.min(days, 730) * DAY; end -= 90 * DAY) {
    const start = Math.max(end - 90 * DAY, now - Math.min(days, 730) * DAY);
    const range = `creationdate:[${new Date(start).toISOString()}..${new Date(end).toISOString()}]`;
    for (let offset = 0; ; offset += 200) {
      const data = await sellGet(env, `/sell/fulfillment/v1/order?filter=${encodeURIComponent(range)}&limit=200&offset=${offset}`);
      out.push(...(data.orders ?? []).map(toOrder));
      if (!data.next || (data.orders ?? []).length === 0) break;
    }
  }
  return out;
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

// --- First-day audit and promotion research (Phase 7): Account, Marketing and Recommendation reads ---

/** The Recommendation API's find call is a read sent as POST (it takes a list of listing IDs). */
async function sellFind(env: Env, path: string, body: unknown): Promise<any> {
  assertRest("POST", `${ebayHosts(env).api}${path}`);
  const token = await userToken(env);
  const res = await watched(env, "ebay", () =>
    fetch(`${ebayHosts(env).api}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  if (res.status === 204) return {};
  if (!res.ok) throw new Error(`POST ${path.split("?")[0]} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export interface ReturnPolicy {
  id: string;
  name: string;
  accepted: boolean;
  periodDays: number | null;
  buyerPaysReturnPostage: boolean | null;
}
export interface PostagePolicy {
  id: string;
  name: string;
  handlingDays: number | null;
  services: { service: string; cost: number | null; free: boolean }[];
  collection: boolean;
}
export interface PaymentPolicy {
  id: string;
  name: string;
  immediatePay: boolean | null;
}
export interface BusinessPolicies {
  returns: ReturnPolicy[];
  postage: PostagePolicy[];
  payment: PaymentPolicy[];
}

/** eBay time durations in days (handling time is in business days). */
const days = (p: any): number | null => (p?.value == null ? null : Number(p.value) * (p.unit === "MONTH" ? 30 : 1));

export function toPolicies(ret: any, ful: any, pay: any): BusinessPolicies {
  return {
    returns: (ret?.returnPolicies ?? []).map((r: any) => ({
      id: String(r.returnPolicyId),
      name: String(r.name ?? ""),
      accepted: r.returnsAccepted === true,
      periodDays: days(r.returnPeriod),
      buyerPaysReturnPostage: r.returnShippingCostPayer ? r.returnShippingCostPayer === "BUYER" : null,
    })),
    postage: (ful?.fulfillmentPolicies ?? []).map((f: any) => ({
      id: String(f.fulfillmentPolicyId),
      name: String(f.name ?? ""),
      handlingDays: days(f.handlingTime),
      services: (f.shippingOptions ?? [])
        .filter((o: any) => o.optionType !== "INTERNATIONAL")
        .flatMap((o: any) => o.shippingServices ?? [])
        .map((s: any) => ({
          service: String(s.shippingServiceCode ?? ""),
          cost: s.shippingCost?.value != null ? Number(s.shippingCost.value) : null,
          free: s.freeShipping === true,
        })),
      collection: f.localPickup === true || f.pickupDropOff === true,
    })),
    payment: (pay?.paymentPolicies ?? []).map((p: any) => ({
      id: String(p.paymentPolicyId),
      name: String(p.name ?? ""),
      immediatePay: typeof p.immediatePay === "boolean" ? p.immediatePay : null,
    })),
  };
}

/**
 * The seller's business policies (postage, returns, payment). An account that hasn't opted in to business
 * policies gets an error from eBay; the audit then reads each listing's own policies instead.
 */
export async function getBusinessPolicies(env: Env): Promise<BusinessPolicies> {
  const q = `?marketplace_id=${env.EBAY_MARKETPLACE}`;
  const [ret, ful, pay] = await Promise.all([
    sellGet(env, `/sell/account/v1/return_policy${q}`),
    sellGet(env, `/sell/account/v1/fulfillment_policy${q}`),
    sellGet(env, `/sell/account/v1/payment_policy${q}`),
  ]);
  return toPolicies(ret, ful, pay);
}

export interface AdState {
  listingId: string;
  campaignId: string;
  campaignName: string;
  /** Ad rate, percent. */
  rate: number | null;
}

/** Listings in running Promoted Listings campaigns, with their ad rates. */
export async function getPromotedListings(env: Env): Promise<AdState[]> {
  const out: AdState[] = [];
  const data = await sellGet(env, `/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&limit=100`);
  for (const c of data.campaigns ?? []) {
    const ads = await sellGet(env, `/sell/marketing/v1/ad_campaign/${encodeURIComponent(c.campaignId)}/ad?limit=500`);
    for (const a of ads.ads ?? [])
      out.push({
        listingId: String(a.listingId),
        campaignId: String(c.campaignId),
        campaignName: String(c.campaignName ?? ""),
        rate: a.bidPercentage != null ? Number(a.bidPercentage) : c.fundingStrategy?.bidPercentage != null ? Number(c.fundingStrategy.bidPercentage) : null,
      });
  }
  return out;
}

export interface AdRecommendation {
  listingId: string;
  /** eBay's suggested ad rate, percent. */
  suggestedRate: number | null;
  /** eBay's own view: RECOMMENDED or UNDETERMINED. */
  recommended: boolean;
}

export function toRecommendations(data: any): AdRecommendation[] {
  return (data?.listingRecommendations ?? []).map((r: any) => {
    const rates = (r.marketing?.ad?.bidPercentages ?? []) as { basis?: string; value?: string }[];
    const pick = rates.find((b) => b.basis === "ITEM") ?? rates.find((b) => b.basis === "TRENDING") ?? rates[0];
    return {
      listingId: String(r.listingId),
      suggestedRate: pick?.value != null && Number.isFinite(Number(pick.value)) ? Number(pick.value) : null,
      recommended: r.marketing?.ad?.promoteWithAd === "RECOMMENDED",
    };
  });
}

/** eBay's suggested ad rate per listing (Recommendation API, read-only). */
export async function getAdRecommendations(env: Env, listingIds: string[]): Promise<AdRecommendation[]> {
  if (!listingIds.length) return [];
  const out: AdRecommendation[] = [];
  for (let i = 0; i < listingIds.length; i += 500) {
    const data = await sellFind(env, `/sell/recommendation/v1/find?filter=${encodeURIComponent("recommendationTypes:{AD}")}`, {
      listingIds: listingIds.slice(i, i + 500),
    });
    out.push(...toRecommendations(data));
  }
  return out;
}
