import type { Env } from "./env";
import { consentUrl, exchangeCode } from "./ebay/auth";
import { handleMcp } from "./mcp";
import { decide, getProposal, verifyDecision } from "./proposals";
import { snapshotListings } from "./tools";

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;max-width:560px;margin:24px auto;padding:0 16px}button{font-size:18px;padding:12px 20px;margin-right:8px}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px}</style>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") return handleMcp(env, request);

    // One-time eBay sign-in. Guarded by MCP_TOKEN so only K can start it.
    if (url.pathname === "/oauth/start") {
      if (url.searchParams.get("key") !== env.MCP_TOKEN) return new Response("Unauthorized", { status: 401 });
      const state = crypto.randomUUID();
      return new Response(null, {
        status: 302,
        headers: { Location: consentUrl(env, state), "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; Path=/oauth; Max-Age=600` },
      });
    }
    if (url.pathname === "/oauth/callback") {
      const cookie = request.headers.get("Cookie") ?? "";
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!code || !state || !cookie.includes(`oauth_state=${state}`)) return html("<h1>Sign-in check failed</h1>", 400);
      await exchangeCode(env, code);
      return html("<h1>eBay connected</h1><p>You can close this tab.</p>");
    }

    // Approval links: GET shows the proposal, only the POST from K's tap decides (link previews can't approve).
    const m = url.pathname.match(/^\/decide\/([\w-]+)$/);
    if (m) {
      const id = m[1];
      const d = url.searchParams.get("d") as "approve" | "reject";
      const s = url.searchParams.get("s") ?? "";
      if ((d !== "approve" && d !== "reject") || !(await verifyDecision(env, id, d, s))) return html("<h1>Invalid link</h1>", 403);
      if (request.method === "POST") return html(`<h1>${escHtml(await decide(env, id, d))}</h1>`);
      const p = await getProposal(env, id);
      if (!p) return html("<h1>Not found</h1>", 404);
      return html(`<h1>${d === "approve" ? "Approve" : "Reject"} this ${p.kind} change?</h1>
<p>Item ${escHtml(p.item_id ?? "")} · status ${p.status}</p><p>${escHtml(p.reason ?? "")}</p>
<pre>${escHtml(JSON.stringify(JSON.parse(p.payload), null, 2))}</pre>
<form method="post"><button>${d === "approve" ? "Approve" : "Reject"}</button></form>`);
    }

    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },

  // Nightly snapshot, no Claude involved. The re-evaluation routine reads these.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(snapshotListings(env));
  },
} satisfies ExportedHandler<Env>;
