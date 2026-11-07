import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { handleApi } from "../src/api";
import worker from "../src/index";
import { createProposal } from "../src/proposals";
import { challengeResponse, forgetUser } from "../src/deletion";
import { CallNotAllowed, assertRest, assertTrading } from "../src/ebay/allowlist";
import { base32Encode, stepAt, STEP_SECONDS, totpCode } from "../src/auth/totp";
import { parsePeople } from "../src/auth/people";

const ORIGIN = "https://app.example";
const enc = new TextEncoder();

/** A raw r||s ECDSA signature as DER, the way eBay sends it. */
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
const SIGNIN = "test-signin-path-0123456789";
const K_SECRET = base32Encode(new Uint8Array(20).fill(7));
const SAM_SECRET = base32Encode(new Uint8Array(20).fill(9));
const PEOPLE = JSON.stringify([
  { email: "k@example.com", name: "K", role: "owner", totp: K_SECRET },
  { email: "Sam@Example.com", name: "Sam", role: "manager", totp: SAM_SECRET },
]);

let env: Env;
const api = async (path: string, body?: unknown, cookie = "", headers: Record<string, string> = {}) => {
  const url = new URL(`${ORIGIN}/api${path}`);
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-EbayManager": "1", "Client-IP": "1.2.3.4:5000", Cookie: cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const res = await handleApi(env, new Request(url, init), url);
  const setCookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
  return { status: res.status, json: (await res.json()) as any, cookie: setCookie };
};
const fetchWorker = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

const codeNow = (secret: string, offsetSteps = 0) => totpCode(secret, stepAt(Date.now()) + offsetSteps);

