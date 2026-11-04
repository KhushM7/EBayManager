import type { Env } from "./env";
import { consentUrl, exchangeCode, READONLY_SCOPES, userScopes } from "./ebay/auth";
import { handleAccountDeletion } from "./deletion";
import { handleApi } from "./api";
import { finishOAuth, startOAuth } from "./auth/users";
import { getSession } from "./session";
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
  "img-src 'self' data:",
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
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return out;
}

const escHtml =(s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Every request, on any platform: routes it and adds the security headers. */
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const res = await route(request, env, url);
  const isApp = !/^\/(api|mcp|oauth|decide|ebay|health)(\/|$)/.test(url.pathname);
  const isPage = (res.headers.get("Content-Type") ?? "").startsWith("text/html");
  return withSecurityHeaders(res, isApp ? "app" : isPage ? "page" : "data");
}

/** The scheduled jobs: the 02:00 UTC nightly run, and the buyer-message poll every 15 minutes. */
export function runScheduled(kind: "nightly" | "poll", env: Env) {
  return kind === "nightly" ? runNightly(env) : pollInbox(env);
}

export default { fetch: handle };

const route = async (request: Request, env: Env, url: URL): Promise<Response> => {
  {

    // The Claude connector: Sandbox only unless switched on deliberately (docs/security.md).
    if (url.pathname === "/mcp") return env.MCP_ENABLED === "true" ? handleMcp(env, request) : new Response("Not found", { status: 404 });
    if (url.pathname === "/ebay/account-deletion") return handleAccountDeletion(env, request, url);
    if (url.pathname.startsWith("/api/")) return handleApi(env, request, url);

    // Connecting eBay needs the owner's signed-in session. Scopes are read-only unless WRITE_MODE=approval;
    // ?readonly=1 forces read-only.
    if (url.pathname === "/oauth/start") {
      const session = await getSession(env, request);
      if (!session || session.user.role !== "owner" || session.mustAddPasskey)
        return html("<h1>Sign in to EBayManager as the owner first, then open this link again.</h1>", 401);
      const readonly = url.searchParams.get("readonly") === "1";
      // The owner's start is recorded server-side; the callback accepts only that state, once, within 10 minutes.
      // (The session cookie is SameSite=Strict, so it isn't sent on eBay's redirect back.)
      const state = await startOAuth(env, session.user.id, readonly);
      return new Response(null, {
        status: 302,
        headers: {
          Location: consentUrl(env, state, userScopes(env, readonly)),
          "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=600`,
        },
      });
    }
    if (url.pathname === "/oauth/callback") {
      const cookie = request.headers.get("Cookie") ?? "";
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!code || !state || !cookie.includes(`oauth_state=${state}`)) return html("<h1>Sign-in check failed</h1>", 400);
      const started = await finishOAuth(env, state);
      if (!started) return html("<h1>This eBay sign-in expired or wasn't started by the owner. Start again from Settings.</h1>", 400);
      const scopes = userScopes(env, started.readonly);
      await exchangeCode(env, code, scopes);
      const kind = scopes === READONLY_SCOPES ? "read-only" : "full";
      return html(`<h1>eBay ${escHtml(env.EBAY_ENV)} connected</h1><p>Scopes: ${kind}. You can close this tab.</p>`);
    }

    // Approval links: GET shows the proposal, only the POST from K's tap decides (link previews can't approve).
    const m = url.pathname.match(/^\/decide\/([\w-]+)$/);
    if (m) {
      const id = m[1];
      const d = url.searchParams.get("d") as "approve" | "reject";
      const e = Number(url.searchParams.get("e"));
      const s = url.searchParams.get("s") ?? "";
      if ((d !== "approve" && d !== "reject") || !(await verifyDecision(env, id, d, e, s)))
        return html("<h1>Invalid or expired link</h1>", 403);
      // On the real account a link alone isn't enough: the device must also be signed in.
      const session = await getSession(env, request);
      if (env.EBAY_ENV === "production" && (!session || session.mustAddPasskey)) {
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
      if (!p) return html("<h1>Not found</h1>", 404);
      return html(`<p><strong>${escHtml(envPrefix(env) || "LIVE ACCOUNT")}</strong></p>
<h1>${d === "approve" ? "Approve" : "Reject"} this ${p.kind} change?</h1>
<p>Item ${escHtml(p.item_id ?? "")} · status ${p.status}</p><p>${escHtml(p.reason ?? "")}</p>
<pre>${escHtml(JSON.stringify(JSON.parse(p.payload), null, 2))}</pre>
<form method="post"><button>${d === "approve" ? "Approve" : "Reject"}</button></form>`);
    }

    // TEMPORARY (docs/azure-migration.md, open question 4): Sandbox only, shows which forwarding headers the
    // platform delivers, to find a client address a visitor can't forge. Removed once that is settled.
    if (url.pathname === "/__diag/forwarding" && env.EBAY_ENV === "sandbox")
    {
      const seen: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        if (/forward|client-ip|^client|azure|real-ip|^x-arr|^x-original|^disguised|^was-default|^x-site|^x-appservice/i.test(k)) seen[k] = v;
      });
      return Response.json(seen);
    }
    if (url.pathname === "/health") return Response.json({ ok: true, ebayEnv: env.EBAY_ENV, writeMode: env.WRITE_MODE });
    // Everything else is the dashboard and PWA (single-page app); its data comes from /api with K's session.
    if (env.ASSETS) return env.ASSETS.serve(request);
    return new Response("Not found", { status: 404 });
  }
};
