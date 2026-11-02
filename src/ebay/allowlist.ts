// Every eBay call the app may make (docs/security.md, "eBay calls the app may make"). Anything else is refused
// before it leaves the Worker. Changing this list is a security change: update security.md with it.

/** Trading verbs that only read. Callable through trading(). */
export const TRADING_READ = new Set(["GetMyeBaySelling", "GetItem", "GetMemberMessages", "GetMyMessages", "GetBestOffers", "GetUser", "GeteBayOfficialTime"]);

/** Trading verbs that check without changing anything. Only src/ebay/write.ts sends these. */
export const TRADING_CHECK = new Set(["VerifyAddFixedPriceItem"]);

/** Trading verbs that change eBay. Only the write gate sends these, after approval. */
export const TRADING_WRITE = new Set([
  "ReviseFixedPriceItem",
  "AddFixedPriceItem",
  "EndFixedPriceItem",
  "RelistFixedPriceItem",
  "AddMemberMessageRTQ",
  "RespondToBestOffer",
]);

/** REST calls by method and path prefix. Reads (and the token endpoint) only; REST writes are added with Phase 9/10. */
const REST: { method: string; prefix: string }[] = [
  { method: "POST", prefix: "/identity/v1/oauth2/token" },
  { method: "GET", prefix: "/sell/fulfillment/v1/order" },
  { method: "GET", prefix: "/sell/analytics/v1/traffic_report" },
  { method: "GET", prefix: "/sell/account/v1/fulfillment_policy" },
  { method: "GET", prefix: "/sell/account/v1/return_policy" },
  { method: "GET", prefix: "/sell/account/v1/payment_policy" },
  { method: "GET", prefix: "/buy/browse/v1/item_summary/search" },
  { method: "GET", prefix: "/buy/browse/v1/item/" },
  { method: "GET", prefix: "/commerce/taxonomy/v1/" },
  { method: "GET", prefix: "/sell/marketing/v1/ad_campaign" },
  { method: "POST", prefix: "/sell/recommendation/v1/find" },
  { method: "GET", prefix: "/commerce/notification/v1/public_key/" },
];

export class CallNotAllowed extends Error {}

export function assertTrading(verb: string, kind: "read" | "any") {
  const ok = kind === "read" ? TRADING_READ.has(verb) : TRADING_READ.has(verb) || TRADING_CHECK.has(verb) || TRADING_WRITE.has(verb);
  if (!ok) throw new CallNotAllowed(`eBay call ${verb} is not on the allowlist${kind === "read" ? " of read calls" : ""}`);
}

export function assertRest(method: string, url: string) {
  const path = new URL(url).pathname;
  if (!REST.some((r) => r.method === method.toUpperCase() && path.startsWith(r.prefix)))
    throw new CallNotAllowed(`eBay call ${method.toUpperCase()} ${path} is not on the allowlist`);
}
