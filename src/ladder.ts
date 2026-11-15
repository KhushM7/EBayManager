import type { Env } from "./env";
import { PROMO } from "./promotion";
import { WATCHER_OFFER } from "./rules";

// The sales ladder (K, 2026-11-15). A listing that isn't selling gets one push at a time, the one its own
// figures call for, and at most one a week, so K isn't sent a price cut, an offer and an ad for the same item on
// the same night:
// - nobody sees it (hardly any views or search impressions, nobody watching): first a better title and item
//   specifics; if that was done in the last month and it's still unseen, promotion;
// - people watch it but don't buy: a small offer to the watchers; if one went out recently, the price;
// - people see it but nobody watches: the price.
// The nightly steps (listing review, price review, offers to watchers, promotion) each act only on listings whose
// rung is theirs. Nothing here writes to eBay: every step still ends in a label K approves.

const DAY = 86_400_000;

export type Rung = "listing" | "price" | "offer" | "promote";

/** One sales label per listing in this many days. */
export const LADDER_GAP_DAYS = 7;
/** A listing edit this recent has had its chance: if the listing is still unseen, the next rung is promotion. */
export const EDIT_SETTLE_DAYS = 30;

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

  if (i.watchers > 0) {
    if (!within(i.last.offer_to_watchers, WATCHER_OFFER.cooldownDays))
      return { rung: "offer", why: `${i.watchers} watching but no sale after ${i.listedDays} days: remind the watchers with a small offer.` };
    return { rung: "price", why: `${i.watchers} watching, an offer already went out, and still no sale: check the price.` };
  }
  if ((fewViews && i.listedDays >= PROMO.unseenDays) || lowImpressions) {
    const seen = lowImpressions ? `only ${i.impressions7d} search impressions in 7 days` : `only ${i.views7d} view${i.views7d === 1 ? "" : "s"} in 7 days and nobody watching`;
    if (!within(i.last.revise, EDIT_SETTLE_DAYS)) return { rung: "listing", why: `Not being seen (${seen}): the title and item specifics come first.` };
    if (!i.promoted) return { rung: "promote", why: `Still not being seen (${seen}) after its listing was improved: promotion is next.` };
    return { rung: "price", why: `Still not being seen (${seen}) with a better listing and an ad: check the price.` };
  }
  if (i.views7d != null && i.listedDays >= 14) return { rung: "price", why: `Seen (${i.views7d} views in 7 days) but nobody is watching after ${i.listedDays} days: check the price.` };
  return { rung: "none", why: "Nothing says it needs a push yet." };
}

/** Each live listing's rung tonight, from the latest snapshot, traffic and the labels already filed. */
export async function ladderFor(env: Env, now = Date.now()): Promise<Map<string, LadderStep>> {
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
      ladderStep({ listedDays: Math.floor((now - Date.parse(l.first_start_time ?? l.start_time)) / DAY), views7d: l.views_7d, impressions7d: l.impressions_7d, watchers: l.watch_count ?? 0, last, promoted, now }),
    );
  }
  return out;
}

/** A line for the nightly's record: how many listings sit on each rung. */
export function ladderSummary(steps: Map<string, LadderStep>): string {
  const n = (r: LadderStep["rung"]) => [...steps.values()].filter((s) => s.rung === r).length;
  return `${n("listing")} listing, ${n("price")} price, ${n("offer")} offer, ${n("promote")} promote, ${n("wait")} waiting, ${n("none")} fine`;
}
