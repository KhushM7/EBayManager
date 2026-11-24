import type { Env } from "./env";
import { MIN_CHANGE, MIN_CONFIDENCE } from "./pricing/review";
import { PROMO } from "./promotion";
import { claudeAvailable, WATCHER_OFFER } from "./rules";

// The sales ladder (K, 2026-11-15). A listing that isn't selling gets one push at a time, the one its own
// figures call for, and at most one a week, so K isn't sent a price cut, an offer and an ad for the same item on
// the same night:
// - nobody sees it (hardly any views or search impressions, nobody watching): first a better title and item
//   specifics; if that was done in the last month and it's still unseen, promotion;
// - people watch it but don't buy: a small offer to the watchers; if one went out recently, the price;
// - people see it but nobody watches: the price.
// The nightly steps (listing review, price review, offers to watchers, promotion) each act only on listings whose
// rung is theirs. A rung that can't do anything for this listing tonight (nobody eBay lets K send an offer to, no
// market for an ad, no confident price, Claude off) is passed over, so a listing never sits on a dead one; when
// nothing is left to try, it says nothing. Nothing here writes to eBay: every step still ends in a label K approves.

const DAY = 86_400_000;

export type Rung = "listing" | "price" | "offer" | "promote";

/** One sales label per listing in this many days. */
export const LADDER_GAP_DAYS = 7;
/** A listing edit this recent has had its chance: if the listing is still unseen, the next rung is promotion. */
export const EDIT_SETTLE_DAYS = 30;

/** A rejected ad isn't suggested again for this long (src/promotion.ts). */
const PROMOTE_QUIET_DAYS = 14;

/**
 * What each rung could actually do for this listing tonight. null: couldn't be found out (eBay's answer failed),
 * so the listing waits rather than falling through to a price cut. Left out: possible.
 */
export interface Feasible {
  edit?: boolean;
  offer?: boolean | null;
  promote?: boolean | null;
  price?: boolean;
}

export interface LadderInput {
  listedDays: number;
  views7d: number | null;
  impressions7d: number | null;
  watchers: number;
  /** When the latest label of each kind was filed for this listing (waiting, approved, applied or rejected). */
  last: { revise?: number; price?: number; offer_to_watchers?: number; promote?: number };
  /** Promoted now (the latest applied promotion label wasn't an "end"). */
  promoted: boolean;
  now: number;
  can?: Feasible;
}

export interface LadderStep {
  rung: Rung | "wait" | "none";
  why: string;
}

export function ladderStep(i: LadderInput): LadderStep {
  if (i.listedDays < 7) return { rung: "none", why: "Listed under a week: too soon to tell." };
  const latest = Math.max(0, ...Object.values(i.last).filter((x): x is number => x != null));
  if (latest && i.now - latest < LADDER_GAP_DAYS * DAY) return { rung: "wait", why: `A change for it was suggested in the last ${LADDER_GAP_DAYS} days: one step at a time.` };
  const within = (at: number | undefined, days: number) => at != null && i.now - at < days * DAY;
  const lowImpressions = i.impressions7d != null && i.impressions7d < PROMO.lowImpressions;
  const fewViews = i.views7d != null && i.views7d < PROMO.lowViews;

  const { edit = true, offer = true, promote = true, price = true } = i.can ?? {};
  const orNothing = (why: string): LadderStep => (price ? { rung: "price", why } : { rung: "none", why: "Every step that could help has been tried or can't be taken now." });

  if (i.watchers > 0) {
    if (!within(i.last.offer_to_watchers, WATCHER_OFFER.cooldownDays)) {
      if (offer === null) return { rung: "wait", why: "eBay didn't say whether the watchers can be sent an offer: try again tomorrow." };
      if (offer) return { rung: "offer", why: `${i.watchers} watching but no sale after ${i.listedDays} days: remind the watchers with a small offer.` };
      return orNothing(`${i.watchers} watching after ${i.listedDays} days, and an offer to them isn't possible now: check the price.`);
    }
    return orNothing(`${i.watchers} watching, an offer already went out, and still no sale: check the price.`);
  }
  if ((fewViews && i.listedDays >= PROMO.unseenDays) || lowImpressions) {
    const seen = lowImpressions ? `only ${i.impressions7d} search impressions in 7 days` : `only ${i.views7d} view${i.views7d === 1 ? "" : "s"} in 7 days and nobody watching`;
    if (edit && !within(i.last.revise, EDIT_SETTLE_DAYS)) return { rung: "listing", why: `Not being seen (${seen}): the title and item specifics come first.` };
    if (!i.promoted && !within(i.last.promote, PROMOTE_QUIET_DAYS)) {
      if (promote === null) return { rung: "wait", why: "Promotion couldn't be checked tonight: try again tomorrow." };
      if (promote) return { rung: "promote", why: `Not being seen (${seen}) and no listing edit to make: promotion is next.` };
    }
    return orNothing(`Not being seen (${seen}), with a listing edit and an ad already considered: check the price.`);
  }
  if (i.views7d != null && i.listedDays >= 14) return orNothing(`Seen (${i.views7d} view${i.views7d === 1 ? "" : "s"} in 7 days) but nobody is watching after ${i.listedDays} days: check the price.`);
  return { rung: "none", why: "Nothing says it needs a push yet." };
}

