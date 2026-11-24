// K's house rules (selling rules confirmed 2026-10-12, approval rules 2026-11-02). The prompt never enforces these; the code does.

/**
 * Every eBay write needs K's approval: the write gate (src/ebay/write.ts) applies only proposals K approved.
 * These kinds can never be auto-applied, whatever a future auto-apply setting says.
 */
export const LOCKED_KINDS = [
  "price",
  "message",
  "new_message",
  "best_offer_response",
  "offer_to_watchers",
  "create_listing",
  "end_listing",
  "policy",
  "promote",
] as const;

/** A pending proposal expires after this many days, and so do its signed approval links. */
export const PROPOSAL_TTL_DAYS = 7;

/** Proposal guardrails: a proposed price change larger than this is flagged for a closer look. */
export const MAX_PRICE_STEP = 0.1;
export const MIN_DAYS_BETWEEN_PRICE_CHANGES = 7;

/** Returns: always accepted, buyer pays return postage (an eBay return policy). */
export const RETURNS = { accepted: true, periodDays: 30, buyerPaysReturnPostage: true } as const;

/**
 * Shipping (K, 2026-11-07): assume K has a box and ships, and collection in person is offered as well by
 * default (a second, free service on the listing). K can turn collection off per item, or make it collection only.
 */
export const DEFAULT_SHIPPING = "ship_and_collect" as const;
export const COLLECTION_OFFERED_BY_DEFAULT = DEFAULT_SHIPPING === "ship_and_collect";

/**
 * Offers to watchers (K, 2026-11-15): a reminder to people who liked the item, not a price cut, so the discount
 * is as small as possible. eBay's own rules leave one choice inside K's 5% limit: its Negotiation API takes 5% off
 * or more, and an offer runs 2 days (its specification, read 2026-11-24, before any offer was sent). The write gate
 * refuses any other percentage. `cooldownDays` is the gap between offers on a listing.
 */
export const WATCHER_OFFER = { minPercent: 5, maxPercent: 5, cooldownDays: 14, minListedDays: 7, durationDays: 2 } as const;

/** Promoted Listings: the lowest and highest general ad rate the app may set, percent. The write gate refuses others. */
export const PROMOTION_RATE = { min: 2, max: 4 } as const;

/** Claude spend cap per UTC day. Runs refuse to start once it's reached (target is $3 to $6 a month). */
export const CLAUDE_DAILY_BUDGET_USD = 1;

/**
 * Today's cap for this environment: CLAUDE_DAILY_BUDGET_USD, or lower when the app setting of the same name says
 * so (0 stops Claude altogether, K, 2026-11-24). The setting can only lower the cap, never raise it.
 */
export function claudeDailyBudgetUsd(env: { CLAUDE_DAILY_BUDGET_USD?: string }): number {
  const raw = env.CLAUDE_DAILY_BUDGET_USD?.trim();
  if (!raw) return CLAUDE_DAILY_BUDGET_USD;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(CLAUDE_DAILY_BUDGET_USD, Math.max(0, n)) : 0;
}

/** Whether Claude may be called at all here: a key is set and it isn't switched off. Today's spend is checked by the call itself. */
export const claudeAvailable = (env: { ANTHROPIC_API_KEY?: string; CLAUDE_DAILY_BUDGET_USD?: string }) =>
  Boolean(env.ANTHROPIC_API_KEY) && claudeDailyBudgetUsd(env) > 0;
