import type { Env } from "./env";
import { consentUrl, exchangeCode, READONLY_SCOPES, userScopes } from "./ebay/auth";
import { handleAccountDeletion } from "./deletion";
import { handleApi } from "./api";
import { finishOAuth, isKnownDevice, startOAuth } from "./auth/users";
import { getSession, keyLoginAllowed, timingSafeEqual } from "./session";
import { handleSignIn, signinPath } from "./signin";
import { handleMcp } from "./mcp";
import { envPrefix } from "./notify";
import { pollInbox } from "./inbox";
import { runNightly } from "./nightly";
import { decide, getProposal, verifyDecision } from "./proposals";

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;max-width:560px;margin:24px auto;padding:0 16px}button{font-size:18px;padding:12px 20px;margin-right:8px}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px}</style>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

// The dashboard loads only its own code and fonts, and can't be framed.
const APP_CSP = [
  "default-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  // blob: is for photos the page itself holds in memory (new-photo previews); only the page's own code can make one.
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

// The server's own small pages (approval links, eBay sign-in result) run no script and only inline styles.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// JSON and everything else: nothing may load from it.
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Security headers on every response (docs/security.md): CSP, no framing, no sniffing, no referrer, HTTPS
 * only. The dashboard's files get the app policy; server pages and data get stricter ones.
 */
export function withSecurityHeaders(res: Response, kind: "app" | "page" | "data"): Response {
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", kind === "app" ? APP_CSP : kind === "page" ? PAGE_CSP : DATA_CSP);
  out.headers.set("X-Content-Type-Options", "nosniff");
  // The sign-in page asks for same-origin, so its form's POST carries the Origin (src/signin.ts).
  if (out.headers.get("Referrer-Policy") !== "same-origin") out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return out;
}

const escHtml =(s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Every request, on any platform: routes it and adds the security headers. */
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const res = await route(request, env, url);
  const isApp = !/^\/(api|mcp|oauth|decide|ebay|health|s)(\/|$)/.test(url.pathname);
  const isPage = (res.headers.get("Content-Type") ?? "").startsWith("text/html");
  return withSecurityHeaders(res, isApp ? "app" : isPage ? "page" : "data");
}

/** The scheduled jobs: the 02:00 UTC nightly run, and the buyer-message poll every 15 minutes. */
export function runScheduled(kind: "nightly" | "poll", env: Env) {
  return kind === "nightly" ? runNightly(env) : pollInbox(env);
}

export default { fetch: handle };

/**
 * The site is hidden (docs/security.md): anyone who isn't signed in gets a blank "Not found" everywhere,
 * except the hidden sign-in page, eBay's account-deletion endpoint and the privacy policy eBay links to. A
 * browser where someone signed in before is sent to the sign-in page instead, so the installed app still works
 * when its session ends.
 */
const blank = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
const PUBLIC_FILES = new Set(["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/badge-96.png", "/sw.js"]);

const route = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const path = url.pathname;
  const signin = signinPath(env);

  // Public by necessity: eBay calls the first, and its developer settings link to the second.
  if (path === "/ebay/account-deletion") return handleAccountDeletion(env, request, url);
  if (path === "/privacy.html" && env.ASSETS) return env.ASSETS.serve(request);
  // Fetched by the browser without cookies, so they can't need a session: the app icons (for installing and
  // notifications) and the service worker script. No data and no app name in them. The manifest stays
  // private; the page asks for it with the session cookie (crossorigin="use-credentials").
  if (PUBLIC_FILES.has(path) && env.ASSETS) return env.ASSETS.serve(request);
  if (signin && path === signin) return handleSignIn(env, request, url);
  // The Claude connector, with its own token: Sandbox only unless switched on deliberately.
  if (path === "/mcp") return env.MCP_ENABLED === "true" ? handleMcp(env, request) : blank();

  // Approval links: the signature is checked first, so a made-up link sees nothing. GET shows the proposal;
  // only the POST from a tap decides (link previews can't approve).
  const m = path.match(/^\/decide\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    const d = url.searchParams.get("d") as "approve" | "reject";
    const e = Number(url.searchParams.get("e"));
    const s = url.searchParams.get("s") ?? "";
    if ((d !== "approve" && d !== "reject") || !(await verifyDecision(env, id, d, e, s))) return blank();
    // On the real account a link alone isn't enough: the device must also be signed in.
    const session = await getSession(env, request);
    if (env.EBAY_ENV === "production" && !session) {
      if (request.headers.get("Accept")?.includes("application/json")) return Response.json({ result: "Sign in to the app to decide" }, { status: 401 });
      return html("<h1>Sign in to EBayManager on this device, then open the link again.</h1>", 401);
    }
    if (request.method === "POST") {
      const result = await decide(env, id, d, session?.user.name ?? "notification link");
      // The PWA's service worker asks for JSON when K taps Approve or Reject on a notification.
      if (request.headers.get("Accept")?.includes("application/json")) return Response.json({ result });
      return html(`<h1>${escHtml(result)}</h1>`);
    }
    const p = await getProposal(env, id);
    if (!p) return blank();
    return html(`<p><strong>${escHtml(envPrefix(env) || "LIVE ACCOUNT")}</strong></p>
<h1>${d === "approve" ? "Approve" : "Reject"} this ${p.kind} change?</h1>
<p>Item ${escHtml(p.item_id ?? "")} · status ${p.status}</p><p>${escHtml(p.reason ?? "")}</p>
<pre>${escHtml(JSON.stringify(JSON.parse(p.payload), null, 2))}</pre>
<form method="post"><button>${d === "approve" ? "Approve" : "Reject"}</button></form>`);
  }

  // eBay's redirect back after connecting. The session isn't relied on here: the state cookie set by
  // /oauth/start is checked, and the state must be one the owner started in the last 10 minutes.
  if (path === "/oauth/callback") {
    const cookie = request.headers.get("Cookie") ?? "";
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!code || !state || !cookie.includes(`oauth_state=${state}`)) return blank();
    const started = await finishOAuth(env, state);
    if (!started) return html("<h1>This eBay sign-in expired or wasn't started by the owner. Start again from Settings.</h1>", 400);
    const scopes = userScopes(env, started.readonly);
    await exchangeCode(env, code, scopes);
    const kind = scopes === READONLY_SCOPES ? "read-only" : "full";
    return html(`<h1>eBay ${escHtml(env.EBAY_ENV)} connected</h1><p>Scopes: ${kind}. You can close this tab.</p>`);
  }

  const session = await getSession(env, request);

  // For K's checks (scripts/check-production.mjs): a signed-in person, or the DASHBOARD_KEY in a header.
  if (path === "/health") {
    const key = request.headers.get("X-Health-Key") ?? "";
    if (!session && !(env.DASHBOARD_KEY && timingSafeEqual(key, env.DASHBOARD_KEY))) return blank();
    return Response.json({ ok: true, ebayEnv: env.EBAY_ENV, writeMode: env.WRITE_MODE }, { headers: { "Cache-Control": "no-store" } });
  }

  if (path.startsWith("/api/")) {
    if (session) return handleApi(env, request, url, session);
    // Without a session the API answers only the Sandbox test key, and a known device (whose app then goes
    // to the sign-in page). Anyone else sees nothing.
    if ((path === "/api/login" && keyLoginAllowed(env)) || (await isKnownDevice(env, request))) return handleApi(env, request, url, null);
    return blank();
  }

  // Connecting eBay needs the owner's signed-in session. Scopes are read-only unless WRITE_MODE=approval;
  // ?readonly=1 forces read-only.
  if (path === "/oauth/start") {
    if (session?.user.role !== "owner") return blank();
    const readonly = url.searchParams.get("readonly") === "1";
    // The owner's start is recorded server-side; the callback accepts only that state, once, within 10 minutes.
    const state = await startOAuth(env, session.user.id, readonly);
    return new Response(null, {
      status: 302,
      headers: {
        Location: consentUrl(env, state, userScopes(env, readonly)),
        "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=600`,
      },
    });
  }

  // Everything else is the dashboard and PWA (single-page app), for signed-in people only.
  if (session) return env.ASSETS ? env.ASSETS.serve(request) : blank();
  if (signin && request.method === "GET" && !path.startsWith("/assets/") && (await isKnownDevice(env, request)))
    return new Response(null, { status: 302, headers: { Location: signin, "Cache-Control": "no-store" } });
  return blank();
};
