import type { Env } from "../env";

export interface EbayHosts {
  auth: string;
  api: string;
  web: string;
  /** eBay's Media API (listing photos). eBay publishes no Sandbox host for it, so Sandbox has none. */
  media: string | null;
}

const HOSTS: Record<"sandbox" | "production", EbayHosts> = {
  sandbox: { auth: "https://auth.sandbox.ebay.com", api: "https://api.sandbox.ebay.com", web: "https://www.sandbox.ebay.com", media: null },
  production: { auth: "https://auth.ebay.com", api: "https://api.ebay.com", web: "https://www.ebay.co.uk", media: "https://apim.ebay.com" },
};

/** eBay hosts for this deployment. An unset or misspelt EBAY_ENV throws rather than defaulting to production. */
export function ebayHosts(env: Pick<Env, "EBAY_ENV">): EbayHosts {
  if (env.EBAY_ENV !== "sandbox" && env.EBAY_ENV !== "production")
    throw new Error(`EBAY_ENV must be "sandbox" or "production", got "${env.EBAY_ENV}"`);
  return HOSTS[env.EBAY_ENV];
}

export const PRODUCTION_HOSTS = HOSTS.production;
