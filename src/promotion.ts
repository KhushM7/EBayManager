import type { Env } from "./env";
import { getAdRecommendations, getPromotedListings, type AdRecommendation, type AdState } from "./ebay/sell";
import { getItem } from "./ebay/trading";
import { DEFAULT_PARAMS, daysToSell, hazard, value, type MarketState, type SaleParams } from "./pricing/model";
import { inputFromItem, paramsFor, type PriceResult } from "./pricing/engine";
import { proposeAndNotify } from "./proposals";

// Promotion research (docs/pricing-and-promotion.md, "Promoted Listings"). Promoted Listings is proposed only
// when the market is saturated, the listing needs to be seen, and a low "general" (cost per sale) rate pays
// back under the pricing engine's own sale model. The rate stays at most half of eBay's suggestion. Every
// suggestion is a `promote` proposal K approves; promotion never applies automatically (LOCKED_KINDS).

export const PROMO = {
  /** eBay's minimum general ad rate, percent. */
  minRate: 2,
  /** Highest rate the app proposes, percent. */
  maxRate: 4,
  /** Never more than this share of eBay's suggested rate. */
  maxShareOfSuggested: 0.5,
  /** Proposed rate as a share of eBay's suggestion, before the limits above. */
  shareOfSuggested: 0.4,
  /**
   * How much more likely a promoted listing is to sell each day in a crowded market (1.25 = 25% more).
   * An assumption until the 14-day reviews give real before-and-after numbers; kept modest on purpose.
   */
  lift: 1.25,
  /** Promotion must add at least this much expected profit, GBP, to be worth proposing. */
  minGain: 0.25,
  /** Saturated: this many weeks of supply or more at the recent sales rate. */
  saturatedWeeks: 6,
  /** Saturated when there are no recent sales to measure weeks of supply: this many matching listings. */
  saturatedSupply: 8,
  /** Few impressions in 7 days for a listing at least a week old. */
  lowImpressions: 100,
  /** A listing that has sat this long without selling needs a push. */
  longSitDays: 30,
} as const;

export interface PromotionInput {
  price: number;
  postage: number;
  floor: number | null;
  listedDays: number;
  views7d: number | null;
  impressions7d: number | null;
  market: MarketState | null;
  params?: SaleParams;
  /** eBay's suggested rate, percent; null when eBay gave none. */
  suggestedRate: number | null;
  ebayRecommends: boolean | null;
  /** The listing's current ad, if it's already promoted. */
  currentRate: number | null;
}

