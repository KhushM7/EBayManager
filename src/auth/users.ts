import type { Env } from "../env";
import { b64u } from "../push";
import { verifyAuthentication, verifyRegistration } from "./webauthn";

// People, passkeys, invites, recovery codes and sessions (docs/security.md). At most three people: K as owner
// and two managers. Sessions are random tokens stored hashed; 12 hours idle, 7 days at most. Storage is in
// src/store/auth.ts, where every multi-step change (registration, recovery codes, removing someone) is one
// all-or-nothing transaction and every single-use item (invite, recovery code, challenge) is claimed once.

export const MAX_USERS = 3;
const SESSION_IDLE_MS = 12 * 3_600_000;
const SESSION_MAX_MS = 7 * 86_400_000;
const INVITE_TTL_MS = 24 * 3_600_000;
const CHALLENGE_TTL_MS = 10 * 60_000;
export const COOKIE = "__Host-sid";

export type Role = "owner" | "manager";
export interface User {
  id: string;
  name: string;
  role: Role;
}
export interface Session {
  user: User;
  id: string;
  /** Signed in with a recovery code: may only register a new passkey. */
  mustAddPasskey: boolean;
}

const random = (n = 32) => b64u.encode(crypto.getRandomValues(new Uint8Array(n)));
export const hash = async (s: string) => b64u.encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

export function relyingParty(env: Pick<Env, "PUBLIC_URL">) {
  const u = new URL(env.PUBLIC_URL);
  return { origin: u.origin, rpId: u.hostname };
}

// --- Rate limiting ---

export async function tooManyAttempts(env: Env, key: string, limit: number, windowMs: number): Promise<boolean> {
  return (await env.store.auth.countAttempts(key, Date.now() - windowMs)) >= limit;
}

/** Records a failed attempt; kept 24 hours (by TTL). */
export async function recordFailure(env: Env, key: string) {
  await env.store.auth.recordAttempt(key, Date.now());
}

// --- Challenges ---

async function newChallenge(env: Env, purpose: string, data: object = {}) {
  const id = random(16);
  const challenge = random(32);
  const now = Date.now();
  await env.store.auth.createChallenge({ id, challenge, purpose, data: JSON.stringify(data), expires_at: now + CHALLENGE_TTL_MS }, now);
  return { id, challenge };
}

/** Takes a challenge once: read and deleted together, so a replay or a parallel request gets nothing. */
async function takeChallenge(env: Env, id: string, purpose: string): Promise<{ challenge: string; data: any }> {
  const row = await env.store.auth.takeChallenge(String(id));
  if (!row || row.purpose !== purpose || row.expires_at < Date.now()) throw new Error("This sign-in step expired. Try again.");
  return { challenge: row.challenge, data: JSON.parse(row.data) };
}

// --- Sessions ---

export async function createSession(env: Env, userId: string, request: Request, mustAddPasskey = false) {
  const token = random(32);
  const now = Date.now();
  await env.store.auth.createSession(
    {
      id_hash: await hash(token),
      user_id: userId,
      created_at: now,
      last_seen_at: now,
      expires_at: now + SESSION_MAX_MS,
      user_agent: (request.headers.get("User-Agent") ?? "").slice(0, 200),
      must_add_passkey: mustAddPasskey ? 1 : 0,
      revoked: 0,
    },
    SESSION_IDLE_MS,
  );
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_MS / 1000}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

const tokenFrom = (request: Request) => (request.headers.get("Cookie") ?? "").match(new RegExp(`${COOKIE}=([\\w-]{20,})`))?.[1];

export async function getSession(env: Env, request: Request): Promise<Session | null> {
  const token = tokenFrom(request);
  if (!token) return null;
  const id = await hash(token);
  const found = await env.store.auth.getSessionWithUser(id);
  const now = Date.now();
  if (!found) return null;
  const { session: s, user } = found;
  if (s.revoked || user.disabled || s.expires_at < now || s.last_seen_at + SESSION_IDLE_MS < now) return null;
  if (now - s.last_seen_at > 5 * 60_000) await env.store.auth.touchSession(id, s, now, SESSION_IDLE_MS);
  return { id, user: { id: user.id, name: user.name, role: user.role as Role }, mustAddPasskey: Boolean(s.must_add_passkey) };
}

