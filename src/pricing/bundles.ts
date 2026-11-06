import type { Env } from "../env";
import { completeOnce, MODELS, type MessagesApi } from "../claude";

// Bundle advice across K's listings (docs/pricing-engine.md, "Bundles"). Claude Haiku suggests which listings
// suit the same buyer; the numbers that decide whether a suggestion is worth showing are worked out here, from
// the engine's latest decision for each listing. Advice only: K decides, and any listing change it leads to
// is a normal proposal.

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface ListingForAdvice {
  itemId: string;
  title: string;
  price: number;
  /** Days since listed. */
  listedDays: number;
  watchers: number;
  /** From the latest price decision, when there is one. */
  daysToSell?: number | null;
  /** Bundle parts' prices on their own, when the listing is a bundle. */
  parts?: { name: string; price: number }[];
}

export interface Advice {
  kind: "combine" | "split";
  itemIds: string[];
  title: string;
  reason: string;
  /** Expected present value to K, each way, GBP. */
  separately: number;
  together: number;
  daysSeparately: number;
  daysTogether: number;
}

export interface AdviceCosts {
  /** K's cost of posting one parcel, GBP. */
  parcel: number;
  holdPerDay: number;
  discountPerDay: number;
  /** Price of a bundle relative to the sum of its parts: buyers expect a little off. */
  bundleFactor: number;
  /** Effort of one more listing, GBP. */
  perListing: number;
}

export const ADVICE_COSTS: AdviceCosts = { parcel: 3.5, holdPerDay: 0.02, discountPerDay: 0.001, bundleFactor: 0.92, perListing: 1 };

const pv = (amount: number, days: number, c: AdviceCosts) => amount * Math.exp(-c.discountPerDay * days) - c.holdPerDay * days;
/** When nothing better is known: a listing with no watchers after a month is taken to need about as long again. */
const guessDays = (l: ListingForAdvice) => l.daysToSell ?? (l.watchers > 0 ? 30 : Math.max(60, l.listedDays));

/**
 * Combining: separately each item earns its price after its own wait (postage charged covers each parcel);
 * together, the bundle sells at about the pace of its most wanted item, a bit slower for the higher total,
 * at a small discount, with one parcel saved per extra item. Worth showing only if it's clearly better.
 */
export function evaluateCombine(items: ListingForAdvice[], c: AdviceCosts = ADVICE_COSTS) {
  const separately = items.reduce((s, l) => s + pv(l.price, guessDays(l), c), 0);
  const fastest = Math.min(...items.map(guessDays));
  const daysTogether = Math.round(fastest * 1.25);
  // The buyer pays one postage instead of several (that saving is why the bundle moves at the faster item's
  // pace); K posts one parcel, which that one postage charge covers.
  const together = pv(items.reduce((s, l) => s + l.price, 0) * c.bundleFactor, daysTogether, c);
  return { separately: r2(separately), together: r2(together), daysSeparately: Math.round(Math.max(...items.map(guessDays))), daysTogether };
}

/** Splitting: the parts' own prices, after an extra listing each, against the bundle as it stands. */
export function evaluateSplit(l: ListingForAdvice, c: AdviceCosts = ADVICE_COSTS) {
  const parts = l.parts ?? [];
  const days = guessDays(l);
  const separately = parts.reduce((s, p) => s + pv(p.price, days, c), 0) - (parts.length - 1) * c.perListing;
  return { separately: r2(separately), together: r2(pv(l.price, days, c)), daysSeparately: Math.round(days), daysTogether: Math.round(days) };
}

