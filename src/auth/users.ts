import type { Env } from "../env";
import { b64u } from "../push";
import { findByEmail, findUser, type Role, type User } from "./people";
import { matchStep } from "./totp";

// Signing in and sessions (docs/security.md). A person signs in with their email and the 6-digit code from
// their authenticator app; the people and their authenticator secrets come only from K's PEOPLE list
// (src/auth/people.ts). Sessions are random tokens stored hashed. A normal sign-in lasts 12 hours idle and
// 7 days at most; "stay signed in" (the installed phone app, so notification approvals keep working) lasts
// 30 days.
//
// The session cookie is SameSite=Lax, not Strict (K, 2026-11-07): an installed phone app opened from the home
// screen counts as arriving from outside, and a Strict cookie isn't sent then, so every launch asked for a new
// sign-in. Lax is sent only on top-level GET navigations from elsewhere, which change nothing. Every change
// still needs the X-EbayManager header and a same-origin request (src/api.ts), the sign-in form checks its
// origin, and a cross-site POST to an approval link carries no session, so the real account refuses it.

export type { Role, User };

const SESSION_IDLE_MS = 12 * 3_600_000;
const SESSION_MAX_MS = 7 * 86_400_000;
const LONG_SESSION_MS = 30 * 86_400_000;
const CHALLENGE_TTL_MS = 10 * 60_000;
export const COOKIE = "__Host-sid";

export interface Session {
  user: User;
  id: string;
}

const random = (n = 32) => b64u.encode(crypto.getRandomValues(new Uint8Array(n)));
export const hash = async (s: string) => b64u.encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// --- Rate limiting ---

export async function tooManyAttempts(env: Env, key: string, limit: number, windowMs: number): Promise<boolean> {
  return (await env.store.auth.countAttempts(key, Date.now() - windowMs)) >= limit;
}

/** Records a failed attempt; kept 24 hours (by TTL). */
export async function recordFailure(env: Env, key: string) {
  await env.store.auth.recordAttempt(key, Date.now());
}

// --- Signing in with email and authenticator code ---

/** Failed codes allowed per person in 15 minutes, on top of the per-network limit (20 an hour). */
export const PERSON_FAILURES = 5;
const PERSON_WINDOW_MS = 15 * 60_000;
export const NETWORK_FAILURES = 20;
const NETWORK_WINDOW_MS = 3_600_000;

export class SignInRefused extends Error {}
/** The same words whether the email is unknown or the code is wrong, so nobody can test which emails work. */
export const WRONG = "That email and code didn't match. Check you're using the newest code and try again.";
export const TOO_MANY = "Too many tries. Wait 15 minutes and try again.";

/** A secret no one has, checked for an unknown email so the answer takes as long as for a real one. */
const DECOY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Checks an email and code; returns the person, or throws SignInRefused. Each code works once. */
export async function signIn(env: Env, email: string, code: string, ip: string): Promise<User> {
  const person = await findByEmail(env, email);
  const personKey = person ? `user:${person.id}` : `email:${await hash(String(email).trim().toLowerCase())}`;
  if (
    (await tooManyAttempts(env, `ip:${ip}`, NETWORK_FAILURES, NETWORK_WINDOW_MS)) ||
    (await tooManyAttempts(env, personKey, PERSON_FAILURES, PERSON_WINDOW_MS))
  )
    throw new SignInRefused(TOO_MANY);
  const step = await matchStep(person?.totp ?? DECOY, code, Date.now());
  // A code already used (or an older one once a newer one was used) is refused: a code seen over someone's
  // shoulder or caught on its way can't be used a second time.
  const ok = person !== null && step !== null && (await env.store.auth.claimTotpStep(person.id, step));
  if (!ok) {
    await recordFailure(env, `ip:${ip}`);
    await recordFailure(env, personKey);
    throw new SignInRefused(WRONG);
  }
  return { id: person.id, name: person.name, role: person.role };
}

// --- Sessions ---