export async function endSession(env: Env, request: Request) {
  const token = tokenFrom(request);
  if (token) await env.store.auth.revokeSession(await hash(token));
}

export async function signOutEverywhere(env: Env, userId: string) {
  await env.store.auth.revokeAllSessions(userId);
}

// --- Invites ---

export async function userCount(env: Env) {
  return env.store.auth.countActiveUsers();
}

/** A single-use invite link token, shown once. Refuses beyond three people (counting open invites). */
export async function createInvite(env: Env, name: string, role: Role, createdBy: string | null): Promise<string> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("Give the person's name");
  if ((await userCount(env)) + (await env.store.auth.countOpenInvites(Date.now())) >= MAX_USERS) throw new Error(`The app is limited to ${MAX_USERS} people`);
  const token = random(32);
  await env.store.auth.createInvite({
    token_hash: await hash(token),
    name: clean,
    role,
    created_by: createdBy,
    created_at: Date.now(),
    expires_at: Date.now() + INVITE_TTL_MS,
    used_at: null,
    reenrol_user_id: null,
  });
  return token;
}

async function findInvite(env: Env, token: string) {
  const row = await env.store.auth.getInvite(await hash(String(token)));
  if (!row || row.used_at || row.expires_at < Date.now()) throw new Error("This invite link has expired or been used. Ask K for a new one.");
  return row;
}

// --- Passkey registration ---

function creationOptions(env: Env, challenge: string, user: { id: string; name: string }, exclude: string[]) {
  const { rpId } = relyingParty(env);
  return {
    challenge,
    rp: { name: "EBayManager", id: rpId },
    user: { id: b64u.encode(new TextEncoder().encode(user.id)), name: user.name, displayName: user.name },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    attestation: "none",
    timeout: CHALLENGE_TTL_MS,
    excludeCredentials: exclude.map((id) => ({ type: "public-key", id })),
  };
}

/**
 * Options for completing an invite. A re-enrolment invite (written by the Azure migration for someone who
 * already exists: passkeys are bound to the old web address) registers a passkey for that same person.
 */
export async function registrationOptions(env: Env, invite: string) {
  const inv = await findInvite(env, invite);
  if (inv.reenrol_user_id) {
    const existing = await env.store.auth.getUser(inv.reenrol_user_id);
    if (!existing || existing.is_test) throw new Error("This invite link isn't valid any more. Ask K for a new one.");
  } else if ((await userCount(env)) >= MAX_USERS) throw new Error(`The app is limited to ${MAX_USERS} people`);
  const userId = inv.reenrol_user_id ?? random(12);
  const { id, challenge } = await newChallenge(env, "register", { inviteHash: inv.token_hash, userId });
  return { challengeId: id, options: creationOptions(env, challenge, { id: userId, name: inv.name }, []) };
}

const newCodes = () => Array.from({ length: 10 }, () => random(9).replace(/[-_]/g, "x").slice(0, 12));

/** Completes an invite: creates the person (or re-enrols them), their passkey and recovery codes, in one step. */
export async function completeRegistration(env: Env, challengeId: string, credential: any, label: string) {
  const { challenge, data } = await takeChallenge(env, challengeId, "register");
  const inv = await env.store.auth.getInvite(data.inviteHash);
  if (!inv || inv.used_at || inv.expires_at < Date.now()) throw new Error("This invite link has expired or been used.");
  const reenrol = Boolean(inv.reenrol_user_id);
  if (reenrol && inv.reenrol_user_id !== data.userId) throw new Error("This invite link isn't valid.");
  if (!reenrol && (await userCount(env)) >= MAX_USERS) throw new Error(`The app is limited to ${MAX_USERS} people`);
  const cred = await verifyRegistration(credential, { challenge, ...relyingParty(env) });
  const codes = newCodes();
  const ok = await env.store.auth.completeRegistration({
    inviteHash: inv.token_hash,
    now: Date.now(),
    newUser: reenrol ? null : { id: data.userId, name: inv.name, role: inv.role },
    existingUserId: reenrol ? data.userId : null,
    credential: { id: cred.id, user_id: data.userId, alg: cred.alg, public_key: JSON.stringify(cred.jwk), sign_count: cred.signCount, label: (label || "First passkey").slice(0, 60) },
    codeHashes: await Promise.all(codes.map(hash)),
  });
  if (!ok) throw new Error("This invite link has already been used.");
  return { userId: data.userId as string, recoveryCodes: codes };
}

