import type { Env } from "./env";
import { categoryAspects } from "./ebay/browse";
import {
  getAnsweredQuestions,
  getSeller,
  getSentMessages,
  getSoldAndUnsold,
  type EndedListing,
  type PastReply,
  type RecentSale,
  type SellerRecord,
} from "./ebay/history";
import { getBusinessPolicies, type BusinessPolicies } from "./ebay/sell";
import { getActiveListings, getItem } from "./ebay/trading";
import { push } from "./notify";
import { inputFromItem, type PriceResult } from "./pricing/engine";
import { reviewPrices } from "./pricing/review";
import { proposePromotions, researchPromotion, type ListingPromotion } from "./promotion";
import { proposeAndNotify } from "./proposals";
import { RETURNS } from "./rules";
import { snapshotListings } from "./snapshot";
import { providerEnabled } from "./solddata";
import { getStyle, learnStyle, saveStyle, type StyleGuide } from "./style";

// The first-day audit (docs/listing-assistant.md): a read-only review of the whole account once it's
// connected. It reads every active listing in full, the sold history (K's imported Seller Hub sales and eBay's
// last 90 days), ended-unsold listings, K's past replies and the account settings, and writes a report for
// the app. It changes nothing on eBay. Its fixes are normal proposals: price and promotion from the engine,
// return-policy fixes as `policy` proposals, and title, specifics and description from the Claude listing
// review, which K starts from the report (one Sonnet run per listing).

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const list = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const num = (v: any): number | null => {
  const n = Number(typeof v === "object" && v != null ? v["#text"] : v);
  return v == null || !Number.isFinite(n) ? null : n;
};

export type Severity = "high" | "medium" | "low";
export type FixBy = "proposal" | "claude" | "you" | "none";

export interface Finding {
  area: "listing" | "sold" | "unsold" | "messages" | "settings" | "promotion";
  severity: Severity;
  itemId?: string | null;
  itemTitle?: string | null;
  title: string;
  detail: string;
  /** How it gets fixed: a proposal already filed, the Claude listing review, K, or nothing to do. */
  fix: FixBy;
}

export interface ListingAudit {
  itemId: string;
  title: string;
  url: string | null;
  price: number | null;
  postage: number | null;
  collectionOnly: boolean;
  listedDays: number | null;
  watchers: number;
  views7d: number | null;
  impressions7d: number | null;
  photos: number;
  specifics: number;
  missingRequired: string[];
  missingRecommended: string[];
  descriptionChars: number;
  bestOffer: boolean;
  returns: { accepted: boolean; days: number | null; buyerPays: boolean | null; businessPolicy: boolean };
  handlingDays: number | null;
  pricing: { strategy: string; price: number | null; why: string; confidence: number; question?: string; at: number } | null;
  promotion: { action: string; rate: number | null; why: string; suggestedRate: number | null } | null;
  findings: Finding[];
}

export interface SoldSummary {
  count: number;
  revenue: number;
  median: number | null;
  first: string | null;
  last: string | null;
  byMonth: { month: string; sales: number; revenue: number }[];
  top: { title: string; price: number; date: string }[];
  /** Average days from listing to sale, where the start date is known. */
  avgDaysToSell: number | null;
  timedSales: number;
  /** Fees as a share of revenue, where eBay reported them. */
  feeShare: number | null;
  /** Asking price against what it sold for, where both are known. */
  askingVsSold: { title: string; asked: number; sold: number }[];
}

export interface UnsoldAudit {
  itemId: string;
  title: string;
  price: number | null;
  days: number | null;
  watchers: number;
  views: number | null;
  likely: string;
}

export interface AuditReport {
  at: number;
  env: string;
  seller: SellerRecord | null;
  listings: ListingAudit[];
  sold: SoldSummary;
  unsold: UnsoldAudit[];
  messages: { replies: number; questionsAnswered: number; style: StyleGuide | null; note: string };
  settings: { policies: BusinessPolicies | null; note: string };
  /** Every finding, most important first. */
  findings: Finding[];
  /** Proposals the audit filed. */
  proposals: { id: string; kind: string; itemId: string | null }[];
  /** Listings whose title, specifics or description need the Claude listing review. */
  forClaude: string[];
  steps: Record<string, string>;
}

