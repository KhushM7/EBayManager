import type { Env } from "../env";

const AUTH_HOST = "https://auth.ebay.com";
const API_HOST = "https://api.ebay.com";

// Scopes for the seller's user token. Trading API calls accept this token too.
export const USER_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
];

const basic = (env: Env) => "Basic " + btoa(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`);

export function consentUrl(env: Env, state: string): string {
  const u = new URL(`${AUTH_HOST}/oauth2/authorize`);
  u.searchParams.set("client_id", env.EBAY_APP_ID);
  u.searchParams.set("redirect_uri", env.EBAY_RUNAME);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", USER_SCOPES.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

async function tokenRequest(env: Env, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${API_HOST}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: basic(env), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`eBay token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function exchangeCode(env: Env, code: string): Promise<void> {
  const t = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.EBAY_RUNAME,
  });
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO ebay_tokens (id, access_token, access_expires_at, refresh_token, refresh_expires_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token,
       access_expires_at = excluded.access_expires_at, refresh_token = excluded.refresh_token,
       refresh_expires_at = excluded.refresh_expires_at`,
  )
    .bind(t.access_token, now + t.expires_in * 1000, t.refresh_token, now + (t.refresh_token_expires_in ?? 0) * 1000)
    .run();
}

/** The seller's access token, refreshed when it is within 5 minutes of expiry. */
export async function userToken(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT * FROM ebay_tokens WHERE id = 1").first<{
    access_token: string;
    access_expires_at: number;
    refresh_token: string;
  }>();
  if (!row) throw new Error("eBay is not connected yet. Open /oauth/start to sign in.");
  if (row.access_expires_at - Date.now() > 5 * 60_000) return row.access_token;

  const t = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
    scope: USER_SCOPES.join(" "),
  });
  await env.DB.prepare("UPDATE ebay_tokens SET access_token = ?, access_expires_at = ? WHERE id = 1")
    .bind(t.access_token, Date.now() + t.expires_in * 1000)
    .run();
  return t.access_token;
}

let appTokenCache: { token: string; expiresAt: number } | undefined;

/** Application token (client credentials) for public APIs such as Browse. */
export async function appToken(env: Env): Promise<string> {
  if (appTokenCache && appTokenCache.expiresAt - Date.now() > 5 * 60_000) return appTokenCache.token;
  const t = await tokenRequest(env, {
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  appTokenCache = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  return t.access_token;
}
