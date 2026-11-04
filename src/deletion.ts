import type { Env } from "./env";
import { appToken } from "./ebay/auth";
import { assertRest } from "./ebay/allowlist";
import { ebayHosts } from "./ebay/hosts";
import { derToRaw } from "./auth/webauthn";

// eBay marketplace account deletion (required for a production keyset). eBay verifies the endpoint with a
// challenge, then POSTs signed notifications when an eBay user closes their account; the app deletes what it
// holds about that user: buyer usernames and question text (docs/security.md, "Buyer data").

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const deletionEndpoint = (env: Pick<Env, "PUBLIC_URL">) => `${env.PUBLIC_URL}/ebay/account-deletion`;

export async function challengeResponse(env: Env, code: string): Promise<string> {
  const data = new TextEncoder().encode(code + env.EBAY_DELETION_TOKEN + deletionEndpoint(env));
  return hex(await crypto.subtle.digest("SHA-256", data));
}

/** eBay's public key for a signature key ID, cached in settings. */
async function publicKeyPem(env: Env, kid: string): Promise<string> {
  const cacheKey = `ebay_public_key:${kid}`;
  const cached = await env.store.kv.get(cacheKey);
  if (cached) return cached;
  const keyUrl = `${ebayHosts(env).api}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`;
  assertRest("GET", keyUrl);
  const res = await fetch(keyUrl, {
    headers: { Authorization: `Bearer ${await appToken(env)}` },
  });
  if (!res.ok) throw new Error(`Public key lookup failed: ${res.status}`);
  const { key } = (await res.json()) as { key: string };
  await env.store.kv.set(cacheKey, key);
  return key;
}

/** Checks X-EBAY-SIGNATURE (base64 JSON: kid, ECDSA signature, SHA-1 digest) over the raw body. */
export async function verifySignature(env: Env, header: string | null, body: string): Promise<boolean> {
  if (!header) return false;
  let sig: { kid?: string; signature?: string; digest?: string };
  try {
    sig = JSON.parse(atob(header));
  } catch {
    return false;
  }
  if (!sig.kid || !sig.signature) return false;
  const pem = await publicKeyPem(env, sig.kid);
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signature = derToRaw(Uint8Array.from(atob(sig.signature), (c) => c.charCodeAt(0)));
  const hash = sig.digest?.toUpperCase() === "SHA256" ? "SHA-256" : "SHA-1";
  return crypto.subtle.verify({ name: "ECDSA", hash }, key, signature, new TextEncoder().encode(body));
}

/** Removes everything the app holds about one eBay user. Returns how many records changed. */
export async function forgetUser(env: Env, username: string): Promise<number> {
  const u = username.trim();
  if (!u) return 0;
  let changed = await env.store.messages.deleteByBuyer(u);
  // Drafts and answers that name them: personal fields scrubbed, and pending ones closed.
  const named = await env.store.proposals.listWhere([
    { f: "kind", op: "in", v: ["message", "best_offer_response"] },
    { f: "payload", op: "contains", v: JSON.stringify(u) },
  ]);
  for (const p of named) {
    const a = JSON.parse(p.payload);
    if (a.recipientId !== u && a.buyer !== u) continue;
    for (const k of ["recipientId", "buyer", "question", "buyerMessage", "body", "message"]) if (k in a) a[k] = "[deleted]";
    if (await env.store.proposals.scrub(p.id, JSON.stringify(a))) changed++;
  }
  changed += await env.store.audit.scrubText(u);
  return changed;
}

export async function handleAccountDeletion(env: Env, request: Request, url: URL): Promise<Response> {
  if (!env.EBAY_DELETION_TOKEN) return new Response("Not configured", { status: 503 });

  if (request.method === "GET") {
    const code = url.searchParams.get("challenge_code");
    if (!code) return new Response("Missing challenge_code", { status: 400 });
    return Response.json({ challengeResponse: await challengeResponse(env, code) });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = await request.text();
  if (body.length > 20_000) return new Response("Too large", { status: 413 });
  let ok = false;
  try {
    ok = await verifySignature(env, request.headers.get("X-EBAY-SIGNATURE"), body);
  } catch {
    ok = false;
  }
  // eBay's own SDK answers an unverifiable notification with 412.
  if (!ok) return new Response("Signature not valid", { status: 412 });

  const msg = JSON.parse(body);
  if (msg?.metadata?.topic !== "MARKETPLACE_ACCOUNT_DELETION") return new Response(null, { status: 204 });
  const changed = await forgetUser(env, String(msg.notification?.data?.username ?? ""));
  await env.store.kv.setJson("last_account_deletion", { at: Date.now(), changed });
  return new Response(null, { status: 204 });
}