// --- Pure checks (tested in test/firstday.test.ts) ---

export const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function rankFindings(fs: Finding[]): Finding[] {
  return [...fs].sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.fix === "you" ? 0 : 1) - (b.fix === "you" ? 0 : 1));
}

/** Everything the audit checks on one live listing, from GetItem plus what the app already knows. */
export function auditListing(
  item: any,
  ctx: {
    aspects?: { name: string; required: boolean }[] | null;
    views7d?: number | null;
    impressions7d?: number | null;
    pricing?: PriceResult | null;
    pricedAt?: number | null;
    promotion?: ListingPromotion | null;
    now?: number;
  } = {},
): ListingAudit {
  const now = ctx.now ?? Date.now();
  const itemId = String(item?.ItemID ?? "");
  const title = String(item?.Title ?? "");
  const input = inputFromItem(item);
  const specificNames = list<any>(item?.ItemSpecifics?.NameValueList).map((nv) => String(nv.Name).toLowerCase());
  const missing = (ctx.aspects ?? []).filter((a) => !specificNames.includes(a.name.toLowerCase()));
  const description = stripHtml(String(item?.Description ?? ""));
  const photos = list<any>(item?.PictureDetails?.PictureURL).length;
  const rp = item?.ReturnPolicy ?? {};
  const returns = {
    accepted: rp.ReturnsAcceptedOption ? rp.ReturnsAcceptedOption === "ReturnsAccepted" : true,
    days: rp.ReturnsWithinOption ? Number(String(rp.ReturnsWithinOption).replace(/\D/g, "")) || null : null,
    buyerPays: rp.ShippingCostPaidByOption ? rp.ShippingCostPaidByOption === "Buyer" : null,
    businessPolicy: Boolean(item?.SellerProfiles?.SellerReturnProfile),
  };
  const collectionOnly = item?.ShipToLocations === "None";
  const handlingDays = num(item?.DispatchTimeMax);
  const bestOffer = String(item?.BestOfferDetails?.BestOfferEnabled) === "true";
  const conditionId = num(item?.ConditionID);
  const f: Finding[] = [];
  const add = (severity: Severity, t: string, detail: string, fix: FixBy, area: Finding["area"] = "listing") =>
    f.push({ area, severity, itemId, itemTitle: title, title: t, detail, fix });

  // Rules K set: returns accepted, buyer pays return postage. A listing on a business policy is covered by
  // that policy's own finding and proposal.
  if (!returns.businessPolicy && !returns.accepted)
    add("high", "Returns not accepted", "Your rule is returns always accepted, buyer pays return postage. A policy proposal has been filed.", "proposal", "settings");
  else if (!returns.businessPolicy && returns.buyerPays === false)
    add("high", "You pay return postage", "Your rule is that the buyer pays return postage. A policy proposal has been filed.", "proposal", "settings");

  // Title.
  if (title.length < 45)
    add("medium", "Short title", `Uses ${title.length} of 80 characters. Brand, model and key details buyers search for are probably missing.`, "claude");
  const caps = title.split(/\s+/).filter((w) => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
  if (caps >= 4) add("low", "Title in capitals", `${caps} words in capitals read as shouting in search results.`, "claude");

  // Item specifics.
  const req = missing.filter((a) => a.required).map((a) => a.name);
  const rec = missing.filter((a) => !a.required).map((a) => a.name);
  if (req.length) add("high", "Required item specifics missing", req.join(", "), "claude");
  if (rec.length >= 3) add("medium", `${rec.length} recommended item specifics missing`, rec.slice(0, 8).join(", "), "claude");
  else if (!ctx.aspects && specificNames.length < 4)
    add("medium", "Few item specifics", `Only ${specificNames.length}. Buyers filter search by them (brand, model, colour, size).`, "claude");

  // Description and condition.
  if (!description) add("high", "No description", "Say what it is, its condition in plain words, and what's included.", "claude");
  else if (description.length < 200) add("medium", "Thin description", `${description.length} characters. Add condition, what's included and measurements if known.`, "claude");
  if (conditionId != null && conditionId >= 2000 && !String(item?.ConditionDescription ?? "").trim())
    add("low", "No condition note", "A used item without a condition note invites questions and returns. Describe any marks or wear.", "you");

  // Photos.
  if (photos < 3) add("high", `${photos} photo${photos === 1 ? "" : "s"}`, "Buyers want every side, labels and any flaws. eBay allows 24.", "you");
  else if (photos < 6) add("medium", `${photos} photos`, "More angles, the label or model number, and close-ups of any wear help it sell.", "you");

  // Postage, handling, offers.
  if (!collectionOnly && input.postage == null) add("medium", "No postage price found", "Check the postage on this listing.", "you");
  if (handlingDays != null && handlingDays > 3) add("low", `${handlingDays}-day handling time`, "Buyers rank faster dispatch higher; 1 to 2 days is typical.", "you");
  if (!bestOffer) add("low", "Best Offer off", "Offers let interested buyers make a move; you approve every answer.", "you");

  // Price against the market (the engine's latest check).
  const d = ctx.pricing?.decision ?? null;
  if (d && d.strategy === "ask") add("medium", "Engine needs your answer", d.question ?? "The engine couldn't identify this item exactly.", "you");
  else if (d && d.price != null && input.current) {
    const gap = (input.current - d.price) / d.price;
    if (Math.abs(gap) >= 0.05)
      add(
        Math.abs(gap) >= 0.15 ? "high" : "medium",
        `${gap > 0 ? "Above" : "Below"} the market by ${Math.round(Math.abs(gap) * 100)}%`,
        `${d.strategy[0].toUpperCase()}${d.strategy.slice(1)} at £${d.price.toFixed(2)}: ${d.why} Confidence ${Math.round(d.confidence * 100)}%.`,
        d.confidence >= 0.3 ? "proposal" : "you",
      );
  }

  // Promotion.
  const p = ctx.promotion;
  if (p && p.advice.action !== "none")
    add("medium", p.advice.action === "promote" ? `Promote at ${p.advice.rate}%` : p.advice.action === "lower" ? `Lower the ad rate to ${p.advice.rate}%` : "End the promotion", p.advice.why, "proposal", "promotion");

  return {
    itemId,
    title,
    url: item?.ListingDetails?.ViewItemURL ?? null,
    price: input.current ?? null,
    postage: input.postage ?? null,
    collectionOnly,
    listedDays: input.listedDays ?? (item?.ListingDetails?.StartTime ? Math.round((now - Date.parse(item.ListingDetails.StartTime)) / DAY) : null),
    watchers: Number(item?.WatchCount ?? 0),
    views7d: ctx.views7d ?? null,
    impressions7d: ctx.impressions7d ?? null,
    photos,
    specifics: specificNames.length,
    missingRequired: req,
    missingRecommended: rec,
    descriptionChars: description.length,
    bestOffer,
    returns,
    handlingDays,
    pricing: d ? { strategy: d.strategy, price: d.price, why: d.why, confidence: d.confidence, question: d.question, at: ctx.pricedAt ?? now } : null,
    promotion: p ? { action: p.advice.action, rate: p.advice.rate, why: p.advice.why, suggestedRate: p.suggestedRate } : null,
    findings: f,
  };
}

export interface SaleRow {
  title: string;
  price: number;
  at: number;
  fees: number | null;
  /** Listing start, ms, where known. */
  startedAt: number | null;
  /** The asking price when last seen, where known. */
  asked: number | null;
}

const medianOf = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? r2((s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2) : null;
};

export function soldSummary(rows: SaleRow[]): SoldSummary {
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const months = new Map<string, { sales: number; revenue: number }>();
  for (const r of sorted) {
    const m = new Date(r.at).toISOString().slice(0, 7);
    const cur = months.get(m) ?? { sales: 0, revenue: 0 };
    months.set(m, { sales: cur.sales + 1, revenue: r2(cur.revenue + r.price) });
  }
  const timed = sorted.filter((r) => r.startedAt != null && r.at >= r.startedAt!);
  const withFees = sorted.filter((r) => r.fees != null);
  const feeRevenue = withFees.reduce((s, r) => s + r.price, 0);
  return {
    count: sorted.length,
    revenue: r2(sorted.reduce((s, r) => s + r.price, 0)),
    median: medianOf(sorted.map((r) => r.price)),
    first: sorted[0] ? new Date(sorted[0].at).toISOString().slice(0, 10) : null,
    last: sorted.at(-1) ? new Date(sorted.at(-1)!.at).toISOString().slice(0, 10) : null,
    byMonth: [...months.entries()].map(([month, v]) => ({ month, ...v })),
    top: [...sorted]
      .sort((a, b) => b.price - a.price)
      .slice(0, 5)
      .map((r) => ({ title: r.title, price: r.price, date: new Date(r.at).toISOString().slice(0, 10) })),
    avgDaysToSell: timed.length ? Math.round((timed.reduce((s, r) => s + (r.at - r.startedAt!) / DAY, 0) / timed.length) * 10) / 10 : null,
    timedSales: timed.length,
    feeShare: withFees.length && feeRevenue > 0 ? Math.round((withFees.reduce((s, r) => s + r.fees!, 0) / feeRevenue) * 1000) / 1000 : null,
    askingVsSold: sorted.filter((r) => r.asked != null).map((r) => ({ title: r.title, asked: r.asked!, sold: r.price })),
  };
}

export function soldFindings(s: SoldSummary): Finding[] {
  const f: Finding[] = [];
  const add = (severity: Severity, title: string, detail: string) => f.push({ area: "sold", severity, title, detail, fix: "none" });
  if (!s.count) {
    add("low", "No sold history", "Import the Seller Hub orders report in Settings so prices learn from your sales.");
    return f;
  }
  add("low", `${s.count} sales, £${s.revenue.toFixed(2)}`, `${s.first} to ${s.last}; median sale £${s.median?.toFixed(2)}.`);
  if (s.avgDaysToSell != null) add("low", `About ${Math.round(s.avgDaysToSell)} days to sell`, `Average over the ${s.timedSales} sales whose listing date is known.`);
  const below = s.askingVsSold.filter((x) => x.sold < x.asked * 0.9);
  if (below.length)
    add("medium", `${below.length} sold 10%+ under the asking price`, below.slice(0, 3).map((x) => `${x.title}: asked £${x.asked.toFixed(2)}, sold £${x.sold.toFixed(2)}`).join("; "));
  if (s.feeShare != null && s.feeShare > 0.05)
    add("medium", `Fees took ${Math.round(s.feeShare * 100)}% of revenue`, "The pricing engine assumes 0% final value fees (a UK private seller). Tell Claude if you sell as a business.");
  return f;
}

/** Why an ended listing likely didn't sell, from what eBay recorded about it. */
export function unsoldReason(e: EndedListing, now = Date.now()): UnsoldAudit {
  const days = e.startTime ? Math.round(((e.endTime ? Date.parse(e.endTime) : now) - Date.parse(e.startTime)) / DAY) : null;
  let likely: string;
  if (e.watchers >= 2) likely = `${e.watchers} people watched it but nobody bought: the price was probably a little high.`;
  else if (e.views != null && e.views < 20) likely = `Only ${e.views} views: buyers weren't finding it. The title and item specifics probably missed the words they search for, or the market was crowded.`;
  else if (e.views != null && e.watchers === 0) likely = `Seen ${e.views} times but nobody watched: the price or the photos didn't persuade.`;
  else likely = "Not enough data to tell; the pricing engine can check it if you relist.";
  return { itemId: e.itemId, title: e.title, price: e.price, days, watchers: e.watchers, views: e.views, likely };
}

export function settingsFindings(policies: BusinessPolicies | null, seller: SellerRecord | null): Finding[] {
  const f: Finding[] = [];
  const add = (severity: Severity, title: string, detail: string, fix: FixBy) => f.push({ area: "settings", severity, title, detail, fix });
  for (const r of policies?.returns ?? []) {
    if (!r.accepted) add("high", `Return policy "${r.name}" doesn't accept returns`, "Your rule: returns always accepted, buyer pays return postage. A policy proposal has been filed.", "proposal");
    else if (r.buyerPaysReturnPostage === false) add("high", `Return policy "${r.name}": you pay return postage`, "Your rule: the buyer pays. A policy proposal has been filed.", "proposal");
    else if (r.periodDays != null && r.periodDays < RETURNS.periodDays)
      add("low", `Return policy "${r.name}": ${r.periodDays}-day returns`, `${RETURNS.periodDays} days is your setting; eBay ranks 30-day returns higher.`, "you");
  }
  for (const p of policies?.postage ?? []) {
    if (p.handlingDays != null && p.handlingDays > 3) add("low", `Postage policy "${p.name}": ${p.handlingDays}-day handling`, "1 to 2 days ranks better.", "you");
    if (!p.services.length && !p.collection) add("medium", `Postage policy "${p.name}" has no UK service`, "Check it in Seller Hub.", "you");
  }
  if (seller?.businessType === "Commercial")
    add("high", "Registered as a business seller", "The pricing engine assumes 0% final value fees (private seller). Business sellers pay fees, so prices need a fee setting before going live.", "you");
  return f;
}

/** A `policy` proposal: the return policy that meets K's rule. Applying it is built with Phase 8. */
async function proposeReturnFix(env: Env, target: { policyId?: string; name: string; itemId?: string }, current: object) {
  const pending = await env.DB.prepare("SELECT payload FROM proposals WHERE kind = 'policy' AND status IN ('pending', 'approved')").all<{ payload: string }>();
  const key = target.policyId ?? target.itemId;
  if (pending.results.some((p) => [JSON.parse(p.payload).policyId, JSON.parse(p.payload).itemId].includes(key))) return null;
  const out = await proposeAndNotify(
    env,
    {
      kind: "policy",
      itemId: target.itemId,
      payload: {
        area: "returns",
        policyId: target.policyId ?? null,
        itemId: target.itemId ?? null,
        name: target.name,
        current,
        proposed: { returnsAccepted: true, periodDays: RETURNS.periodDays, buyerPaysReturnPostage: true },
      },
      reason: "Your rule: returns always accepted, and the buyer pays return postage.",
    },
    `Return policy: ${target.name}`,
    "Accept returns within 30 days, buyer pays return postage.",
  );
  return out.proposalId;
}

// --- The run ---

async function stepRun(steps: Record<string, string>, name: string, fn: () => Promise<string>) {
  try {
    steps[name] = await fn();
  } catch (e) {
    steps[name] = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }
}

/**
 * Runs the audit and stores the report. Read-only on eBay. Spends: a few sold-data searches through the
 * nightly price review (capped), one Sonnet call for the style guide, and nothing else from Claude.
 */
export async function runFirstDayAudit(env: Env, opts: { relearnStyle?: boolean } = {}): Promise<AuditReport> {
  const at = Date.now();
  const steps: Record<string, string> = {};
  const startProposals = at;

  // 1. Every active listing in full.
  await stepRun(steps, "snapshot", async () => `${(await snapshotListings(env)).count} listings`);
  const items: any[] = [];
  await stepRun(steps, "listings", async () => {
    const active = await getActiveListings(env);
    for (const l of active.slice(0, 60)) items.push(await getItem(env, l.itemId));
    return `${items.length} read in full${active.length > 60 ? ` (first 60 of ${active.length})` : ""}`;
  });

  // 2. Prices: the engine's nightly review (capped searches; it proposes changes the market supports).
  await stepRun(steps, "prices", async () =>
    providerEnabled(env, "trawl") || providerEnabled(env, "compsapi") ? reviewPrices(env, at) : "skipped: no sold-data provider keys",
  );

  // 3. Promotion research, from each listing's market picture.
  let promos: ListingPromotion[] = [];
  await stepRun(steps, "promotion", async () => {
    const errors: string[] = [];
    promos = await researchPromotion(env, items.map((i) => ({ itemId: String(i.ItemID), title: String(i.Title ?? ""), item: i })), errors);
    const n = await proposePromotions(env, promos);
    return `${promos.length} checked, ${n} proposed${errors.length ? `; ${errors.join("; ").slice(0, 200)}` : ""}`;
  });

  // 4. Per-listing checks, with the category's item specifics from eBay.
  const listings: ListingAudit[] = [];
  const aspectsByCategory = new Map<string, { name: string; required: boolean }[] | null>();
  await stepRun(steps, "checks", async () => {
    for (const item of items) {
      const cat = String(item?.PrimaryCategory?.CategoryID ?? "");
      if (cat && !aspectsByCategory.has(cat)) aspectsByCategory.set(cat, await categoryAspects(env, cat).catch(() => null));
      const id = String(item.ItemID);
      const traffic = await env.DB.prepare("SELECT views_7d, impressions_7d FROM listing_traffic WHERE item_id = ? ORDER BY taken_at DESC LIMIT 1")
        .bind(id)
        .first<{ views_7d: number | null; impressions_7d: number | null }>();
      const priced = await env.DB.prepare("SELECT at, result FROM price_decisions WHERE item_id = ? ORDER BY at DESC LIMIT 1").bind(id).first<{ at: number; result: string }>();
      listings.push(
        auditListing(item, {
          aspects: aspectsByCategory.get(cat) ?? null,
          views7d: traffic?.views_7d ?? null,
          impressions7d: traffic?.impressions_7d ?? null,
          pricing: priced ? JSON.parse(priced.result) : null,
          pricedAt: priced?.at ?? null,
          promotion: promos.find((p) => p.itemId === id) ?? null,
          now: at,
        }),
      );
    }
    return `${listings.length} checked`;
  });

  // 5. Sold history: K's imported sales and eBay's orders (D1), with listing dates where known.
  let sold = soldSummary([]);
  let unsold: UnsoldAudit[] = [];
  let recent: RecentSale[] = [];
  await stepRun(steps, "ended", async () => {
    const r = await getSoldAndUnsold(env);
    recent = r.sold;
    unsold = r.unsold.map((e) => unsoldReason(e, at));
    return `${r.sold.length} sold and ${r.unsold.length} unsold in the last 60 days`;
  });
  await stepRun(steps, "sold", async () => {
    const { results } = await env.DB.prepare(
      `SELECT i.item_id, i.title, i.price, o.created_at, o.fees,
              (SELECT MIN(start_time) FROM listing_snapshots s WHERE s.item_id = i.item_id) AS start_time,
              (SELECT price FROM listing_snapshots s WHERE s.item_id = i.item_id ORDER BY taken_at DESC LIMIT 1) AS asked
       FROM order_items i JOIN orders o ON o.order_id = i.order_id`,
    ).all<{ item_id: string; title: string; price: number | null; created_at: number; fees: number | null; start_time: string | null; asked: number | null }>();
    const rows: SaleRow[] = results
      .filter((r) => r.price != null)
      .map((r) => {
        const fromEbay = recent.find((s) => s.itemId === r.item_id);
        const start = r.start_time ?? fromEbay?.startTime ?? null;
        return { title: r.title, price: r.price!, at: r.created_at, fees: r.fees, startedAt: start ? Date.parse(start) || null : null, asked: r.asked };
      });
    sold = soldSummary(rows);
    return `${sold.count} sales`;
  });

  // 6. Messages: K's past replies, and the style guide learned from them (K's own edits are kept).
  let replies: PastReply[] = [];
  let answered = 0;
  let style: StyleGuide | null = await getStyle(env).catch(() => null);
  await stepRun(steps, "messages", async () => {
    const q = await getAnsweredQuestions(env).catch((e) => (steps.questions = `failed: ${e instanceof Error ? e.message : e}`.slice(0, 200), []));
    answered = q.length;
    const sent = await getSentMessages(env).catch((e) => (steps.sent = `failed: ${e instanceof Error ? e.message : e}`.slice(0, 200), []));
    replies = [...q, ...sent];
    return `${q.length} answered questions, ${sent.length} sent messages`;
  });
  await stepRun(steps, "style", async () => {
    if (style?.editedBy && !opts.relearnStyle) return `kept: edited by ${style.editedBy}`;
    if (style?.source.learned && !opts.relearnStyle) return "kept: already learned";
    style = await learnStyle(env, replies);
    await saveStyle(env, style);
    return style.source.learned ? `learned from ${style.source.replies} replies` : "default guide (no replies to learn from, or no Claude key)";
  });

  // 7. Settings: business policies and the seller record.
  let policies: BusinessPolicies | null = null;
  let policiesNote = "";
  let seller: SellerRecord | null = null;
  await stepRun(steps, "policies", async () => {
    try {
      policies = await getBusinessPolicies(env);
      policiesNote = `${policies.returns.length} return, ${policies.postage.length} postage and ${policies.payment.length} payment policies.`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 20403: the account doesn't use business policies, which is normal; each listing then carries its own.
      if (!/20403|not eligible for Business Policy/i.test(msg)) throw e;
      policiesNote = "This account doesn't use business policies, so each listing's own return and postage settings were checked instead.";
    }
    return policiesNote;
  });
  await stepRun(steps, "seller", async () => {
    seller = await getSeller(env);
    return `${seller.businessType ?? "unknown"} seller`;
  });

  // 8. Return-policy fixes as proposals.
  await stepRun(steps, "policy_fixes", async () => {
    let n = 0;
    for (const r of (policies as BusinessPolicies | null)?.returns ?? [])
      if (!r.accepted || r.buyerPaysReturnPostage === false)
        n += (await proposeReturnFix(env, { policyId: r.id, name: r.name }, { returnsAccepted: r.accepted, periodDays: r.periodDays, buyerPaysReturnPostage: r.buyerPaysReturnPostage })) ? 1 : 0;
    for (const l of listings)
      if (!l.returns.businessPolicy && (!l.returns.accepted || l.returns.buyerPays === false))
        n += (await proposeReturnFix(env, { itemId: l.itemId, name: l.title }, l.returns)) ? 1 : 0;
    return `${n} proposed`;
  });

  const findings = rankFindings([
    ...listings.flatMap((l) => l.findings),
    ...soldFindings(sold),
    ...unsold.filter((u) => u.watchers >= 2 || (u.views ?? 99) < 20).map<Finding>((u) => ({
      area: "unsold",
      severity: "medium",
      itemId: u.itemId,
      itemTitle: u.title,
      title: `Ended unsold: ${u.title}`,
      detail: u.likely,
      fix: "you",
    })),
    ...settingsFindings(policies, seller),
    ...(replies.length
      ? []
      : [{ area: "messages", severity: "low", title: "No past replies found", detail: "The style guide starts from a plain default. Edit it to sound like you.", fix: "you" } as Finding]),
  ]);

  const { results: made } = await env.DB.prepare("SELECT id, kind, item_id FROM proposals WHERE created_at >= ? ORDER BY created_at")
    .bind(startProposals)
    .all<{ id: string; kind: string; item_id: string | null }>();

  const report: AuditReport = {
    at,
    env: env.EBAY_ENV,
    seller,
    listings,
    sold,
    unsold,
    messages: {
      replies: replies.length,
      questionsAnswered: answered,
      style,
      note: replies.length ? `Learned from ${replies.length} of your past messages.` : "No past replies were found on eBay (it keeps about a year).",
    },
    settings: { policies, note: policiesNote },
    findings,
    proposals: made.map((p) => ({ id: p.id, kind: p.kind, itemId: p.item_id })),
    forClaude: listings.filter((l) => l.findings.some((f) => f.fix === "claude")).map((l) => l.itemId),
    steps,
  };
  await env.DB.prepare("INSERT INTO audit_reports (at, env, report) VALUES (?, ?, ?)").bind(at, env.EBAY_ENV, JSON.stringify(report)).run();

  const high = findings.filter((f) => f.severity === "high").length;
  await push(
    env,
    "First-day audit ready",
    `${listings.length} listings, ${sold.count} past sales, ${unsold.length} ended unsold. ${high} important findings, ${made.length} proposals to review.`,
    undefined,
    "audit",
  );
  return report;
}

export async function latestReport(env: Env): Promise<AuditReport | null> {
  const row = await env.DB.prepare("SELECT report FROM audit_reports ORDER BY at DESC LIMIT 1").first<{ report: string }>();
  return row ? JSON.parse(row.report) : null;
}

/** For the nightly run: the audit runs once, the first night after the account connects. */
export async function auditDone(env: Env): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT 1 FROM audit_reports LIMIT 1").first());
}