/** Posts the hidden sign-in form, as the browser would from that page. */
async function signIn(email: string, code: string, opts: { stay?: boolean; ip?: string; origin?: string } = {}) {
  const form = new URLSearchParams({ email, code, ...(opts.stay ? { stay: "1" } : {}) });
  const res = await fetchWorker(`/s/${SIGNIN}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: opts.origin ?? ORIGIN, "Client-IP": `${opts.ip ?? "1.2.3.4"}:5000` },
    body: form.toString(),
  });
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  return { status: res.status, location: res.headers.get("Location"), cookie: setCookie.split(";")[0], setCookie, text: await res.text() };
}

async function team() {
  const owner = await signIn("k@example.com", await codeNow(K_SECRET));
  const manager = await signIn("sam@example.com", await codeNow(SAM_SECRET));
  expect(owner.status).toBe(303);
  expect(manager.status).toBe(303);
  return { owner, manager };
}

beforeEach(() => {
  env = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", PUBLIC_URL: ORIGIN, SIGNING_KEY: "sign", DASHBOARD_KEY: "boot-key-123", PEOPLE, SIGNIN_PATH: SIGNIN } as Env;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("authenticator codes", () => {
  it("match RFC 6238's SHA-1 test values", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    expect(await totpCode(secret, Math.floor(59 / STEP_SECONDS))).toBe("287082");
    expect(await totpCode(secret, Math.floor(1111111109 / STEP_SECONDS))).toBe("081804");
    expect(await totpCode(secret, Math.floor(2000000000 / STEP_SECONDS))).toBe("279037");
  });

  it("checks the people list strictly: one owner, three people at most, real secrets", async () => {
    const p = (list: unknown[]) => parsePeople(JSON.stringify(list));
    const k = { email: "k@example.com", name: "K", role: "owner", totp: K_SECRET };
    await expect(p([k])).resolves.toHaveLength(1);
    await expect(p([k, { ...k, email: "b@example.com" }])).rejects.toThrow(/exactly one owner/);
    await expect(p([k, ...[1, 2, 3].map((i) => ({ ...k, role: "manager", email: `m${i}@example.com` }))])).rejects.toThrow(/1 to 3/);
    await expect(p([{ ...k, totp: "ABCDEFGH" }])).rejects.toThrow(/160 bits/);
    await expect(p([k, { ...k, role: "manager", email: "K@example.com" }])).rejects.toThrow(/twice/);
  });
});

describe("signing in", () => {
  it("signs in with email and the current code, then the app works", async () => {
    const r = await signIn("  K@Example.com ", await codeNow(K_SECRET));
    expect(r.status).toBe(303);
    expect(r.location).toBe("/");
    expect(r.setCookie).toMatch(/__Host-sid=.+HttpOnly; Secure; SameSite=Lax/);
    const me = await api("/me", undefined, r.cookie);
    expect(me.json.user).toMatchObject({ name: "K", role: "owner" });
    // The first /me marks this browser as known.
    expect(me.cookie).toMatch(/^__Host-known=/);
  });

  it("accepts a code a step either side of now, for a phone clock a little out", async () => {
    expect((await signIn("k@example.com", await codeNow(K_SECRET, -1))).status).toBe(303);
    expect((await signIn("sam@example.com", await codeNow(SAM_SECRET, 1))).status).toBe(303);
    expect((await signIn("k@example.com", await codeNow(K_SECRET, 3))).status).toBe(401);
  });

  it("gives the same answer for an unknown email and a wrong code", async () => {
    const unknown = await signIn("stranger@example.com", await codeNow(K_SECRET));
    const wrong = await signIn("k@example.com", "000000");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const msg = (t: string) => t.match(/class="error"[^>]*>([^<]+)</)?.[1];
    expect(msg(unknown.text)).toBeTruthy();
    expect(msg(unknown.text)).toBe(msg(wrong.text));
    expect(unknown.cookie).toBe("");
  });

  it("uses each code once, and never an older one after a newer one", async () => {
    const code = await codeNow(K_SECRET);
    expect((await signIn("k@example.com", code)).status).toBe(303);
    expect((await signIn("k@example.com", code)).status).toBe(401);
    expect((await signIn("k@example.com", await codeNow(K_SECRET, -1))).status).toBe(401);
    expect((await signIn("k@example.com", await codeNow(K_SECRET, 1))).status).toBe(303);
  });

  it("limits wrong codes per person (5 in 15 minutes), even from different networks", async () => {
    for (let i = 0; i < 5; i++) expect((await signIn("k@example.com", "123456", { ip: `10.0.0.${i}` })).status).toBe(401);
    const blocked = await signIn("k@example.com", await codeNow(K_SECRET), { ip: "10.0.0.99" });
    expect(blocked.status).toBe(401);
    expect(blocked.text).toMatch(/Too many tries/);
    // Someone else is unaffected.
    expect((await signIn("sam@example.com", await codeNow(SAM_SECRET), { ip: "10.0.0.98" })).status).toBe(303);
  });

  it("limits failures per network (20 an hour)", async () => {
    for (let i = 0; i < 20; i++) await signIn(`nobody${i}@example.com`, "123456");
    const blocked = await signIn("sam@example.com", await codeNow(SAM_SECRET));
    expect(blocked.text).toMatch(/Too many tries/);
  });

  it("refuses a sign-in form posted from another site", async () => {
    const r = await signIn("k@example.com", await codeNow(K_SECRET), { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.cookie).toBe("");
  });

  it("stays signed in for 30 days only when asked; otherwise 12 hours idle and 7 days at most", async () => {
    const short = await signIn("k@example.com", await codeNow(K_SECRET));
    expect(short.setCookie).toMatch(/Max-Age=604800/);
    const long = await signIn("sam@example.com", await codeNow(SAM_SECRET), { stay: true });
    expect(long.setCookie).toMatch(/Max-Age=2592000/);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 13 * 3_600_000);
    expect((await api("/me", undefined, short.cookie)).status).toBe(401);
    expect((await api("/me", undefined, long.cookie)).status).toBe(200);
    vi.setSystemTime(Date.now() + 31 * 86_400_000);
    expect((await api("/me", undefined, long.cookie)).status).toBe(401);
  });

  it("lets nobody in when the people list is missing or malformed", async () => {
    const code = await codeNow(K_SECRET);
    env = { ...env, PEOPLE: PEOPLE.replace('"manager"', '"owner"') } as Env;
    expect((await signIn("k@example.com", code)).status).toBe(401);
    env = { ...env, PEOPLE: undefined } as Env;
    expect((await signIn("k@example.com", code)).status).toBe(401);
  });

  it("ends a person's access as soon as they are taken off the list", async () => {
    const { manager } = await team();
    expect((await api("/me", undefined, manager.cookie)).status).toBe(200);
    env = { ...env, PEOPLE: JSON.stringify([JSON.parse(PEOPLE)[0]]) } as Env;
    expect((await api("/me", undefined, manager.cookie)).status).toBe(401);
  });
});

describe("the hidden site", () => {
  it("shows strangers nothing: a blank Not found everywhere except the sign-in page", async () => {
    for (const path of ["/", "/settings", "/assets/index.js", "/api/me", "/api/proposals", "/health", "/oauth/start", "/oauth/callback?code=x&state=y", "/s/wrong-path-0123456789", "/mcp", "/decide/abc?d=approve&e=1&s=x", "/login", "/join"]) {
      const res = await fetchWorker(path, { headers: { "Client-IP": "1.2.3.4:5000" } });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("");
      expect(res.headers.get("X-Robots-Tag")).toMatch(/noindex/);
    }
    const posted = await fetchWorker("/api/auth/login/options", { method: "POST", headers: { "X-EbayManager": "1" } });
    expect(posted.status).toBe(404);
  });

  it("serves the sign-in page only at its secret address, with no script and no indexing", async () => {
    const res = await fetchWorker(`/s/${SIGNIN}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/autocomplete="one-time-code"/);
    expect(text).not.toMatch(/<script/i);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'/);
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    // A path that's too short can't be used.
    env = { ...env, SIGNIN_PATH: "short" } as Env;
    expect((await fetchWorker("/s/short")).status).toBe(404);
  });

  it("sends a device that signed in before to the sign-in page once its session ends", async () => {
    const { owner } = await team();
    const known = (await api("/me", undefined, owner.cookie)).cookie;
    await api("/logout", {}, owner.cookie);
    const home = await fetchWorker("/", { headers: { Cookie: known } });
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toBe(`/s/${SIGNIN}`);
    expect((await fetchWorker("/api/me", { headers: { Cookie: known } })).status).toBe(401);
    // A forged mark gets nothing.
    expect((await fetchWorker("/", { headers: { Cookie: known.replace(/.$/, (c) => (c === "A" ? "B" : "A")) } })).status).toBe(404);
  });

  it("serves the app icons and service worker to anyone (the browser fetches them without cookies), but not the manifest", async () => {
    env = { ...env, ASSETS: { serve: async (r: Request) => new Response(`file ${new URL(r.url).pathname}`) } } as Env;
    for (const path of ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/badge-96.png", "/sw.js"]) expect((await fetchWorker(path)).status, path).toBe(200);
    expect((await fetchWorker("/manifest.webmanifest")).status).toBe(404);
    const { owner } = await team();
    expect((await fetchWorker("/manifest.webmanifest", { headers: { Cookie: owner.cookie } })).status).toBe(200);
  });

  it("answers /health to a signed-in person or K's key only", async () => {
    expect((await fetchWorker("/health", { headers: { "X-Health-Key": "wrong" } })).status).toBe(404);
    const res = await fetchWorker("/health", { headers: { "X-Health-Key": "boot-key-123" } });
    expect(await res.json()).toMatchObject({ ebayEnv: "sandbox", writeMode: "approval" });
  });
});

