import type { Env } from "../env";
import { b64u } from "../push";
import { verifyAuthentication, verifyRegistration } from "./webauthn";

// People, passkeys, invites, recovery codes and sessions (docs/security.md). At most three people: K as owner
// and two managers. Sessions are random tokens stored hashed; 12 hours idle, 7 days at most.

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
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ? AND at > ?")
    .bind(key, Date.now() - windowMs)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= limit;
}

export async function recordFailure(env: Env, key: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_attempts (key, at) VALUES (?, ?)").bind(key, Date.now()),
    env.DB.prepare("DELETE FROM auth_attempts WHERE at < ?").bind(Date.now() - 86_400_000),
  ]);
}

// --- Challenges ---

async function newChallenge(env: Env, purpose: string, data: object = {}) {
  const id = random(16);
  const challenge = random(32);
  await env.DB.prepare("INSERT INTO auth_challenges (id, challenge, purpose, data, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, challenge, purpose, JSON.stringify(data), Date.now() + CHALLENGE_TTL_MS)
    .run();
  return { id, challenge };
}

async function takeChallenge(env: Env, id: string, purpose: string): Promise<{ challenge: string; data: any }> {
  const row = await env.DB.prepare("SELECT * FROM auth_challenges WHERE id = ? AND purpose = ?").bind(String(id), purpose).first<any>();
  await env.DB.prepare("DELETE FROM auth_challenges WHERE id = ? OR expires_at < ?").bind(String(id), Date.now()).run();
  if (!row || row.expires_at < Date.now()) throw new Error("This sign-in step expired. Try again.");
  return { challenge: row.challenge, data: JSON.parse(row.data) };
}

// --- Sessions ---

export async function createSession(env: Env, userId: string, request: Request, mustAddPasskey = false) {
  const token = random(32);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent, must_add_passkey) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(await hash(token), userId, now, now, now + SESSION_MAX_MS, (request.headers.get("User-Agent") ?? "").slice(0, 200), mustAddPasskey ? 1 : 0)
    .run();
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_MS / 1000}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

const tokenFrom = (request: Request) => (request.headers.get("Cookie") ?? "").match(new RegExp(`${COOKIE}=([\\w-]{20,})`))?.[1];

