import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import { handleApi } from "../src/api";
import worker from "../src/index";
import { b64u } from "../src/push";
import { createProposal } from "../src/proposals";
import { challengeResponse, forgetUser } from "../src/deletion";
import { CallNotAllowed, assertRest, assertTrading } from "../src/ebay/allowlist";

const ORIGIN = "https://app.example";
const enc = new TextEncoder();
const sha256 = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", d));

// --- A tiny CBOR encoder, for building authenticator responses. ---
function cbor(v: any): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255];
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") {
    const b = enc.encode(v);
    return new Uint8Array([...head(3, b.length), ...b]);
  }
  if (v instanceof Uint8Array) return new Uint8Array([...head(2, v.length), ...v]);
  if (v instanceof Map) {
    const parts = [...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)]);
    return new Uint8Array([...head(5, v.size), ...parts]);
  }
  throw new Error("unsupported");
}

const rawToDer = (raw: Uint8Array) => {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
};

/** A software passkey: real ES256 keys and authenticator data, for driving the ceremonies in tests. */
class SoftPasskey {
  credId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  keys!: CryptoKeyPair;
  async init() {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return this;
  }
  async authData(rpId: string, flags: number, attested: boolean) {
    const parts = [...(await sha256(enc.encode(rpId))), flags, 0, 0, 0, this.counter];
    if (!attested) return new Uint8Array(parts);
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, b64u.decode(jwk.x!)], [-3, b64u.decode(jwk.y!)]]));
    return new Uint8Array([...parts, ...new Uint8Array(16), 0, this.credId.length, ...this.credId, ...cose]);
  }
  async create(options: any, opts: { origin?: string; flags?: number } = {}) {
    const clientDataJSON = enc.encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: opts.origin ?? ORIGIN }));
    const authData = await this.authData(options.rp.id, opts.flags ?? 0x45, true);
    const attestationObject = cbor(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64u.encode(this.credId),
      response: { clientDataJSON: b64u.encode(clientDataJSON), attestationObject: b64u.encode(attestationObject) },
    };
  }
  async get(options: any, opts: { flags?: number; tamper?: boolean; counter?: number } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const clientDataJSON = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: ORIGIN }));
    const authData = await this.authData(options.rpId, opts.flags ?? 0x05, false);
    const signed = new Uint8Array([...authData, ...(await sha256(clientDataJSON))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    if (opts.tamper) raw[5] ^= 1;
    return {
      id: b64u.encode(this.credId),
      response: { clientDataJSON: b64u.encode(clientDataJSON), authenticatorData: b64u.encode(authData), signature: b64u.encode(rawToDer(raw)) },
    };
  }
}

let env: Env;
const api = async (path: string, body?: unknown, cookie = "", headers: Record<string, string> = {}) => {
  const url = new URL(`${ORIGIN}/api${path}`);
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-EbayManager": "1", "CF-Connecting-IP": "1.2.3.4", Cookie: cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const res = await handleApi(env, new Request(url, init), url);
  const setCookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
  return { status: res.status, json: (await res.json()) as any, cookie: setCookie };
};

/** Invite -> register a passkey -> signed in. */
async function join(inviteUrl: string, key?: SoftPasskey) {
  const pk = key ?? (await new SoftPasskey().init());
  const invite = inviteUrl.split("#")[1];
  const opts = await api("/auth/register/options", { invite });
  const done = await api("/auth/register/verify", { challengeId: opts.json.challengeId, credential: await pk.create(opts.json.options), label: "Phone" });
  return { pk, cookie: done.cookie, codes: done.json.recoveryCodes as string[], status: done.status, error: done.json.error };
}

async function signIn(pk: SoftPasskey, opts: Parameters<SoftPasskey["get"]>[1] = {}) {
  const o = await api("/auth/login/options", {});
  return api("/auth/login/verify", { challengeId: o.json.challengeId, credential: await pk.get(o.json.options, opts) });
}