describe("people and roles", () => {
  it("keeps owner-only actions from managers", async () => {
    const { owner, manager } = await team();
    expect((await api("/people", undefined, manager.cookie)).status).toBe(403);
    expect((await api("/people", undefined, owner.cookie)).json.people.map((p: any) => p.name)).toEqual(["K", "Sam"]);
    expect(JSON.stringify((await api("/people", undefined, owner.cookie)).json)).not.toContain(K_SECRET);
    expect((await api("/settings/writes", { paused: true }, manager.cookie)).status).toBe(200);
    expect((await api("/settings/writes", { paused: false }, manager.cookie)).status).toBe(403);
    expect((await api("/settings/writes", { paused: false }, owner.cookie)).status).toBe(200);
    // An Inbox answer is saved as K's facts about K's item: only K gives one.
    await env.store.todos.sync("audit", { codes: ["measurements"] }, [{ code: "measurements", kind: "answer", itemId: "1", itemTitle: null, title: "t", detail: "", fingerprint: "m" }], Date.now());
    const [todo] = await env.store.todos.list("open");
    expect((await api(`/todos/${todo.id}/answer`, { text: "Width 1 m" }, manager.cookie)).status).toBe(403);
    expect((await api(`/todos/${todo.id}/answer`, { text: "Width 1 m" }, owner.cookie)).status).toBe(200);
    // Proposing a price or setting an own price from a price check: K only.
    expect((await api("/pricing/propose", { itemId: "123456", price: 10 }, manager.cookie)).status).toBe(403);
    expect((await api("/pricing/own", { itemId: "123456", price: 10 }, manager.cookie)).status).toBe(403);
    expect((await api("/pricing/own", { itemId: "123456", price: "no idea" }, owner.cookie)).status).toBe(400);
  });

  it("has no way to add or change people from the app", async () => {
    const { owner } = await team();
    for (const path of ["/people/invite", "/setup", "/auth/register/options", "/auth/recover", "/passkeys/options"]) expect((await api(path, { name: "X" }, owner.cookie)).status).toBe(404);
  });

  it("records who decided a proposal", async () => {
    const { manager } = await team();
    const p = await createProposal(env, { kind: "price", itemId: "1", payload: { newPrice: 5 } });
    await api("/proposals/decide", { ids: [p.id], decision: "reject" }, manager.cookie);
    const row = await env.store.proposals.get(p.id);
    expect(row!.decided_by).toBe("Sam");
  });

  it("the owner can sign anyone out everywhere; a manager only themselves", async () => {
    const { owner, manager } = await team();
    const people = (await api("/people", undefined, owner.cookie)).json.people;
    const k = people.find((x: any) => x.name === "K");
    const sam = people.find((x: any) => x.name === "Sam");
    expect((await api(`/people/${k.id}/signout`, {}, manager.cookie)).status).toBe(403);
    expect((await api(`/people/${sam.id}/signout`, {}, owner.cookie)).status).toBe(200);
    expect((await api("/me", undefined, manager.cookie)).status).toBe(401);
    expect((await api("/me", undefined, owner.cookie)).status).toBe(200);
  });
});

