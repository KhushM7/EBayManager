import type { Env } from "./env";
import { consentUrl, exchangeCode, READONLY_SCOPES, userScopes } from "./ebay/auth";
import { handleAccountDeletion } from "./deletion";
import { handleApi } from "./api";
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

// The dashboard loads only its own code and the Switzer font, and can't be framed.
const CSP = [
  "default-src 'self'",
  "style-src 'self' https://api.fontshare.com",
  "font-src https://cdn.fontshare.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", CSP);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  return out;
}

const escHtml =(s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
      const state = `${crypto.randomUUID()}.${readonly ? "r" : "f"}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: consentUrl(env, state, userScopes(env, readonly)),
          "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; Path=/oauth; Max-Age=600`,
        },
      });
    }
    if (url.pathname === "/oauth/callback") {
      const session = await getSession(env, request);
      if (!session || session.user.role !== "owner") return html("<h1>Sign in as the owner first</h1>", 401);
      const cookie = request.headers.get("Cookie") ?? "";
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!code || !state || !cookie.includes(`oauth_state=${state}`)) return html("<h1>Sign-in check failed</h1>", 400);
      const scopes = userScopes(env, state.endsWith(".r"));
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

    if (url.pathname === "/health") return Response.json({ ok: true, ebayEnv: env.EBAY_ENV, writeMode: env.WRITE_MODE });
    // Everything else is the dashboard and PWA (single-page app); its data comes from /api with K's session.
    if (env.ASSETS) return withSecurityHeaders(await env.ASSETS.fetch(request));
    return new Response("Not found", { status: 404 });
  },

  // 02:00 UTC: the nightly health check (src/nightly.ts). Every 15 minutes: new buyer questions and offers (src/inbox.ts).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(controller.cron === "0 2 * * *" ? runNightly(env) : pollInbox(env));
  },
} satisfies ExportedHandler<Env>;
