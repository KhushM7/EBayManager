import type { Env } from "./env";

// Signing for one-tap approval links (docs/approvals.md). Only a link signed with SIGNING_KEY can decide a
// proposal, and deciding is still a POST to /decide (src/index.ts). This file imports nothing but types, so
// code that must never reach the write gate (src/readonly.ts) can build the same links.

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const signDecision = (env: Pick<Env, "SIGNING_KEY">, id: string, decision: "approve" | "reject", expiresAt: number) =>
  hmac(env.SIGNING_KEY, `${id}:${decision}:${expiresAt}`);

export async function verifyDecision(env: Pick<Env, "SIGNING_KEY">, id: string, decision: "approve" | "reject", expiresAt: number, sig: string) {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = await signDecision(env, id, decision, expiresAt);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** The address of a signed approve or reject page for a proposal, valid until the proposal expires. */
export const decisionUrl = async (env: Pick<Env, "SIGNING_KEY" | "PUBLIC_URL">, p: { id: string; expires_at: number }, d: "approve" | "reject") =>
  `${env.PUBLIC_URL}/decide/${p.id}?d=${d}&e=${p.expires_at}&s=${await signDecision(env, p.id, d, p.expires_at)}`;
