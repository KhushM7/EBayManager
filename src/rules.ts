// K's house rules (confirmed 2026-10-12). The prompt never enforces these; the code does.

/** Every price, new or changed, needs K's approval. No auto-applied price changes. */
export const PRICE_CHANGES_NEED_APPROVAL = true;

/** Every buyer message, counter-offer or offer response needs K's approval. */
export const MESSAGES_NEED_APPROVAL = true;

/** Pricing target: lower end of comparable sold prices, adjusted for condition. */
export const TARGET_COMP_PERCENTILE = 0.3;

/** Proposal guardrails: a proposed price change larger than this is flagged for a closer look. */
export const MAX_PRICE_STEP = 0.1;
export const MIN_DAYS_BETWEEN_PRICE_CHANGES = 7;

/** Returns: always accepted, buyer pays return postage (an eBay return policy). */
export const RETURNS = { accepted: true, periodDays: 30, buyerPaysReturnPostage: true } as const;

/** Shipping: assume K has a box and ships, unless the item is collection only. */
export const DEFAULT_SHIPPING = "ship" as const;
