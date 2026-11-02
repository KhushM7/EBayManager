import type { Env } from "./env";
import { b64u } from "./push";

// K's dashboard session: a signed, expiring cookie set after K enters DASHBOARD_KEY.
// State-changing API calls also need a custom header, which a cross-site form or link can't send.

const COOKIE = "__Host-sid";
const SESSION_DAYS = 30;
export const CSRF_HEADER = "X-EbayManager";

async function sign(env: Env, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return b64u.encode(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`session:${msg}`)));
}

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sessionCookie(env: Env, now = Date.now()) {
  const exp = now + SESSION_DAYS * 86_400_000;
  return `${COOKIE}=${exp}.${await sign(env, String(exp))}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86_400}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

export async function hasSession(env: Env, request: Request): Promise<boolean> {
  const m = (request.headers.get("Cookie") ?? "").match(new RegExp(`${COOKIE}=(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[1]) < Date.now()) return false;
  return timingSafeEqual(m[2], await sign(env, m[1]));
}

export const checkKey = (env: Env, key: unknown) => typeof key === "string" && !!env.DASHBOARD_KEY && timingSafeEqual(key, env.DASHBOARD_KEY);