export interface PromotionAdvice {
  action: "promote" | "lower" | "end" | "none";
  /** Proposed rate, percent. */
  rate: number | null;
  why: string;
  saturated: boolean;
  needsVisibility: boolean;
  payback: { daysNow: number; daysPromoted: number; valueNow: number; valuePromoted: number; adFee: number } | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const halfStep = (x: number) => Math.round(x * 2) / 2;

/** Is the market crowded enough that promotion could matter? */
export function isSaturated(m: MarketState | null): boolean {
  if (!m || m.regime === "thin") return false;
  if (m.weeksOfSupply != null) return m.weeksOfSupply >= PROMO.saturatedWeeks;
  return m.supply >= PROMO.saturatedSupply;
}

/** The rate the app would propose, percent, or null when eBay's suggestion leaves no room under the limits. */
export function proposedRate(suggested: number | null): number | null {
  if (suggested == null) return PROMO.minRate;
  const ceiling = Math.min(PROMO.maxRate, suggested * PROMO.maxShareOfSuggested);
  if (ceiling < PROMO.minRate) return null;
  return Math.min(ceiling, Math.max(PROMO.minRate, halfStep(suggested * PROMO.shareOfSuggested)));
}

export function promotionAdvice(i: PromotionInput): PromotionAdvice {
  const m = i.market;
  const saturated = isSaturated(m);
  const lowImpressions = i.impressions7d != null && i.listedDays >= 7 && i.impressions7d < PROMO.lowImpressions;
  const longSit = i.listedDays >= PROMO.longSitDays;
  const needsVisibility = lowImpressions || longSit;
  const none = (why: string, action: PromotionAdvice["action"] = "none"): PromotionAdvice => ({
    action,
    rate: null,
    why,
    saturated,
    needsVisibility,
    payback: null,
  });
  const promoted = i.currentRate != null;
  const stop = (why: string) => (promoted ? none(`${why} The current ${i.currentRate}% ad isn't paying for itself, so end it.`, "end") : none(why));

  // No evidence either way is never a reason to change anything.
  if (!m || m.mNow == null)
    return none(`No market picture for this item yet, so promotion can't be judged${promoted ? `; it stays at its current ${i.currentRate}% until there is one` : ""}.`);
  if (m.regime === "thin") return stop("A thin market: few others sell this, so the listing already shows near the top.");
  if (!saturated)
    return stop(
      `Not saturated: ${m.weeksOfSupply != null ? `${m.weeksOfSupply.toFixed(1)} weeks of supply` : `${m.supply} matching listings`}, under the ${PROMO.saturatedWeeks}-week mark.`,
    );
  if (!needsVisibility && !promoted) return none("The market is crowded, but this listing is new and being seen; wait before paying for ads.");

  const rate = proposedRate(i.suggestedRate);
  if (rate == null)
    return stop(`eBay suggests ${i.suggestedRate}%; half of that is below eBay's ${PROMO.minRate}% minimum, which means the listing already ranks well.`);

  const total = i.price + i.postage;
  const fee = r2((total * rate) / 100);
  if (i.floor != null && i.price - fee < i.floor) return stop(`A ${rate}% ad fee (£${fee.toFixed(2)}) would take the sale below your floor of £${i.floor.toFixed(2)}.`);

  const params = i.params ?? DEFAULT_PARAMS;
  const d = Math.max(m.demand28, m.demand91, 1 / 180);
  const h0 = hazard(total, m.mNow, d, m.supply, params);
  const h1 = Math.min(0.95, h0 * PROMO.lift);
  const v0 = value(total, h0, { postage: i.postage });
  const v1 = value(total, h1, { postage: i.postage, adRate: rate / 100 });
  const payback = { daysNow: Math.round(daysToSell(h0)), daysPromoted: Math.round(daysToSell(h1)), valueNow: r2(v0), valuePromoted: r2(v1), adFee: fee };
  if (v1 - v0 < PROMO.minGain)
    return { ...stop(`At ${rate}% the faster sale (about ${payback.daysPromoted} days instead of ${payback.daysNow}) doesn't cover the £${fee.toFixed(2)} fee.`), payback };

  const suggestion = i.suggestedRate != null ? `eBay suggests ${i.suggestedRate}%` : "eBay gave no suggested rate";
  const reasonSeen = lowImpressions ? `only ${i.impressions7d} search impressions in 7 days` : `${i.listedDays} days listed without a sale`;
  const why =
    `Saturated market (${m.weeksOfSupply != null ? `${m.weeksOfSupply.toFixed(1)} weeks of supply` : `${m.supply} matching listings`}) and ${reasonSeen}. ` +
    `A ${rate}% general ad (paid only if it sells through the ad: £${fee.toFixed(2)}) should cut the expected wait from about ${payback.daysNow} to ${payback.daysPromoted} days ` +
    `and adds about £${(v1 - v0).toFixed(2)} in expected value. ${suggestion}.`;

  if (promoted) {
    if (i.currentRate! > rate + 0.01) return { action: "lower", rate, why: `Currently ${i.currentRate}%, more than needed. ${why}`, saturated, needsVisibility, payback };
    return { ...none(`Already promoted at ${i.currentRate}%, within the limits.`), payback };
  }
  return { action: "promote", rate, why, saturated, needsVisibility, payback };
}

export interface ListingPromotion {
  itemId: string;
  title: string;
  advice: PromotionAdvice;
  suggestedRate: number | null;
  ebayRecommends: boolean | null;
  currentRate: number | null;
}

/** Promotion advice for each listing, from each one's latest market picture. Read-only on eBay. */
export async function researchPromotion(
  env: Env,
  listings: { itemId: string; title: string; item?: any }[],
  errors: string[] = [],
): Promise<ListingPromotion[]> {
  let recs: AdRecommendation[] = [];
  let ads: AdState[] = [];
  try {
    recs = await getAdRecommendations(env, listings.map((l) => l.itemId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The Recommendation API needs the full sell.inventory permission, which K grants only at go-live.
    errors.push(
      / 403 /.test(msg)
        ? "eBay's suggested ad rates need the full eBay permission granted at go-live, so they're unavailable while read-only (eBay gives none for listings already in a campaign anyway)"
        : `eBay ad suggestions: ${msg}`,
    );
  }
  try {
    ads = await getPromotedListings(env);
  } catch (e) {
    errors.push(`Promoted Listings campaigns: ${e instanceof Error ? e.message : String(e)}`);
  }

  const out: ListingPromotion[] = [];
  for (const l of listings) {
    const row = await env.DB.prepare("SELECT result FROM price_decisions WHERE item_id = ? AND at > ? ORDER BY at DESC LIMIT 1")
      .bind(l.itemId, Date.now() - 14 * 86_400_000)
      .first<{ result: string }>();
    const priced: PriceResult | null = row ? JSON.parse(row.result) : null;
    // A bundle's market is the sum of several; promotion is judged only on single items.
    const market = priced && priced.method === "single" ? (priced.components[0]?.market ?? null) : null;
    const traffic = await env.DB.prepare("SELECT views_7d, impressions_7d FROM listing_traffic WHERE item_id = ? ORDER BY taken_at DESC LIMIT 1")
      .bind(l.itemId)
      .first<{ views_7d: number | null; impressions_7d: number | null }>();
    const floor = await env.DB.prepare("SELECT floor_price FROM item_settings WHERE item_id = ?").bind(l.itemId).first<{ floor_price: number | null }>();
    const rec = recs.find((r) => r.listingId === l.itemId);
    const ad = ads.find((a) => a.listingId === l.itemId);
    let item = l.item;
    if (!item && market)
      try {
        item = await getItem(env, l.itemId);
      } catch (e) {
        errors.push(`${l.itemId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    const input = item ? inputFromItem(item) : null;
    const advice = promotionAdvice({
      price: input?.current ?? 0,
      postage: input?.postage ?? priced?.components[0]?.typicalPostage ?? 0,
      floor: floor?.floor_price ?? null,
      listedDays: input?.listedDays ?? 0,
      views7d: traffic?.views_7d ?? null,
      impressions7d: traffic?.impressions_7d ?? null,
      market: input?.current ? market : null,
      params: priced ? await paramsFor(env, priced.identity.group) : undefined,
      suggestedRate: rec?.suggestedRate ?? null,
      ebayRecommends: rec ? rec.recommended : null,
      currentRate: ad?.rate ?? null,
    });
    out.push({ itemId: l.itemId, title: l.title, advice, suggestedRate: rec?.suggestedRate ?? null, ebayRecommends: rec ? rec.recommended : null, currentRate: ad?.rate ?? null });
  }
  return out;
}

/**
 * Files a `promote` proposal for each listing whose advice is promote, lower or end, unless one is already
 * waiting or K rejected one in the last 14 days. Returns how many were proposed.
 */
export async function proposePromotions(env: Env, found: ListingPromotion[]): Promise<number> {
  let n = 0;
  for (const p of found) {
    if (p.advice.action === "none") continue;
    const recent = await env.DB.prepare(
      "SELECT 1 FROM proposals WHERE item_id = ? AND kind = 'promote' AND (status IN ('pending', 'approved') OR (status = 'rejected' AND decided_at > ?))",
    )
      .bind(p.itemId, Date.now() - 14 * 86_400_000)
      .first();
    if (recent) continue;
    const a = p.advice;
    const title = a.action === "promote" ? `Promote at ${a.rate}%` : a.action === "lower" ? `Lower ad rate to ${a.rate}%` : "End promotion";
    await proposeAndNotify(
      env,
      {
        kind: "promote",
        itemId: p.itemId,
        payload: {
          itemTitle: p.title,
          action: a.action,
          rate: a.rate,
          currentRate: p.currentRate,
          suggestedRate: p.suggestedRate,
          ebayRecommends: p.ebayRecommends,
          campaign: "General (cost per sale)",
          payback: a.payback,
        },
        reason: a.why,
      },
      `${title}: ${p.title}`,
      a.why,
    );
    n++;
  }
  return n;
}

/** Nightly: promotion advice for listings the engine priced recently. */
export async function reviewPromotions(env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT s.item_id, s.title FROM listing_snapshots s
     WHERE s.taken_at = (SELECT MAX(taken_at) FROM listing_snapshots)
       AND EXISTS (SELECT 1 FROM price_decisions d WHERE d.item_id = s.item_id AND d.at > ?)`,
  )
    .bind(Date.now() - 14 * 86_400_000)
    .all<{ item_id: string; title: string }>();
  if (!results.length) return "no listings with a recent market picture";
  const errors: string[] = [];
  const found = await researchPromotion(env, results.map((r) => ({ itemId: r.item_id, title: r.title })), errors);
  const proposed = await proposePromotions(env, found);
  return `${found.length} checked, ${proposed} proposed${errors.length ? `; ${errors.join("; ").slice(0, 200)}` : ""}`;
}