export async function getSession(env: Env, request: Request): Promise<Session | null> {
  const token = tokenFrom(request);
  if (!token) return null;
  const id = await hash(token);
  const row = await env.DB.prepare(
    `SELECT s.*, u.name, u.role, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
  )
    .bind(id)
    .first<any>();
  const now = Date.now();
  if (!row || row.revoked || row.disabled || row.expires_at < now || row.last_seen_at + SESSION_IDLE_MS < now) return null;
  if (now - row.last_seen_at > 5 * 60_000) await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, id).run();
  return { id, user: { id: row.user_id, name: row.name, role: row.role }, mustAddPasskey: Boolean(row.must_add_passkey) };
}

export async function endSession(env: Env, request: Request) {
  const token = tokenFrom(request);
  if (token) await env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE id_hash = ?").bind(await hash(token)).run();
}

export async function signOutEverywhere(env: Env, userId: string) {
  await env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").bind(userId).run();
}

// --- Invites ---

export async function userCount(env: Env) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 0 AND is_test = 0").first<{ n: number }>())?.n ?? 0;
}

async function openInvites(env: Env) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?").bind(Date.now()).first<{ n: number }>())?.n ?? 0;
}

/** A single-use invite link token, shown once. Refuses beyond three people (counting open invites). */
export async function createInvite(env: Env, name: string, role: Role, createdBy: string | null): Promise<string> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("Give the person's name");
  if ((await userCount(env)) + (await openInvites(env)) >= MAX_USERS) throw new Error(`The app is limited to ${MAX_USERS} people`);
  const token = random(32);
  await env.DB.prepare("INSERT INTO invites (token_hash, name, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await hash(token), clean, role, createdBy, Date.now(), Date.now() + INVITE_TTL_MS)
    .run();
  return token;
}

async function findInvite(env: Env, token: string) {
  const row = await env.DB.prepare("SELECT * FROM invites WHERE token_hash = ?").bind(await hash(String(token))).first<any>();
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

export async function registrationOptions(env: Env, invite: string) {
  const inv = await findInvite(env, invite);
  if ((await userCount(env)) >= MAX_USERS) throw new Error(`The app is limited to ${MAX_USERS} people`);
  const userId = random(12);
  const { id, challenge } = await newChallenge(env, "register", { inviteHash: inv.token_hash, userId });
  return { challengeId: id, options: creationOptions(env, challenge, { id: userId, name: inv.name }, []) };
}

async function storeCredential(env: Env, userId: string, cred: { id: string; alg: number; jwk: JsonWebKey; signCount: number }, label: string) {
  await env.DB.prepare("INSERT INTO credentials (id, user_id, alg, public_key, sign_count, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(cred.id, userId, cred.alg, JSON.stringify(cred.jwk), cred.signCount, label.slice(0, 60), Date.now())
    .run();
}

async function newRecoveryCodes(env: Env, userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () => random(9).replace(/[-_]/g, "x").slice(0, 12));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
    ...(await Promise.all(codes.map(async (c) => env.DB.prepare("INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)").bind(await hash(c), userId)))),
  ]);
  return codes;
}

/** Completes an invite: creates the person, their passkey and recovery codes. */
export async function completeRegistration(env: Env, challengeId: string, credential: any, label: string) {
  const { challenge, data } = await takeChallenge(env, challengeId, "register");
  const inv = await env.DB.prepare("SELECT * FROM invites WHERE token_hash = ?").bind(data.inviteHash).first<any>();
  if (!inv || inv.used_at || inv.expires_at < Date.now()) throw new Error("This invite link has expired or been used.");
  if ((await userCount(env)) >= MAX_USERS) throw new Error(`The app is limited to ${MAX_USERS} people`);
  const cred = await verifyRegistration(credential, { challenge, ...relyingParty(env) });
  const used = await env.DB.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(Date.now(), inv.token_hash).run();
  if (!used.meta.changes) throw new Error("This invite link has already been used.");
  await env.DB.prepare("INSERT INTO users (id, name, role, created_at, disabled) VALUES (?, ?, ?, ?, 0)").bind(data.userId, inv.name, inv.role, Date.now()).run();
  await storeCredential(env, data.userId, cred, label || "First passkey");
  return { userId: data.userId as string, recoveryCodes: await newRecoveryCodes(env, data.userId) };
}

/** A further passkey for a signed-in person (another device, or after a recovery code). */
export async function addPasskeyOptions(env: Env, user: User) {
  const { results } = await env.DB.prepare("SELECT id FROM credentials WHERE user_id = ?").bind(user.id).all<{ id: string }>();
  const { id, challenge } = await newChallenge(env, "add", { userId: user.id });
  return { challengeId: id, options: creationOptions(env, challenge, user, results.map((r) => r.id)) };
}

export async function completeAddPasskey(env: Env, user: User, challengeId: string, credential: any, label: string, sessionId: string) {
  const { challenge, data } = await takeChallenge(env, challengeId, "add");
  if (data.userId !== user.id) throw new Error("This passkey step belongs to someone else");
  const cred = await verifyRegistration(credential, { challenge, ...relyingParty(env) });
  await storeCredential(env, user.id, cred, label || "Passkey");
  await env.DB.prepare("UPDATE sessions SET must_add_passkey = 0 WHERE id_hash = ?").bind(sessionId).run();
  return { recoveryCodes: await newRecoveryCodes(env, user.id) };
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
  const row = await env.DB.prepare(
    "SELECT c.*, u.disabled FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.id = ?",
  )
    .bind(String(credential?.id))
    .first<any>();
  if (!row || row.disabled) throw new Error("This passkey isn't registered here");
  const signCount = await verifyAuthentication(credential, { alg: row.alg, jwk: JSON.parse(row.public_key), signCount: row.sign_count }, { challenge, ...relyingParty(env) });
  await env.DB.prepare("UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE id = ?").bind(signCount, Date.now(), row.id).run();
  return row.user_id;
}

/** A recovery code signs its owner in once, for registering a new passkey only. */
export async function useRecoveryCode(env: Env, code: string): Promise<string> {
  const h = await hash(String(code).trim());
  const row = await env.DB.prepare(
    "SELECT r.user_id, u.disabled FROM recovery_codes r JOIN users u ON u.id = r.user_id WHERE r.code_hash = ? AND r.used_at IS NULL",
  )
    .bind(h)
    .first<any>();
  if (!row || row.disabled) throw new Error("That recovery code isn't valid");
  await env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE code_hash = ?").bind(Date.now(), h).run();
  return row.user_id;
}

// --- Managing people (owner only; enforced by the API) ---

export async function listPeople(env: Env) {
  const { results: users } = await env.DB.prepare("SELECT id, name, role, created_at FROM users WHERE disabled = 0 AND is_test = 0 ORDER BY created_at").all<any>();
  const { results: creds } = await env.DB.prepare("SELECT id, user_id, label, created_at, last_used_at FROM credentials ORDER BY created_at").all<any>();
  const { results: invites } = await env.DB.prepare(
    "SELECT name, role, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at",
  )
    .bind(Date.now())
    .all<any>();
  return { people: users.map((u) => ({ ...u, passkeys: creds.filter((c) => c.user_id === u.id) })), invites, max: MAX_USERS };
}

export async function removePerson(env: Env, owner: User, userId: string) {
  if (userId === owner.id) throw new Error("The owner can't remove themselves");
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET disabled = 1 WHERE id = ?").bind(userId),
    env.DB.prepare("DELETE FROM credentials WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").bind(userId),
  ]);
}

export async function removePasskey(env: Env, actor: User, credentialId: string) {
  const row = await env.DB.prepare("SELECT user_id FROM credentials WHERE id = ?").bind(credentialId).first<{ user_id: string }>();
  if (!row) throw new Error("Passkey not found");
  if (row.user_id !== actor.id && actor.role !== "owner") throw new Error("Only the owner can remove someone else's passkey");
  await env.DB.prepare("DELETE FROM credentials WHERE id = ?").bind(credentialId).run();
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
    const owner = await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'owner' AND disabled = 0").bind(data.userId).first();
    return owner ? { readonly: Boolean(data.readonly) } : null;
  } catch {
    return null;
  }
}
