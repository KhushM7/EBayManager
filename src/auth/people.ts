import type { Env } from "../env";
import { b64u } from "../push";
import { base32Decode } from "./totp";

// The people who may sign in (docs/security.md): K as owner and up to two managers. They are set only by K,
// with scripts/people.mjs, which writes the PEOPLE secret to Key Vault. The app never adds, changes or removes
// anyone, and has no way to. A missing or malformed list lets nobody in (fail closed).
//
// PEOPLE is JSON: [{ "email": "...", "name": "K", "role": "owner", "totp": "<base32 secret>" }, ...]

export const MAX_PEOPLE = 3;

export type Role = "owner" | "manager";
export interface User {
  id: string;
  name: string;
  role: Role;
}
export interface Person extends User {
  email: string;
  totp: string;
}

export const normaliseEmail = (s: unknown) => String(s ?? "").trim().toLowerCase().slice(0, 200);

/** A person's id: stable for their email, so sessions and records survive a new authenticator. */
export async function personId(email: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`person:${normaliseEmail(email)}`));
  return `u-${b64u.encode(new Uint8Array(digest)).slice(0, 16)}`;
}

/** Parses and checks the list. Throws on anything off, so a typo can't half-work. */
export async function parsePeople(raw: string | undefined): Promise<Person[]> {
  if (!raw) throw new Error("PEOPLE is not set");
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PEOPLE) throw new Error(`PEOPLE must list 1 to ${MAX_PEOPLE} people`);
  const out: Person[] = [];
  for (const p of list) {
    const email = normaliseEmail(p?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("PEOPLE has an invalid email");
    if (p.role !== "owner" && p.role !== "manager") throw new Error("PEOPLE has an invalid role");
    const name = String(p.name ?? "").trim().slice(0, 60);
    if (!name) throw new Error("PEOPLE has someone without a name");
    const totp = String(p.totp ?? "");
    if (base32Decode(totp).length < 20) throw new Error("PEOPLE has an authenticator secret under 160 bits");
    if (out.some((o) => o.email === email)) throw new Error("PEOPLE lists an email twice");
    out.push({ id: await personId(email), email, name, role: p.role, totp });
  }
  if (out.filter((p) => p.role === "owner").length !== 1) throw new Error("PEOPLE must have exactly one owner");
  return out;
}

let cache: { raw: string | undefined; people: Person[] } | null = null;

/** The people who may sign in. Empty (nobody) when the list is missing or malformed. */
export async function people(env: Pick<Env, "PEOPLE">): Promise<Person[]> {
  if (cache && cache.raw === env.PEOPLE) return cache.people;
  let list: Person[] = [];
  try {
    list = await parsePeople(env.PEOPLE);
  } catch (e) {
    if (env.PEOPLE) console.error(`PEOPLE is not valid, so nobody can sign in: ${e instanceof Error ? e.message : e}`);
  }
  cache = { raw: env.PEOPLE, people: list };
  return list;
}

const asUser = (p: Person): User => ({ id: p.id, name: p.name, role: p.role });

/** Sandbox only (ALLOW_KEY_LOGIN): the test owner that DASHBOARD_KEY signs in as. */
export const TEST_USER_PREFIX = "test-";
const keyLoginAllowed = (env: Pick<Env, "ALLOW_KEY_LOGIN" | "EBAY_ENV">) => env.ALLOW_KEY_LOGIN === "true" && env.EBAY_ENV !== "production";

/** The person with this id, if they are still on the list (removing someone from PEOPLE ends their access). */
export async function findUser(env: Pick<Env, "PEOPLE" | "ALLOW_KEY_LOGIN" | "EBAY_ENV">, id: string): Promise<User | null> {
  const p = (await people(env)).find((x) => x.id === id);
  if (p) return asUser(p);
  if (id.startsWith(TEST_USER_PREFIX) && keyLoginAllowed(env)) return { id, name: "Sandbox test key", role: "owner" };
  return null;
}

export async function findByEmail(env: Pick<Env, "PEOPLE">, email: string): Promise<Person | null> {
  const e = normaliseEmail(email);
  return (await people(env)).find((p) => p.email === e) ?? null;
}

/** The people as the owner sees them in Settings: never their authenticator secrets. */
export async function listPeople(env: Pick<Env, "PEOPLE">) {
  return (await people(env)).map((p) => ({ id: p.id, name: p.name, role: p.role, email: p.email }));
}
