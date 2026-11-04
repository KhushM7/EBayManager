import type { Env } from "./env";

// Web Push to the installed PWA: RFC 8291 payload encryption (aes128gcm) and RFC 8292 VAPID, on Web Crypto only.

const enc = new TextEncoder();

export const b64u = {
  encode: (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, (i += p.length) - p.length);
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Encrypts a push message for one subscription (RFC 8291, single aes128gcm record). */
export async function encryptPayload(plaintext: Uint8Array, p256dh: Uint8Array, auth: Uint8Array): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const server = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const serverPub = new Uint8Array((await crypto.subtle.exportKey("raw", server.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, server.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), p256dh, serverPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = serverPub.length;
  return concat(header, serverPub, ciphertext);
}

/** The VAPID public key (uncompressed point, base64url) the browser subscribes with. */
export function vapidPublicKey(env: Pick<Env, "VAPID_KEY">): string | null {
  if (!env.VAPID_KEY) return null;
  const jwk = JSON.parse(env.VAPID_KEY);
  return b64u.encode(concat(new Uint8Array([4]), b64u.decode(jwk.x), b64u.decode(jwk.y)));
}

async function vapidHeader(env: Env, endpoint: string): Promise<string> {
  const jwk = JSON.parse(env.VAPID_KEY!);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: object) => b64u.encode(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.PUBLIC_URL,
  })}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.encode(sig)}, k=${vapidPublicKey(env)}`;
}

export interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  /** Signed decide URLs; the service worker POSTs one when K taps Approve or Reject on the notification. */
  approveUrl?: string;
  rejectUrl?: string;
}

interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function saveSubscription(env: Env, s: Subscription, userAgent: string) {
  await env.store.push.save(s, userAgent.slice(0, 200), Date.now());
}

/** Sends to every subscribed device. Returns how many accepted it; gone subscriptions are removed. */
export async function sendToAll(env: Env, msg: PushMessage): Promise<number> {
  if (!env.VAPID_KEY) return 0;
  const results: Subscription[] = await env.store.push.list();
  let delivered = 0;
  for (const s of results) {
    try {
      const body = await encryptPayload(enc.encode(JSON.stringify(msg)), b64u.decode(s.p256dh), b64u.decode(s.auth));
      const res = await fetch(s.endpoint, {
        method: "POST",
        headers: {
          Authorization: await vapidHeader(env, s.endpoint),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "86400",
          Urgency: "high",
        },
        body,
      });
      if (res.status === 404 || res.status === 410) {
        await env.store.push.delete(s.endpoint);
        continue;
      }
      const ok = res.ok;
      if (ok) delivered++;
      if (ok) await env.store.push.markOk(s.endpoint, Date.now());
      else await env.store.push.markError(s.endpoint, `${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      await env.store.push.markError(s.endpoint, e instanceof Error ? e.message : String(e));
    }
  }
  return delivered;
}
