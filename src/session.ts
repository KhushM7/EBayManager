import type { Env } from "./env";
import { createSession, getSession, hash, type Session } from "./auth/users";
import { TEST_USER_PREFIX } from "./auth/people";

// State-changing API calls also need this header, which a cross-site form or link can't send.
export const CSRF_HEADER = "X-EbayManager";

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const checkKey = (env: Env, key: unknown) => typeof key === "string" && !!env.DASHBOARD_KEY && timingSafeEqual(key, env.DASHBOARD_KEY);

export { getSession, type Session };

export const keyLoginAllowed = (env: Env) => env.ALLOW_KEY_LOGIN === "true" && env.EBAY_ENV !== "production";

/**
 * Sandbox only (ALLOW_KEY_LOGIN=true): DASHBOARD_KEY signs in as a test owner, so scripts and checks can run
 * without an authenticator. Never enabled in production.
 */
export async function keyLogin(env: Env, request: Request, key: unknown): Promise<string | null> {
  if (!keyLoginAllowed(env) || !checkKey(env, key)) return null;
  const id = `${TEST_USER_PREFIX}${(await hash(env.DASHBOARD_KEY)).slice(0, 8)}`;
  return createSession(env, id, request);
}
