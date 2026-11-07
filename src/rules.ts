// K's house rules (selling rules confirmed 2026-10-12, approval rules 2026-11-02). The prompt never enforces these; the code does.

/**
 * Every eBay write needs K's approval: the write gate (src/ebay/write.ts) applies only proposals K approved.
 * These kinds can never be auto-applied, whatever a future auto-apply setting says.
 */
export const LOCKED_KINDS = [
  "price",
  "message",
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

/** Claude spend cap per UTC day. Runs refuse to start once it's reached (target is $3 to $6 a month). */
export const CLAUDE_DAILY_BUDGET_USD = 1;
