import type { Env } from "./env";
import { push } from "./notify";
import type { TodoInput } from "./store/todos";

// Whether each outside service the app depends on is working: eBay (K's account sign-in, and eBay itself),
// Claude, the two sold-data providers and Parcel2Go. Every call records how it went at its one choke point
// (the token refresh, the Messages API call, each provider's fetch). checkServices, run with the 15-minute poll
// and the nightly run, turns a broken service into an Inbox to-do with a notification, and resolves it once
// the service works again.
//
// "auth" failures (a rejected key or sign-in, no credit) never fix themselves, so they alert on the next check.
// Other failures (timeouts, 5xx, overloaded) alert only when they persist: 3 or more in a row over 10 minutes.

export type Service = "ebay_account" | "ebay" | "claude" | "trawl" | "compsapi" | "parcel2go";
export const SERVICES: Service[] = ["ebay_account", "ebay", "claude", "trawl", "compsapi", "parcel2go"];

export type FailureKind = "auth" | "error";

export interface ServiceState {
  failures: number;
  kind: FailureKind | null;
  firstFailAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
  lastOkAt: number | null;
}

/** A non-auth failure alerts once this many happen in a row... */
export const PERSIST_FAILURES = 3;
/** ...over at least this long. */
export const PERSIST_MS = 10 * 60_000;

const key = (s: Service) => `service:${s}`;
const EMPTY: ServiceState = { failures: 0, kind: null, firstFailAt: null, lastFailAt: null, lastError: null, lastOkAt: null };

// The last state this instance knows per store and service, so a success costs a write only after a failure.
const known = new WeakMap<object, Map<Service, ServiceState>>();
const cache = (env: Env) => {
  let m = known.get(env.store);
  if (!m) known.set(env.store, (m = new Map()));
  return m;
};

export async function serviceState(env: Env, s: Service): Promise<ServiceState> {
  const st = (await env.store.kv.getJson<ServiceState>(key(s)).catch(() => null)) ?? EMPTY;
  cache(env).set(s, st);
  return st;
}

/** The service answered. Writes only when it was failing (or this instance hasn't looked yet). */
export async function recordOk(env: Env, s: Service, now = Date.now()) {
  try {
    const cur = cache(env).get(s) ?? (await serviceState(env, s));
    if (cur.failures === 0) return;
    const next: ServiceState = { ...EMPTY, lastOkAt: now };
    cache(env).set(s, next);
    await env.store.kv.setJson(key(s), next);
  } catch {
    // Recording health must never break the call it's recording.
  }
}

/** The service failed. Secrets never reach the message: only the status and eBay's or the provider's words. */
export async function recordFailure(env: Env, s: Service, kind: FailureKind, error: unknown, now = Date.now()) {
  try {
    const cur = await serviceState(env, s);
    const msg = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
    const next: ServiceState = {
      failures: cur.failures + 1,
      // Once a run of failures includes an auth failure, it stays one until a success.
      kind: cur.kind === "auth" ? "auth" : kind,
      firstFailAt: cur.firstFailAt ?? now,
      lastFailAt: now,
      lastError: msg,
      lastOkAt: cur.lastOkAt,
    };
    cache(env).set(s, next);
    await env.store.kv.setJson(key(s), next);
  } catch {
    // As above.
  }
}

/** Whether a state is bad enough to tell K. */
export function isDown(st: ServiceState): boolean {
  if (st.failures === 0) return false;
  if (st.kind === "auth") return true;
  return st.failures >= PERSIST_FAILURES && (st.lastFailAt ?? 0) - (st.firstFailAt ?? 0) >= PERSIST_MS;
}

/** How an HTTP reply counts: a rejected key is auth, a server failure or overload is an error, anything else is the service working. */
export function classifyStatus(status: number): FailureKind | null {
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 || status === 429) return "error";
  return null;
}

/**
 * A call to a service, recorded. The fetch stays in the calling module (test/safety.test.ts reviews where
 * network calls happen). Network failures and timeouts count as errors and are re-thrown; replies are
 * classified by status and returned for the caller to handle as before. ignore429: the provider uses 429 for
 * "monthly allowance used up" (a 429 with no Retry-After), which the allowance check already reports.
 */
export async function watched(env: Env, s: Service, call: () => Promise<Response>, opts: { ignore429?: boolean } = {}): Promise<Response> {
  let res: Response;
  try {
    res = await call();
  } catch (e) {
    await recordFailure(env, s, "error", e);
    throw e;
  }
  const kind = res.status === 429 && opts.ignore429 && !res.headers.get("Retry-After") ? null : classifyStatus(res.status);
  if (kind) await recordFailure(env, s, kind, new Error(`HTTP ${res.status}`));
  else await recordOk(env, s);
  return res;
}

/** An Anthropic SDK error, classified: a rejected key or an empty credit balance can't fix itself. */
export function classifyClaudeError(e: unknown): FailureKind {
  const status = (e as { status?: number })?.status;
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 401 || status === 403) return "auth";
  if (status === 400 && /credit balance|billing|purchase credits/i.test(msg)) return "auth";
  return "error";
}