describe("request protection", () => {
  it("refuses cross-site requests and requests without the custom header", async () => {
    const { owner } = await team();
    expect((await api("/settings/writes", { paused: true }, owner.cookie, { Origin: "https://evil.example" })).status).toBe(403);
    const url = new URL(`${ORIGIN}/api/logout`);
    expect((await handleApi(env, new Request(url, { method: "POST" }), url)).status).toBe(403);
  });

  it("never allows the key sign-in in production", async () => {
    env = { ...env, EBAY_ENV: "production", ALLOW_KEY_LOGIN: "true" } as Env;
    expect((await api("/login", { key: "boot-key-123" })).status).toBe(401);
    expect((await fetchWorker("/api/login", { method: "POST", headers: { "X-EbayManager": "1" }, body: JSON.stringify({ key: "boot-key-123" }) })).status).toBe(404);
  });
});

describe("production routes", () => {
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
    await env.store.messages.recordQuestion({ message_id: "m1", item_id: "1", sender: "gone_buyer", body: "hi", received_at: 0, proposal_id: "" });
    const p = await createProposal(env, { kind: "message", itemId: "1", payload: { recipientId: "gone_buyer", question: "hi", body: "hello" } });

    const body = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { data: { username: "gone_buyer", userId: "x" } } });
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-1" }, keys.privateKey, enc.encode(body)));
    const header = btoa(JSON.stringify({ alg: "ECDSA", kid: "k1", signature: btoa(String.fromCharCode(...rawToDer(raw))), digest: "SHA1" }));

    const post = (h: Record<string, string>) =>
      worker.fetch(new Request(`${ORIGIN}/ebay/account-deletion`, { method: "POST", body, headers: h }), env);
    expect((await post({})).status).toBe(412);
    expect((await post({ "X-EBAY-SIGNATURE": btoa(JSON.stringify({ kid: "k1", signature: "AAAA" })) })).status).toBe(412);
    expect((await post({ "X-EBAY-SIGNATURE": header })).status).toBe(204);

    expect(await env.store.messages.seenQuestion("m1")).toBe(false);
    const row = (await env.store.proposals.get(p.id))!;
    expect(row.status).toBe("expired");
    expect(row.payload).not.toContain("gone_buyer");
    expect(await forgetUser(env, "")).toBe(0);
  });
});


describe("connecting eBay", () => {
  it("needs the owner's session to start", async () => {
    const { manager } = await team();
    expect((await fetchWorker("/oauth/start")).status).toBe(404);
    expect((await fetchWorker("/oauth/start", { headers: { Cookie: manager.cookie } })).status).toBe(404);
  });

  it("accepts eBay's redirect without the session cookie, but only for a state the owner started", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "a", expires_in: 7200, refresh_token: "r", refresh_token_expires_in: 1e7 })));
    env = { ...env, EBAY_APP_ID: "app", EBAY_CERT_ID: "cert", EBAY_RUNAME: "runame" } as Env;
    const { owner } = await team();

    const start = await fetchWorker("/oauth/start", { headers: { Cookie: owner.cookie } });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const stateCookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0];

    // eBay's redirect back, without the session cookie: only the state cookie counts.
    const callback = (s: string) => fetchWorker(`/oauth/callback?code=c&state=${s}`, { headers: { Cookie: stateCookie } });
    expect((await callback(state)).status).toBe(200);
    expect(await env.store.kv.getEbayTokens()).not.toBeNull();
    expect((await callback(state)).status).toBe(400);
    expect((await callback("made-up")).status).toBe(404);
  });
});