/** A further passkey for a signed-in person (another device, or after a recovery code). */
export async function addPasskeyOptions(env: Env, user: User) {
  const exclude = await env.store.auth.listCredentialIds(user.id);
  const { id, challenge } = await newChallenge(env, "add", { userId: user.id });
  return { challengeId: id, options: creationOptions(env, challenge, user, exclude) };
}

export async function completeAddPasskey(env: Env, user: User, challengeId: string, credential: any, label: string, sessionId: string) {
  const { challenge, data } = await takeChallenge(env, challengeId, "add");
  if (data.userId !== user.id) throw new Error("This passkey step belongs to someone else");
  const cred = await verifyRegistration(credential, { challenge, ...relyingParty(env) });
  const codes = newCodes();
  await env.store.auth.addCredentialWithCodes(
    user.id,
    { id: cred.id, user_id: user.id, alg: cred.alg, public_key: JSON.stringify(cred.jwk), sign_count: cred.signCount, label: (label || "Passkey").slice(0, 60) },
    await Promise.all(codes.map(hash)),
    Date.now(),
  );
  await env.store.auth.clearMustAddPasskey(sessionId);
  return { recoveryCodes: codes };
}

// --- Sign-in ---

export async function loginOptions(env: Env) {
  const { id, challenge } = await newChallenge(env, "login");
  return {
    challengeId: id,
    options: { challenge, rpId: relyingParty(env).rpId, userVerification: "required", allowCredentials: [], timeout: CHALLENGE_TTL_MS },
  };
}

export async function completeLogin(env: Env, challengeId: string, credential: any): Promise<string> {
  const { challenge } = await takeChallenge(env, challengeId, "login");
  const found = await env.store.auth.getCredentialWithUser(String(credential?.id));
  if (!found || found.user.disabled) throw new Error("This passkey isn't registered here");
  const row = found.cred;
  const signCount = await verifyAuthentication(credential, { alg: row.alg, jwk: JSON.parse(row.public_key), signCount: row.sign_count }, { challenge, ...relyingParty(env) });
  await env.store.auth.updateCredentialUse(row.id, signCount, Date.now());
  return row.user_id;
}

/** A recovery code signs its owner in once, for registering a new passkey only. */
export async function useRecoveryCode(env: Env, code: string): Promise<string> {
  const userId = await env.store.auth.consumeRecoveryCode(await hash(String(code).trim()), Date.now());
  if (!userId) throw new Error("That recovery code isn't valid");
  return userId;
}

// --- Managing people (owner only; enforced by the API) ---

export async function listPeople(env: Env) {
  const { people, creds, invites } = await env.store.auth.listPeople(Date.now());
  return { people: people.map((u) => ({ ...u, passkeys: creds.filter((c) => c.user_id === u.id) })), invites, max: MAX_USERS };
}

export async function removePerson(env: Env, owner: User, userId: string) {
  if (userId === owner.id) throw new Error("The owner can't remove themselves");
  await env.store.auth.removePerson(userId);
  await env.store.auth.revokeAllSessions(userId);
}

export async function removePasskey(env: Env, actor: User, credentialId: string) {
  const found = await env.store.auth.getCredentialWithUser(credentialId);
  if (!found) throw new Error("Passkey not found");
  if (found.cred.user_id !== actor.id && actor.role !== "owner") throw new Error("Only the owner can remove someone else's passkey");
  await env.store.auth.deleteCredential(credentialId);
}

// --- Connecting eBay (owner only) ---

/** Records the owner starting the eBay sign-in; returns the state to send to eBay. */
export async function startOAuth(env: Env, userId: string, readonly: boolean): Promise<string> {
  const { id } = await newChallenge(env, "oauth", { userId, readonly });
  return id;
}

/** Accepts the callback's state once, if an owner started it in the last few minutes. */
export async function finishOAuth(env: Env, state: string): Promise<{ readonly: boolean } | null> {
  try {
    const { data } = await takeChallenge(env, state, "oauth");
    return (await env.store.auth.isActiveOwner(data.userId)) ? { readonly: Boolean(data.readonly) } : null;
  } catch {
    return null;
  }
}
