import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import { b64u, encryptPayload, vapidPublicKey } from "../src/push";
import { handleApi } from "../src/api";
import { createProposal, getProposal } from "../src/proposals";

const enc = new TextEncoder();

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

describe("Web Push encryption (RFC 8291)", () => {
  it("decrypts on the browser side to the original message", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const uaPub = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const message = JSON.stringify({ title: "[SANDBOX] Price: 6 → 5.5", body: "test" });

    const record = await encryptPayload(enc.encode(message), uaPub, auth);

    // What the browser does.
    const salt = record.slice(0, 16);
    expect(new DataView(record.buffer).getUint32(16)).toBe(4096);
    const idlen = record[20];
    const serverPub = record.slice(21, 21 + idlen);
    const serverKey = await crypto.subtle.importKey("raw", serverPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey } as any, ua.privateKey, 256));
    const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPub, ...serverPub]);
    const ikm = await hkdf(auth, shared, info, 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, record.slice(21 + idlen)));
    expect(plain.at(-1)).toBe(2);
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(message);
  });

  it("derives the public key from the VAPID private JWK", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    expect(vapidPublicKey({ VAPID_KEY: JSON.stringify(jwk) })).toBe(b64u.encode(raw));
  });
});

describe("dashboard API", () => {
  let env: Env;
  const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) => {
    const url = new URL(`https://test.example/api${path}`);
    return handleApi(env, new Request(url, { ...init, headers: { "X-EbayManager": "1", ...headers, ...(init.headers as any) } }), url);
  };
  const login = async () => {
    const res = await call("/login", { method: "POST", body: JSON.stringify({ key: "dash-key" }) });
    return (res.headers.get("Set-Cookie") ?? "").split(";")[0];
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<x/>")));
    env = { DB: fakeD1(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", SIGNING_KEY: "k", DASHBOARD_KEY: "dash-key", MCP_TOKEN: "mcp" } as Env;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("needs a session for data", async () => {
    expect((await call("/proposals")).status).toBe(401);
    expect((await call("/me", {}, { Cookie: "__Host-sid=99999999999999.forged" })).status).toBe(401);
  });

  it("rejects a wrong key, including the MCP token", async () => {
    for (const key of ["nope", "mcp", ""])
      expect((await call("/login", { method: "POST", body: JSON.stringify({ key }) })).status).toBe(401);
  });

  it("refuses state changes without the custom header", async () => {
    const cookie = await login();
    const url = new URL("https://test.example/api/settings/writes");
    const res = await handleApi(env, new Request(url, { method: "POST", headers: { Cookie: cookie }, body: "{}" }), url);
    expect(res.status).toBe(403);
  });

  it("signs in, lists and rejects a proposal, and pauses writes", async () => {
    const cookie = await login();
    expect(cookie).toMatch(/^__Host-sid=\d+\./);
    const p = await createProposal(env, { kind: "price", itemId: "1", payload: { newPrice: 5 } });

    const list = (await (await call("/proposals", {}, { Cookie: cookie })).json()) as any;
    expect(list.map((x: any) => x.id)).toEqual([p.id]);

    const decided = (await (
      await call("/proposals/decide", { method: "POST", body: JSON.stringify({ ids: [p.id], decision: "reject" }) }, { Cookie: cookie })
    ).json()) as any;
    expect(decided.results[0].result).toBe("Rejected");
    expect((await getProposal(env, p.id))?.status).toBe("rejected");

    await call("/settings/writes", { method: "POST", body: JSON.stringify({ paused: true }) }, { Cookie: cookie });
    const me = (await (await call("/me", {}, { Cookie: cookie })).json()) as any;
    expect(me.writesPaused).toBe(true);
    expect(me.writesBlocked).toBe("Writes are paused");
  });

  it("only stores https push subscriptions", async () => {
    const cookie = await login();
    const bad = { subscription: { endpoint: "http://evil.example", keys: { p256dh: "a", auth: "b" } } };
    expect((await call("/push/subscribe", { method: "POST", body: JSON.stringify(bad) }, { Cookie: cookie })).status).toBe(400);
  });
});
