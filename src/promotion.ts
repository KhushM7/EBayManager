import type { Env } from "./env";
import { getAdRecommendations, getPromotedListings, type AdRecommendation, type AdState } from "./ebay/sell";
import { getItem } from "./ebay/trading";
import { DEFAULT_PARAMS, daysToSell, hazard, value, type MarketState, type SaleParams } from "./pricing/model";
import { inputFromItem, paramsFor, type PriceResult } from "./pricing/engine";
import { proposeAndNotify } from "./proposals";
import { r2 } from "./util";
import { PROMOTION_RATE } from "./rules";

// Promotion research (docs/pricing-and-promotion.md, "Promoted Listings"). Promoted Listings is proposed only
// when the listing isn't being seen (few search impressions, or hardly any views and no watchers after two
// weeks: K, 2026-11-15), and a low "general" (cost per sale) rate pays back under the pricing engine's own sale
// model. A listing people do see and watch doesn't need an ad, however long it has sat: its lever is the price
// or an offer to its watchers. A saturated market is no longer required, only that the market isn't thin. The rate stays at most half of eBay's suggestion. Every
// suggestion is a `promote` proposal K approves; promotion never applies automatically (LOCKED_KINDS).

export const PROMO = {
  /** eBay's minimum general ad rate, percent. */
  minRate: PROMOTION_RATE.min,
  /** Highest rate the app proposes, percent. */
  maxRate: PROMOTION_RATE.max,
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
  /** Hardly any views: fewer than this in 7 days, with no watchers, for a listing at least `unseenDays` old. */
  lowViews: 5,
  unseenDays: 14,
} as const;

export interface PromotionInput {
  price: number;
  postage: number;
  floor: number | null;
  listedDays: number;
  views7d: number | null;
  impressions7d: number | null;
  /** People watching the listing; null when unknown. */
  watchers?: number | null;
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
  // Not being seen: hardly any views and nobody watching after two weeks. Days listed alone are no reason: a
  // listing with views and watchers is being seen, and an ad wouldn't change why it hasn't sold.
  const unseen = i.views7d != null && i.listedDays >= PROMO.unseenDays && i.views7d < PROMO.lowViews && (i.watchers ?? 0) === 0;
  const needsVisibility = lowImpressions || unseen;
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
  // A listing that's already promoted may be seen because of its ad, so "it's being seen" is no reason to end
  // it: whether the ad is working is the 14-day review's question (promotionReview). Here only its rate is checked.
  if (!needsVisibility && !saturated && !promoted)
    return none(
      `It's being seen${i.views7d != null ? ` (${i.views7d} views in 7 days${i.watchers ? `, ${i.watchers} watching` : ""})` : ""} and the market isn't crowded (${m.weeksOfSupply != null ? `${m.weeksOfSupply.toFixed(1)} weeks of supply` : `${m.supply} matching listings`}), so an ad wouldn't help: the price or an offer to watchers is the lever.`,
    );
  if (!needsVisibility && !promoted)
    return none(
      i.views7d == null && i.impressions7d == null
        ? "No view figures for this listing yet, so there's nothing to say it isn't being seen."
        : `The market is crowded, but this listing is being seen${i.views7d != null ? ` (${i.views7d} views in 7 days${i.watchers ? `, ${i.watchers} watching` : ""})` : ""}: an ad isn't what it needs.`,
    );

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
  // Already promoted: only its rate is this check's business. Whether the ad is working is judged from what
  // happened to the listing's views after it started (the 14-day review), not from the sale model.
  if (promoted) {
    if (i.currentRate! > rate + 0.01) return { action: "lower", rate, why: `Currently ${i.currentRate}%, more than needed: ${rate}% is ${i.suggestedRate != null ? `under half of eBay's suggested ${i.suggestedRate}%` : "eBay's minimum"} and enough to be shown.`, saturated, needsVisibility, payback };
    return { ...none(`Already promoted at ${i.currentRate}%, within the limits; the 14-day review judges whether it's working.`), payback };
  }
  if (v1 - v0 < PROMO.minGain)
    return { ...stop(`At ${rate}% the better chance of a sale doesn't cover the £${fee.toFixed(2)} fee.`), payback };

  const suggestion = i.suggestedRate != null ? `eBay suggests ${i.suggestedRate}%` : "eBay gave no suggested rate";
  const reasonSeen = lowImpressions
    ? `only ${i.impressions7d} search impressions in 7 days`
    : unseen
      ? `only ${i.views7d} view${i.views7d === 1 ? "" : "s"} in 7 days and nobody watching after ${i.listedDays} days`
      : "it's already promoted";
  const crowd = `${saturated ? "A crowded market" : "Market"}: ${m.weeksOfSupply != null ? `${m.weeksOfSupply.toFixed(1)} weeks of supply` : `${m.supply} matching listings`}`;
  const why =
    `Not being seen: ${reasonSeen}. ${crowd}. ` +
    `A ${rate}% general ad (paid only if it sells through the ad: £${fee.toFixed(2)}) puts it in front of more buyers, ` +
    `and on the engine's figures adds about £${(v1 - v0).toFixed(2)} in expected value. ${suggestion}.`;

  return { action: "promote", rate, why, saturated, needsVisibility, payback };
}

export interface ListingPromotion {
  itemId: string;
  title: string;
  advice: PromotionAdvice;
  /** The listing's traffic when it was judged: the "before" of the 14-day review. */
  traffic?: Traffic;
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
    const row = await env.store.pricing.latestDecision(l.itemId, Date.now() - 14 * 86_400_000);
    const priced: PriceResult | null = row ? JSON.parse(row.result) : null;
    // A bundle's market is the sum of several; promotion is judged only on single items.
    const market = priced && priced.method === "single" ? (priced.components[0]?.market ?? null) : null;
    const traffic = await env.store.listings.latest(l.itemId);
    const floor = await env.store.listings.getSettings(l.itemId);
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
      watchers: traffic?.watch_count ?? null,
      market: input?.current ? market : null,
      params: priced ? await paramsFor(env, priced.identity.group) : undefined,
      suggestedRate: rec?.suggestedRate ?? null,
      ebayRecommends: rec ? rec.recommended : null,
      currentRate: ad?.rate ?? null,
    });
    out.push({ itemId: l.itemId, title: l.title, advice, traffic: { views7d: traffic?.views_7d ?? null, impressions7d: traffic?.impressions_7d ?? null, watchers: traffic?.watch_count ?? null, at: Date.now() }, suggestedRate: rec?.suggestedRate ?? null, ebayRecommends: rec ? rec.recommended : null, currentRate: ad?.rate ?? null });
  }
  return out;
}