/** What tonight's checks found, shared with the steps that act on it. null: that check failed. */
export interface LadderChecks {
  /** Listings eBay lets K send an offer for. */
  eligible: Set<string> | null;
  /** Listings whose promotion advice tonight is "promote". */
  promotable: Set<string> | null;
}

/** Triage's memory of a listing (src/nightly.ts): `edit` when a listing edit was open to it that night. */
export interface TriageMemory {
  at: number;
  fingerprint: string;
  note: string;
  edit?: boolean;
}

function decisionOf(result: string): { strategy?: string; price?: number | null; confidence?: number } | null {
  try {
    return JSON.parse(result)?.decision ?? null;
  } catch {
    return null;
  }
}

/** What could be done for each live listing tonight. */
async function feasibility(env: Env, now: number, checks: LadderChecks): Promise<Map<string, Feasible>> {
  const decisions = new Map((await env.store.pricing.latestDecisions()).map((d) => [d.item_id, d]));
  const out = new Map<string, Feasible>();
  const claude = claudeAvailable(env);
  for (const l of await env.store.listings.latestSet()) {
    const s = await env.store.listings.getSettings(l.item_id);
    const triaged = await env.store.kv.getJson<TriageMemory>(`triage:${l.item_id}`).catch(() => null);
    const d = decisions.get(l.item_id);
    // A check in the last 6 days says whether the price can move; an older one is repeated tonight.
    let price = s?.own_price == null;
    const x = price && d && now - d.at <= 6 * DAY ? decisionOf(d.result) : null;
    if (x) price = x.strategy !== "ask" && x.strategy !== "own" && x.price != null && (x.confidence ?? 0) >= MIN_CONFIDENCE && Math.abs(x.price - l.price) / l.price >= MIN_CHANGE;
    const lowest = Math.round(l.price * (100 - WATCHER_OFFER.minPercent)) / 100;
    out.set(l.item_id, {
      // Claude looked at the listing lately with nothing to change: an edit has had its turn.
      edit: claude && !(triaged?.edit && now - triaged.at > 12 * 3_600_000 && now - triaged.at < EDIT_SETTLE_DAYS * DAY),
      offer: checks.eligible === null ? null : checks.eligible.has(l.item_id) && !(s?.floor_price != null && lowest < s.floor_price),
      promote: checks.promotable === null ? null : checks.promotable.has(l.item_id),
      price,
    });
  }
  return out;
}

/** Each live listing's rung tonight, from the latest snapshot, traffic and the labels already filed. */
export async function ladderFor(env: Env, now = Date.now(), checks?: LadderChecks): Promise<Map<string, LadderStep>> {
  const can = checks ? await feasibility(env, now, checks) : null;
  const kinds = ["revise", "price", "offer_to_watchers", "promote"] as const;
  const labels = (await Promise.all(kinds.map((k) => env.store.proposals.listWhere([{ f: "kind", op: "=", v: k }])))).flat();
  const out = new Map<string, LadderStep>();
  for (const l of await env.store.listings.latestSet()) {
    // Dry runs from the read-only days and labels that expired unanswered aren't steps taken.
    const mine = labels.filter((p) => p.item_id === l.item_id && p.status !== "expired" && !(env.WRITE_MODE === "approval" && p.dry_run));
    const last: LadderInput["last"] = {};
    for (const k of kinds) {
      const at = Math.max(0, ...mine.filter((p) => p.kind === k).map((p) => p.decided_at ?? p.created_at));
      if (at) last[k] = at;
    }
    const ads = mine.filter((p) => p.kind === "promote" && p.status === "applied").sort((a, b) => (b.decided_at ?? 0) - (a.decided_at ?? 0));
    const promoted = ads.length > 0 && JSON.parse(ads[0].payload).action !== "end";
    out.set(
      l.item_id,
      ladderStep({ listedDays: Math.floor((now - Date.parse(l.first_start_time ?? l.start_time)) / DAY), views7d: l.views_7d, impressions7d: l.impressions_7d, watchers: l.watch_count ?? 0, last, promoted, now, can: can?.get(l.item_id) }),
    );
  }
  return out;
}

/** A line for the nightly's record: how many listings sit on each rung. */
export function ladderSummary(steps: Map<string, LadderStep>): string {
  const n = (r: LadderStep["rung"]) => [...steps.values()].filter((s) => s.rung === r).length;
  return `${n("listing")} listing, ${n("price")} price, ${n("offer")} offer, ${n("promote")} promote, ${n("wait")} waiting, ${n("none")} fine`;
}