beforeEach(() => {
  env = { DB: fakeD1(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", PUBLIC_URL: ORIGIN, SIGNING_KEY: "sign", DASHBOARD_KEY: "boot-key-123" } as Env;
});
afterEach(() => vi.unstubAllGlobals());

describe("passkeys", () => {
  it("sets up the owner from DASHBOARD_KEY once, then signs in with the passkey", async () => {
    expect((await api("/setup", { key: "wrong", name: "K" })).status).toBe(401);
    const setup = await api("/setup", { key: "boot-key-123", name: "K" });
    expect(setup.json.inviteUrl).toMatch(/\/join#[\w-]{40,}$/);
    const owner = await join(setup.json.inviteUrl);
    expect(owner.status).toBe(200);
    expect(owner.codes).toHaveLength(10);
    expect((await api("/me", undefined, owner.cookie)).json.user).toMatchObject({ name: "K", role: "owner" });

    // Setup is closed once someone exists, and the invite can't be reused.
    expect((await api("/setup", { key: "boot-key-123" })).status).toBe(403);
    const reused = await api("/auth/register/options", { invite: setup.json.inviteUrl.split("#")[1] });
    expect(reused.status).toBe(400);
    expect(reused.json.error).toMatch(/expired or been used/);

    const again = await signIn(owner.pk);
    expect(again.status).toBe(200);
    expect(again.cookie).toMatch(/^__Host-sid=/);
  });

  it("rejects passkeys used on another site, without user verification, tampered, or with a rewound counter", async () => {
    const { json } = await api("/setup", { key: "boot-key-123", name: "K" });
    const invite = json.inviteUrl.split("#")[1];
    const pk = await new SoftPasskey().init();
    let o = await api("/auth/register/options", { invite });
    expect((await api("/auth/register/verify", { challengeId: o.json.challengeId, credential: await pk.create(o.json.options, { origin: "https://evil.example" }) })).json.error).toMatch(/wrong site/);
    o = await api("/auth/register/options", { invite });
    expect((await api("/auth/register/verify", { challengeId: o.json.challengeId, credential: await pk.create(o.json.options, { flags: 0x41 }) })).json.error).toMatch(/fingerprint, face or PIN/);

    const owner = await join(json.inviteUrl, pk);
    expect(owner.status).toBe(200);
    expect((await signIn(pk, { tamper: true })).json.error).toMatch(/signature/);
    expect((await signIn(pk, { flags: 0x01 })).json.error).toMatch(/fingerprint, face or PIN/);
    expect((await signIn(pk, { counter: 5 })).status).toBe(200);
    expect((await signIn(pk, { counter: 3 })).json.error).toMatch(/counter/);
  });

  it("can't reuse a challenge", async () => {
    const { json } = await api("/setup", { key: "boot-key-123", name: "K" });
    const owner = await join(json.inviteUrl);
    const o = await api("/auth/login/options", {});
    const cred = await owner.pk.get(o.json.options);
    expect((await api("/auth/login/verify", { challengeId: o.json.challengeId, credential: cred })).status).toBe(200);
    expect((await api("/auth/login/verify", { challengeId: o.json.challengeId, credential: cred })).json.error).toMatch(/expired/);
  });
});

describe("people and roles", () => {
  async function team() {
    const { json } = await api("/setup", { key: "boot-key-123", name: "K" });
    const owner = await join(json.inviteUrl);
    const inv = await api("/people/invite", { name: "Sam" }, owner.cookie);
    const manager = await join(inv.json.inviteUrl);
    return { owner, manager };
  }

  it("allows three people at most", async () => {
    const { owner } = await team();
    expect((await api("/people/invite", { name: "Alex" }, owner.cookie)).status).toBe(200);
    const fourth = await api("/people/invite", { name: "Too many" }, owner.cookie);
    expect(fourth.status).toBe(400);
    expect(fourth.json.error).toMatch(/limited to 3/);
  });

  it("keeps owner-only actions from managers", async () => {
    const { owner, manager } = await team();
    expect((await api("/people", undefined, manager.cookie)).status).toBe(403);
    expect((await api("/people/invite", { name: "X" }, manager.cookie)).status).toBe(403);
    expect((await api("/settings/writes", { paused: true }, manager.cookie)).status).toBe(200);
    expect((await api("/settings/writes", { paused: false }, manager.cookie)).status).toBe(403);
    expect((await api("/settings/writes", { paused: false }, owner.cookie)).status).toBe(200);
  });

  it("records who decided a proposal", async () => {
    const { manager } = await team();
    const p = await createProposal(env, { kind: "price", itemId: "1", payload: { newPrice: 5 } });
    await api("/proposals/decide", { ids: [p.id], decision: "reject" }, manager.cookie);
    const row = await env.DB.prepare("SELECT decided_by FROM proposals WHERE id = ?").bind(p.id).first<any>();
    expect(row.decided_by).toBe("Sam");
  });

  it("removing a person ends their sessions at once", async () => {
    const { owner, manager } = await team();
    const people = await api("/people", undefined, owner.cookie);
    const sam = people.json.people.find((x: any) => x.name === "Sam");
    expect((await api(`/people/${sam.id}/remove`, {}, owner.cookie)).status).toBe(200);
    expect((await api("/me", undefined, manager.cookie)).status).toBe(401);
    expect((await signIn(manager.pk)).status).toBe(400);
  });

  it("a recovery code works once and only allows registering a new passkey", async () => {
    const { manager } = await team();
    const rec = await api("/auth/recover", { code: manager.codes[0] });
    expect(rec.json.mustAddPasskey).toBe(true);
    expect((await api("/proposals", undefined, rec.cookie)).status).toBe(403);
    const pk = await new SoftPasskey().init();
    const o = await api("/passkeys/options", {}, rec.cookie);
    const added = await api("/passkeys/verify", { challengeId: o.json.challengeId, credential: await pk.create(o.json.options), label: "New phone" }, rec.cookie);
    expect(added.json.recoveryCodes).toHaveLength(10);
    expect((await api("/proposals", undefined, rec.cookie)).status).toBe(200);
    expect((await api("/auth/recover", { code: manager.codes[0] })).status).toBe(400);
  });
});

describe("request protection", () => {
  it("rate-limits sign-in attempts per network", async () => {
    for (let i = 0; i < 20; i++) await api("/auth/recover", { code: "nope" });
    expect((await api("/auth/recover", { code: "nope" })).status).toBe(429);
  });

  it("refuses cross-site requests and requests without the custom header", async () => {
    expect((await api("/auth/login/options", {}, "", { Origin: "https://evil.example" })).status).toBe(403);
    const url = new URL(`${ORIGIN}/api/logout`);
    expect((await handleApi(env, new Request(url, { method: "POST" }), url)).status).toBe(403);
  });

  it("never allows the key sign-in in production", async () => {
    env = { ...env, EBAY_ENV: "production", ALLOW_KEY_LOGIN: "true" } as Env;
    expect((await api("/login", { key: "boot-key-123" })).status).toBe(401);
  });
});

describe("production routes", () => {
  const fetchWorker = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

  it("serves /mcp only when switched on", async () => {
    expect((await fetchWorker("/mcp", { method: "POST" })).status).toBe(404);
  });

  it("needs the owner's session to connect eBay", async () => {
    expect((await fetchWorker("/oauth/start")).status).toBe(401);
  });

  it("needs a signed-in device for a production approval link, even when it is correctly signed", async () => {
    env = { ...env, EBAY_ENV: "production", WRITE_MODE: "off" } as Env;
    const { decisionLinks } = await import("../src/proposals");
    const p = await createProposal(env, { kind: "price", itemId: "1", payload: { newPrice: 5 } });
    const links = await decisionLinks(env, { ...p, dry_run: 0 });
    const res = await worker.fetch(new Request(links!.approve, { method: "POST", headers: { Accept: "application/json" } }), env);
    expect(res.status).toBe(401);
  });
});

describe("eBay call allowlist", () => {
  it("refuses calls that aren't listed", () => {
    expect(() => assertTrading("ReviseFixedPriceItem", "read")).toThrow(CallNotAllowed);
    expect(() => assertTrading("SetUserPreferences", "any")).toThrow(CallNotAllowed);
    expect(() => assertTrading("GetItem", "read")).not.toThrow();
    expect(() => assertRest("POST", "https://api.ebay.com/sell/account/v1/return_policy")).toThrow(CallNotAllowed);
    expect(() => assertRest("GET", "https://api.ebay.com/sell/finances/v1/payout")).toThrow(CallNotAllowed);
    expect(() => assertRest("GET", "https://api.ebay.com/sell/fulfillment/v1/order?limit=1")).not.toThrow();
  });
});

describe("marketplace account deletion", () => {
  beforeEach(() => {
    env = { ...env, EBAY_DELETION_TOKEN: "verification-token-0123456789-abcdefghij", EBAY_APP_ID: "a", EBAY_CERT_ID: "c" } as Env;
  });

  it("answers eBay's challenge", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/ebay/account-deletion?challenge_code=abc`), env);
    const expected = await challengeResponse(env, "abc");
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(await res.json()).toEqual({ challengeResponse: expected });
  });

  it("deletes a buyer's data on a correctly signed notification, and ignores unsigned ones", async () => {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer);
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/identity/") ? Response.json({ access_token: "t", expires_in: 7200 }) : Response.json({ key: pem, algorithm: "ECDSA", digest: "SHA1" }),
      ),
    );
    await env.DB.prepare("INSERT INTO buyer_messages (message_id, item_id, sender, body, received_at) VALUES ('m1', '1', 'gone_buyer', 'hi', 0)").run();
    const p = await createProposal(env, { kind: "message", itemId: "1", payload: { recipientId: "gone_buyer", question: "hi", body: "hello" } });

    const body = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { data: { username: "gone_buyer", userId: "x" } } });
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-1" }, keys.privateKey, enc.encode(body)));
    const header = btoa(JSON.stringify({ alg: "ECDSA", kid: "k1", signature: btoa(String.fromCharCode(...rawToDer(raw))), digest: "SHA1" }));

    const post = (h: Record<string, string>) =>
      worker.fetch(new Request(`${ORIGIN}/ebay/account-deletion`, { method: "POST", body, headers: h }), env);
    expect((await post({})).status).toBe(412);
    expect((await post({ "X-EBAY-SIGNATURE": btoa(JSON.stringify({ kid: "k1", signature: "AAAA" })) })).status).toBe(412);
    expect((await post({ "X-EBAY-SIGNATURE": header })).status).toBe(204);

    expect(await env.DB.prepare("SELECT * FROM buyer_messages WHERE sender = 'gone_buyer'").first()).toBeNull();
    const row = await env.DB.prepare("SELECT status, payload FROM proposals WHERE id = ?").bind(p.id).first<any>();
    expect(row.status).toBe("expired");
    expect(row.payload).not.toContain("gone_buyer");
    expect(await forgetUser(env, "")).toBe(0);
  });
});

describe("connecting eBay", () => {
  it("accepts eBay's redirect without the session cookie, but only for a state the owner started", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "a", expires_in: 7200, refresh_token: "r", refresh_token_expires_in: 1e7 })));
    env = { ...env, EBAY_APP_ID: "app", EBAY_CERT_ID: "cert", EBAY_RUNAME: "runame" } as Env;
    const { json } = await api("/setup", { key: "boot-key-123", name: "K" });
    const owner = await join(json.inviteUrl);

    const start = await worker.fetch(new Request(`${ORIGIN}/oauth/start`, { headers: { Cookie: owner.cookie } }), env);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const stateCookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0];

    // eBay's redirect back: no session cookie (SameSite=Strict), only the state cookie.
    const callback = (s: string) => worker.fetch(new Request(`${ORIGIN}/oauth/callback?code=c&state=${s}`, { headers: { Cookie: stateCookie } }), env);
    expect((await callback(state)).status).toBe(200);
    expect(await env.DB.prepare("SELECT scopes FROM ebay_tokens").first()).not.toBeNull();
    expect((await callback(state)).status).toBe(400);
    expect((await callback("made-up")).status).toBe(400);
  });
});
