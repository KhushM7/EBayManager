export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
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
  MCP_TOKEN: string;
  SIGNING_KEY: string;
  NTFY_TOPIC: string;
}