/**
 * Files a `promote` proposal for each listing whose advice is promote, lower or end, unless one is already
 * waiting or K rejected one in the last 14 days. Returns how many were proposed.
 */
export async function proposePromotions(env: Env, found: ListingPromotion[], ladder?: Map<string, { rung: string; why: string }>): Promise<number> {
  let n = 0;
  for (const p of found) {
    if (p.advice.action === "none") continue;
    // The sales ladder (src/ladder.ts): a new promotion only when promotion is this listing's step tonight.
    // Lowering or ending an ad isn't a push, so those go ahead.
    if (ladder && p.advice.action === "promote" && ladder.get(p.itemId)?.rung !== "promote") continue;
    const since = Date.now() - 14 * 86_400_000;
    const earlier = await env.store.proposals.listWhere([
      { f: "item_id", op: "=", v: p.itemId },
      { f: "kind", op: "=", v: "promote" },
    ]);
    if (earlier.some((x) => x.status === "pending" || x.status === "approved" || (x.status === "rejected" && (x.decided_at ?? 0) > since))) continue;
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
          baseline: p.traffic ?? null,
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
export async function reviewPromotions(env: Env, ladder?: Map<string, { rung: string; why: string }>): Promise<string> {
  const recent = new Set((await env.store.pricing.latestDecisions(Date.now() - 14 * 86_400_000)).map((d) => d.item_id));
  const results = (await env.store.listings.latestSet()).filter((s) => recent.has(s.item_id));
  if (!results.length) return "no listings with a recent market picture";
  const errors: string[] = [];
  const found = await researchPromotion(env, results.map((r) => ({ itemId: r.item_id, title: r.title })), errors);
  const proposed = await proposePromotions(env, found, ladder);
  return `${found.length} checked, ${proposed} proposed${errors.length ? `; ${errors.join("; ").slice(0, 200)}` : ""}`;
}

// --- The 14-day review (K, 2026-11-15) ---
//
// An ad is there to get the listing seen. Two weeks after a promotion is applied, and every two weeks while it
// runs, the listing's traffic is compared with what it was when the ad was proposed. If no more people are
// seeing it, the ad isn't doing its job (and with eBay's attribution it could still take its fee from a sale it
// didn't cause), so an "end" label is filed for K. If it's working, it stays and K gets a short note.

export interface Traffic {
  views7d: number | null;
  impressions7d: number | null;
  watchers: number | null;
  at: number;
}

export const PROMO_REVIEW = {
  /** Days an ad runs before it's judged, and between later reviews. */
  afterDays: 14,
  /** Working: search impressions up by this share, */
  impressionsUp: 0.25,
  /** or views up by this share and at least this many, */
  viewsUp: 0.5,
  minExtraViews: 3,
  /** or someone new watching. */
} as const;

export interface PromotionVerdict {
  verdict: "working" | "not_working" | "unknown";
  why: string;
}

/** Did the ad get the listing seen? Pure. */
export function promotionReview(before: Traffic | null, now: Traffic, rate: number | null, days: number): PromotionVerdict {
  const ad = `${rate ?? "?"}% ad, ${days} days on`;
  if (!before || (before.impressions7d == null && before.views7d == null)) return { verdict: "unknown", why: `${ad}: there are no figures from before it started to compare with. Tonight's are kept as the starting point for the next review.` };
  if (now.impressions7d == null && now.views7d == null) return { verdict: "unknown", why: `${ad}: eBay gave no view figures tonight, so it's judged at the next review.` };
  const change = (a: number | null, b: number | null, word: string) => (a == null || b == null ? null : `${word} ${a} to ${b}`);
  const figures = [change(before.impressions7d, now.impressions7d, "search impressions in 7 days"), change(before.views7d, now.views7d, "views"), change(before.watchers, now.watchers, "watchers")].filter(Boolean).join(", ");
  const impressionsUp = before.impressions7d != null && now.impressions7d != null && now.impressions7d >= before.impressions7d * (1 + PROMO_REVIEW.impressionsUp) && now.impressions7d > before.impressions7d;
  const viewsUp = before.views7d != null && now.views7d != null && now.views7d - before.views7d >= PROMO_REVIEW.minExtraViews && now.views7d >= before.views7d * (1 + PROMO_REVIEW.viewsUp);
  const watchersUp = before.watchers != null && now.watchers != null && now.watchers > before.watchers;
  if (impressionsUp || viewsUp || watchersUp) return { verdict: "working", why: `${ad}: more people are seeing it (${figures}). Keep it.` };
  return { verdict: "not_working", why: `${ad}: no more people are seeing it (${figures}). It isn't doing its job, so end it; the price or the listing itself is what to look at.` };
}

/**
 * Nightly: reviews each ad the app applied once it has run 14 days, and every 14 days after. Files an "end" label
 * for one that isn't working; notes the ones that are. Reads the store only (the nightly's own snapshot and traffic).
 */
export async function reviewRunningPromotions(env: Env, now = Date.now()): Promise<string> {
  const DAY = 86_400_000;
  const all = await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "promote" }]);
  const live = new Map((await env.store.listings.latestSet()).map((l) => [l.item_id, l]));
  let reviewed = 0;
  let ending = 0;
  const notes: string[] = [];
  for (const [itemId, l] of live) {
    const mine = all.filter((p) => p.item_id === itemId);
    const applied = mine.filter((p) => p.status === "applied").sort((a, b) => (b.decided_at ?? 0) - (a.decided_at ?? 0));
    if (!applied.length) continue;
    const latest = JSON.parse(applied[0].payload);
    if (latest.action === "end") continue; // not promoted any more
    // The ad started with the latest "promote"; a later "lower" changed its rate, not its start.
    const start = applied.find((p) => JSON.parse(p.payload).action === "promote") ?? applied[0];
    const key = `promo_review:${itemId}`;
    const last = await env.store.kv.getJson<{ at: number; traffic: Traffic }>(key).catch(() => null);
    const since = last && last.at > (start.decided_at ?? 0) ? last.at : (start.decided_at ?? start.created_at);
    if (now - since < PROMO_REVIEW.afterDays * DAY) continue;
    if (mine.some((p) => p.status === "pending" || p.status === "approved")) continue; // a change is already waiting
    const tonight: Traffic = { views7d: l.views_7d, impressions7d: l.impressions_7d, watchers: l.watch_count ?? null, at: now };
    const before: Traffic | null = last && last.at > (start.decided_at ?? 0) ? last.traffic : (JSON.parse(start.payload).baseline ?? null);
    const days = Math.round((now - (start.decided_at ?? start.created_at)) / DAY);
    const v = promotionReview(before, tonight, latest.rate ?? null, days);
    reviewed++;
    // Tonight's figures are the "before" of the next review, so an ad is always judged against its last two weeks.
    if (v.verdict !== "unknown" || !last) await env.store.kv.setJson(key, { at: now, traffic: tonight });
    if (v.verdict === "not_working") {
      await proposeAndNotify(
        env,
        { kind: "promote", itemId, payload: { itemTitle: l.title, action: "end", rate: null, currentRate: latest.rate ?? null, suggestedRate: null, ebayRecommends: null, campaign: "General (cost per sale)", payback: null, review: { before, after: tonight, days } }, reason: v.why },
        `End promotion: ${l.title}`,
        v.why,
      );
      ending++;
    } else notes.push(`${l.title.slice(0, 40)}: ${v.verdict === "working" ? "working" : "no figures yet"}`);
  }
  if (!reviewed) return "no ads due a review";
  return `${reviewed} reviewed, ${ending} to end${notes.length ? `; ${notes.join("; ").slice(0, 200)}` : ""}`;
}