/** Starts a session; returns the Set-Cookie value. `stay` gives the 30-day session. */
export async function createSession(env: Env, userId: string, request: Request, stay = false) {
  const token = random(32);
  const now = Date.now();
  const idle = stay ? LONG_SESSION_MS : SESSION_IDLE_MS;
  const max = stay ? LONG_SESSION_MS : SESSION_MAX_MS;
  await env.store.auth.createSession({
    id_hash: await hash(token),
    user_id: userId,
    created_at: now,
    last_seen_at: now,
    expires_at: now + max,
    idle_ms: idle,
    user_agent: (request.headers.get("User-Agent") ?? "").slice(0, 200),
    revoked: 0,
  });
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${max / 1000}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

const tokenFrom = (request: Request) => (request.headers.get("Cookie") ?? "").match(new RegExp(`${COOKIE}=([\\w-]{20,})`))?.[1];

export async function getSession(env: Env, request: Request): Promise<Session | null> {
  const token = tokenFrom(request);
  if (!token) return null;
  const id = await hash(token);
  const s = await env.store.auth.getSession(id);
  const now = Date.now();
  if (!s) return null;
  const idle = s.idle_ms ?? SESSION_IDLE_MS;
  if (s.revoked || s.expires_at < now || s.last_seen_at + idle < now) return null;
  // Someone taken off the list loses access at once, whatever sessions they had.
  const user = await findUser(env, s.user_id);
  if (!user) return null;
  if (now - s.last_seen_at > 5 * 60_000) await env.store.auth.touchSession(id, s, now);
  return { id, user };
}

export async function endSession(env: Env, request: Request) {
  const token = tokenFrom(request);
  if (token) await env.store.auth.revokeSession(await hash(token));
}

export async function signOutEverywhere(env: Env, userId: string) {
  await env.store.auth.revokeAllSessions(userId);
}

// --- This device has signed in before ---
// A long-lived cookie, signed with SIGNING_KEY, that marks a browser where one of the people has signed in.
// It is not a sign-in: it only lets that browser find the hidden sign-in page again (src/index.ts) once its
// session ends. Anyone else gets a blank "Not found" everywhere.

export const KNOWN_COOKIE = "__Host-known";
const KNOWN_MAX_AGE = 400 * 86_400;

async function mac(env: Env, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u.encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`known-device:${msg}`))));
}

export async function knownDeviceCookie(env: Env, userId: string) {
  return `${KNOWN_COOKIE}=${userId}.${await mac(env, userId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${KNOWN_MAX_AGE}`;
}

/** True when this browser carries a valid known-device mark for someone still on the list. */
export async function isKnownDevice(env: Env, request: Request): Promise<boolean> {
  const m = (request.headers.get("Cookie") ?? "").match(new RegExp(`${KNOWN_COOKIE}=([\\w-]{1,64})\\.([\\w-]{20,})`));
  if (!m) return false;
  const expected = await mac(env, m[1]);
  if (expected.length !== m[2].length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0 && (await findUser(env, m[1])) !== null;
}

// --- Connecting eBay (owner only) ---

async function newChallenge(env: Env, purpose: string, data: object = {}) {
  const id = random(16);
  const now = Date.now();
  await env.store.auth.createChallenge({ id, challenge: random(32), purpose, data: JSON.stringify(data), expires_at: now + CHALLENGE_TTL_MS }, now);
  return id;
}

/** Records the owner starting the eBay sign-in; returns the state to send to eBay. */
export async function startOAuth(env: Env, userId: string, readonly: boolean): Promise<string> {
  return newChallenge(env, "oauth", { userId, readonly });
}

/** Accepts the callback's state once, if an owner started it in the last few minutes. */
export async function finishOAuth(env: Env, state: string): Promise<{ readonly: boolean } | null> {
  const row = await env.store.auth.takeChallenge(String(state));
  if (!row || row.purpose !== "oauth" || row.expires_at < Date.now()) return null;
  const data = JSON.parse(row.data);
  const user = await findUser(env, String(data.userId));
  return user?.role === "owner" ? { readonly: Boolean(data.readonly) } : null;
}