const NAMES: Record<Service, string> = {
  ebay_account: "eBay sign-in",
  ebay: "eBay",
  claude: "Claude",
  trawl: "Trawl",
  compsapi: "CompsAPI",
  parcel2go: "Parcel2Go",
};

const time = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** The to-do for a service that's down: what broke, what stops, and what K can do. */
export function serviceTodo(s: Service, st: ServiceState): TodoInput {
  const auth = st.kind === "auth";
  const since = `Failing since ${time(st.firstFailAt ?? Date.now())}${st.failures > 1 ? ` (${st.failures} tries)` : ""}. Last error: ${st.lastError ?? "unknown"}`;
  const t = (title: string, what: string): TodoInput => ({
    code: CODE,
    kind: "you",
    itemId: null,
    itemTitle: null,
    subject: s,
    title,
    detail: `${what}\n${since}`,
    // The same outage until it changes from temporary to a rejected key, or the other way.
    fingerprint: `${st.kind}|${st.firstFailAt}`,
  });
  switch (s) {
    case "ebay_account":
      return t(
        "Reconnect eBay",
        "eBay has stopped accepting the app's sign-in to your account. This happens when you change your eBay username or password. Until you reconnect, the app can't read listings, orders or buyer messages, or send approved changes. Open Settings → eBay connection and press Reconnect eBay.",
      );
    case "ebay":
      return t(
        auth ? "eBay is refusing the app's requests" : "eBay isn't answering",
        auth
          ? "eBay refused the app's requests (permission denied). If it keeps happening, reconnect in Settings → eBay connection."
          : "Calls to eBay keep failing. This is usually eBay's side and the app retries by itself; nothing is lost. If it lasts a day, check eBay's developer status page.",
      );
    case "claude":
      return t(
        auth ? "Claude has stopped working: key or credit" : "Claude isn't answering",
        auth
          ? "Anthropic refused the app's requests: the API key was rejected or the credit has run out. Listing checks, reviews, price research and reply drafts are stopped. Top up or check the key in the Claude Console, then enter the new balance in Settings → Usage and APIs."
          : "Calls to Claude keep failing (Anthropic overloaded or unreachable). Listing checks, reviews and reply drafts wait until it answers; the app retries by itself.",
      );
    case "trawl":
    case "compsapi":
      return t(
        `${NAMES[s]} (sold prices) ${auth ? "rejected the app's key" : "isn't answering"}`,
        auth
          ? `${NAMES[s]} refused the app's API key. Prices use the other provider and cached results until the key is fixed (a new key goes in with scripts/azure-secrets.mjs).`
          : `Searches on ${NAMES[s]} keep failing. Prices use the other provider and cached results meanwhile.`,
      );
    case "parcel2go":
      return t(
        `Parcel2Go ${auth ? "rejected the app's sign-in" : "isn't answering"}`,
        auth
          ? "Parcel2Go refused the app's credentials, so postage can't be quoted for new listings. Type the postage yourself for now."
          : "Postage quotes keep failing. Type the postage yourself for new listings meanwhile.",
      );
  }
}

const CODE = "service_down";

export interface ServiceStatus {
  id: Service;
  name: string;
  level: "ok" | "failing" | "down";
  summary: string;
}

/** Each service's state in plain words, for Settings. */
export async function serviceStatuses(env: Env): Promise<ServiceStatus[]> {
  return Promise.all(
    SERVICES.map(async (s) => {
      const st = await serviceState(env, s);
      const level = isDown(st) ? "down" : st.failures ? "failing" : "ok";
      const summary =
        level === "ok"
          ? st.lastOkAt
            ? `Working again since ${time(st.lastOkAt)}`
            : "Working"
          : `${level === "down" ? "Not working" : "Had an error, retrying"} since ${time(st.firstFailAt!)}: ${st.lastError ?? ""}`;
      return { id: s, name: NAMES[s], level, summary };
    }),
  );
}

/** Whether K needs to sign in to eBay again (Settings shows Reconnect eBay). */
export async function ebayNeedsReconnect(env: Env): Promise<boolean> {
  return isDown(await serviceState(env, "ebay_account"));
}

/**
 * Files an Inbox to-do for each service that's down, resolves those that work again, and sends a notification
 * for each newly opened one. Store reads only: run with the 15-minute poll and nightly.
 */
export async function checkServices(env: Env, now = Date.now()): Promise<string> {
  const todos: TodoInput[] = [];
  for (const s of SERVICES) {
    const st = await serviceState(env, s);
    if (isDown(st)) todos.push(serviceTodo(s, st));
  }
  const before = new Set((await env.store.todos.list("open")).filter((t) => t.code === CODE).map((t) => t.id));
  const r = await env.store.todos.sync("services", { codes: [CODE] }, todos, now);
  if (r.opened) {
    const fresh = (await env.store.todos.list("open")).filter((t) => t.code === CODE && !before.has(t.id));
    for (const t of fresh) await push(env, t.title, t.detail.split("\n")[0], undefined, `service-${t.id}`).catch(() => null);
  }
  return `${todos.length} down${r.opened ? `, ${r.opened} new` : ""}${r.resolved ? `, ${r.resolved} back` : ""}`;
}