const SYSTEM = `You look at a seller's active eBay UK listings and suggest bundles that would earn more or sell faster. Suggest combining only items one buyer would plausibly want together: the same brand or ecosystem (a phone and its case, earbuds and a charger), the same hobby, or a set (games for the same console). Prefer pairing slow items (long listed, no watchers) with a popular related one. Never pair unrelated items just because both are slow. Suggest splitting a listing only if it holds clearly separate valuable things. For each suggestion give a short bundle title (max 80 characters) and one sentence why. Return an empty list if nothing fits well.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "itemIds", "title", "reason"],
        properties: {
          kind: { type: "string", enum: ["combine", "split"] },
          itemIds: { type: "array", items: { type: "string" } },
          title: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export async function suggestBundles(env: Env, listings: ListingForAdvice[], api?: MessagesApi, costs = ADVICE_COSTS): Promise<Advice[]> {
  if (listings.length < 1 || (!env.ANTHROPIC_API_KEY && !api)) return [];
  const prompt = listings
    .slice(0, 150)
    .map((l) => `${l.itemId} | ${l.title} | £${l.price.toFixed(2)} | listed ${l.listedDays} days | ${l.watchers} watchers${l.parts?.length ? ` | parts: ${l.parts.map((p) => p.name).join(", ")}` : ""}`)
    .join("\n");
  const out = await completeOnce<{ suggestions: { kind: "combine" | "split"; itemIds: string[]; title: string; reason: string }[] }>(
    env,
    { job: "pricing:bundles", model: MODELS.triage, system: SYSTEM, prompt: `Listings (item id | title | price | age | watchers):\n${prompt}`, schema: SCHEMA },
    api,
  ).catch(() => null);
  const byId = new Map(listings.map((l) => [l.itemId, l]));
  const advice: Advice[] = [];
  for (const s of out?.suggestions ?? []) {
    const items = [...new Set(s.itemIds)].map((id) => byId.get(id)).filter((l): l is ListingForAdvice => !!l);
    if (s.kind === "combine" && items.length >= 2 && items.length <= 6) {
      const e = evaluateCombine(items, costs);
      // Only clearly better ideas: worth at least £2 and 5% more, or selling in half the time for no less.
      if (e.together >= e.separately * 1.05 + 2 || (e.daysTogether <= e.daysSeparately / 2 && e.together >= e.separately))
        advice.push({ kind: "combine", itemIds: items.map((l) => l.itemId), title: s.title.slice(0, 80), reason: s.reason, ...e });
    } else if (s.kind === "split" && items.length === 1 && (items[0].parts?.length ?? 0) >= 2) {
      const e = evaluateSplit(items[0], costs);
      if (e.separately >= e.together * 1.15 + 5)
        advice.push({ kind: "split", itemIds: [items[0].itemId], title: s.title.slice(0, 80), reason: s.reason, ...e });
    }
  }
  return advice;
}

/** Nightly (weekly in effect: skipped if advice was made in the last 6 days). */
export async function bundleAdvice(env: Env, now = Date.now(), api?: MessagesApi): Promise<string> {
  const last = await env.store.pricing.lastBundleAt();
  if (last && now - last < 6 * DAY) return "skipped: made this week";
  const decisions = new Map((await env.store.pricing.latestDecisions()).map((d) => [d.item_id, d.result]));
  const results = (await env.store.listings.latestSet()).map((s) => ({ ...s, result: decisions.get(s.item_id) ?? null }));
  const listings: ListingForAdvice[] = results
    .filter((r) => r.price > 0)
    .map((r) => {
      const d = r.result ? JSON.parse(r.result) : null;
      const parts = d?.method === "sum of parts" ? d.components.map((c: any) => ({ name: c.name, price: Math.max(0, (c.decision.total ?? 0) - c.typicalPostage) })) : undefined;
      return {
        itemId: r.item_id,
        title: r.title,
        price: r.price,
        listedDays: r.start_time ? Math.max(0, Math.round((now - Date.parse(r.start_time)) / DAY)) : 0,
        watchers: r.watch_count ?? 0,
        daysToSell: d?.decision?.options?.[1]?.daysToSell ?? null,
        parts,
      };
    });
  if (listings.length < 2) return "skipped: fewer than 2 listings";
  const advice = await suggestBundles(env, listings, api);
  await env.store.pricing.replaceBundleAdvice(
    now,
    advice.map((a) => ({ kind: a.kind, itemIds: a.itemIds, detail: JSON.stringify(a) })),
  );
  return `${advice.length} suggestions`;
}
