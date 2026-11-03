export interface Env {
  DB: D1Database;
  /** R2 photo storage, bound from Phase 8. */
  PHOTOS?: R2Bucket;
  /** sandbox | production. Selects eBay hosts and keyset; anything else fails closed. */
  EBAY_ENV: string;
  /** off | approval. The write gate refuses every eBay write unless this is "approval". */
  WRITE_MODE: string;
  EBAY_MARKETPLACE: string;
  EBAY_SITE_ID: string;
  PUBLIC_URL: string;
  EBAY_APP_ID: string;
  EBAY_CERT_ID: string;
  EBAY_DEV_ID: string;
  EBAY_RUNAME: string;
  /** Optional production keyset used only for Browse comps (public data, no seller account). */
  EBAY_COMPS_APP_ID?: string;
  EBAY_COMPS_CERT_ID?: string;
  /** Dashboard and PWA static files (web/dist). */
  ASSETS?: Fetcher;
  /** Bootstraps the owner's invite when nobody is registered; on Sandbox only, also a test sign-in. */
  DASHBOARD_KEY: string;
  /** VAPID key pair as a P-256 private JWK, for Web Push. */
  VAPID_KEY?: string;
  /** K's Anthropic API key, for the audit and nightly triage. */
  ANTHROPIC_API_KEY?: string;
  /** "true" on Sandbox only: DASHBOARD_KEY signs in as a test owner. */
  ALLOW_KEY_LOGIN?: string;
  /** "true" to serve /mcp (Sandbox). Off in production. */
  MCP_ENABLED?: string;
  /** Verification token for eBay marketplace account deletion notifications (32 to 80 characters). */
  EBAY_DELETION_TOKEN?: string;
  /** Third-party sold-price data (optional): Trawl and CompsAPI keys. Search words only are sent. */
  TRAWL_API_KEY?: string;
  COMPSAPI_KEY?: string;
  MCP_TOKEN: string;
  SIGNING_KEY: string;
  NTFY_TOPIC: string;
}
