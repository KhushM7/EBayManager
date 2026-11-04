import type { Env } from "../env";
import { assertRest } from "./allowlist";
import { ebayHosts, PRODUCTION_HOSTS } from "./hosts";

// Scope URIs are the same on Sandbox and production.
const SCOPE = "https://api.ebay.com/oauth/api_scope";

/** Full seller scopes, requested only when WRITE_MODE=approval. */
export const FULL_SCOPES = [
  SCOPE,
  `${SCOPE}/sell.inventory`,
  `${SCOPE}/sell.marketing`,
  `${SCOPE}/sell.account`,
  `${SCOPE}/sell.fulfillment`,
  `${SCOPE}/sell.analytics.readonly`,
];

/**
 * Read-only scopes. These stop REST writes at eBay's end, but the Trading API ignores scopes,
 * so WRITE_MODE and the write gate remain the real guard (docs/safety-and-environments.md).
 */
export const READONLY_SCOPES = [
  SCOPE,
  `${SCOPE}/sell.inventory.readonly`,
  `${SCOPE}/sell.marketing.readonly`,
  `${SCOPE}/sell.account.readonly`,
  `${SCOPE}/sell.fulfillment.readonly`,
  `${SCOPE}/sell.analytics.readonly`,
];

/** Read-only unless writes are on and read-only wasn't asked for. */
export const userScopes = (env: Env, readonly = false) =>
  readonly || env.WRITE_MODE !== "approval" ? READONLY_SCOPES : FULL_SCOPES;

const basic = (appId: string, certId: string) => "Basic " + btoa(`${appId}:${certId}`);

export function consentUrl(env: Env, state: string, scopes: string[]): string {
  const u = new URL(`${ebayHosts(env).auth}/oauth2/authorize`);
  u.searchParams.set("client_id", env.EBAY_APP_ID);
  u.searchParams.set("redirect_uri", env.EBAY_RUNAME);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

async function tokenRequest(apiHost: string, auth: string, body: Record<string, string>): Promise<TokenResponse> {
  assertRest("POST", `${apiHost}/identity/v1/oauth2/token`);
  const res = await fetch(`${apiHost}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`eBay token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function exchangeCode(env: Env, code: string, scopes: string[]): Promise<void> {
  const t = await tokenRequest(ebayHosts(env).api, basic(env.EBAY_APP_ID, env.EBAY_CERT_ID), {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.EBAY_RUNAME,
  });
  const now = Date.now();
  await env.store.kv.saveEbayTokens({
    access_token: t.access_token,
    access_expires_at: now + t.expires_in * 1000,
    refresh_token: String(t.refresh_token ?? ""),
    refresh_expires_at: now + (t.refresh_token_expires_in ?? 0) * 1000,
    scopes: scopes.join(" "),
  });
}

/** The seller's access token, refreshed when it is within 5 minutes of expiry. */
export async function userToken(env: Env): Promise<string> {
  const row = await env.store.kv.getEbayTokens();
  if (!row) throw new Error("eBay is not connected yet. Open /oauth/start to sign in.");
  if (row.access_expires_at - Date.now() > 5 * 60_000) return row.access_token;

  // Refresh with the scopes K consented to; asking for more would fail.
  const t = await tokenRequest(ebayHosts(env).api, basic(env.EBAY_APP_ID, env.EBAY_CERT_ID), {
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
    scope: row.scopes,
  });
  await env.store.kv.updateEbayAccess(t.access_token, Date.now() + t.expires_in * 1000);
  return t.access_token;
}

const appTokens = new Map<string, { token: string; expiresAt: number }>();

/** Application token (client credentials) for public eBay APIs; links no seller account. Cached per keyset. */
async function clientToken(api: string, auth: string): Promise<string> {
  const cached = appTokens.get(api + auth);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const t = await tokenRequest(api, auth, { grant_type: "client_credentials", scope: SCOPE });
  appTokens.set(api + auth, { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

/** This deployment's own application token (account deletion public keys, Taxonomy). */
export const appToken = (env: Env) => clientToken(ebayHosts(env).api, basic(env.EBAY_APP_ID, env.EBAY_CERT_ID));

/**
 * Application token for Browse comps. Uses the production keyset when EBAY_COMPS_APP_ID is set, because
 * Sandbox has almost no listings; this links no seller account.
 */
export async function compsAccess(env: Env): Promise<{ token: string; api: string }> {
  const prod = Boolean(env.EBAY_COMPS_APP_ID && env.EBAY_COMPS_CERT_ID);
  const api = prod ? PRODUCTION_HOSTS.api : ebayHosts(env).api;
  const auth = prod ? basic(env.EBAY_COMPS_APP_ID!, env.EBAY_COMPS_CERT_ID!) : basic(env.EBAY_APP_ID, env.EBAY_CERT_ID);
  return { token: await clientToken(api, auth), api };
}
