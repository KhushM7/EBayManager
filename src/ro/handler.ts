import type { Env } from "../env";
import type { McpTool } from "../mcp-core";
import { rpcResponse } from "../mcp-core";
import { weeklyDigest } from "./digest";
import { EXPORTS, readExport } from "./export";
import { accuracyTable, healthTable, listingsTable, pricingTable, proposalsTable, salesTable, sinceDays, spendTable, statusTable, waitingTable } from "./tables";

// The read-only API for Microsoft Power Platform (docs/power-platform.md): /api/ro/*.
//
// - It has its own key (RO_API_KEY, sent as X-Api-Key), separate from every person's sign-in. Unset or
//   shorter than 32 characters, the API doesn't exist. A wrong key sees the same blank 404 as the rest of the
//   hidden site.
// - It only reads. Every route is a GET over src/ro/tables.ts (the one POST is the MCP transport for the same
//   read-only tools), and nothing here imports the write gate, the proposal code or an eBay or Claude client:
//   test/readonly.test.ts follows this file's imports to prove it, and runs every route against a store whose
//   writes throw. It can't create, approve or reject anything.
// - No buyer personal data: see src/ro/tables.ts.
// - Rate limited: 60 requests a minute. A wrong key is answered without touching the store, and there's no
//   lock-out to trip: Power Platform calls from addresses many tenants share, so a lock-out by address would
//   let a stranger's wrong guesses shut K's flows out. The key is 32 random bytes; guessing isn't a way in.

export const RO_KEY_HEADER = "X-Api-Key";
export const RO_MIN_KEY_LENGTH = 32;
export const RO_REQUESTS_PER_MINUTE = 60;

const blank = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
const items = <T>(rows: T[]) => json({ count: rows.length, items: rows });

/** Compares in constant time for keys of the same length. */
function sameKey(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Requests in the last minute, kept in this process only (each running copy of the app counts its own).
let recent: number[] = [];
export const resetRoRateLimit = () => void (recent = []);
function overLimit(now: number): number | null {
  recent = recent.filter((t) => t > now - 60_000);
  if (recent.length >= RO_REQUESTS_PER_MINUTE) return Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
  recent.push(now);
  return null;
}

const ITEM_ID = /^\d{6,20}$/;
const STATUSES = ["pending", "approved", "applied", "rejected", "expired", "failed", "agreed"];
const digestDays = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 31) : 7;
};

/** The GET routes: the path after /api/ro, and what it answers. Also the list the connector file is checked against. */
export const RO_ROUTES: { path: string; match: RegExp; run: (env: Env, q: URLSearchParams, m: RegExpMatchArray) => Promise<Response> }[] = [
  { path: "/status", match: /^\/status$/, run: async (env) => json(await statusTable(env)) },
  { path: "/listings", match: /^\/listings$/, run: async (env) => items(await listingsTable(env)) },
  { path: "/sales", match: /^\/sales$/, run: async (env, q) => items((await salesTable(env, sinceDays(q.get("days")))).map(({ sold_ms, ...r }) => r)) },
  {
    path: "/proposals",
    match: /^\/proposals$/,
    run: async (env, q) => {
      const status = q.get("status") ?? undefined;
      if (status && !STATUSES.includes(status)) return json({ error: `status is one of: ${STATUSES.join(", ")}` }, 400);
      return items((await proposalsTable(env, sinceDays(q.get("days")), status)).map(({ created_ms, expires_ms, ...r }) => r));
    },
  },
  { path: "/proposals/waiting", match: /^\/proposals\/waiting$/, run: async (env) => items(await waitingTable(env)) },
  { path: "/pricing", match: /^\/pricing$/, run: async (env) => items(await pricingTable(env)) },
  {
    path: "/pricing/{itemId}",
    match: /^\/pricing\/([^/]+)$/,
    run: async (env, _q, m) => {
      if (!ITEM_ID.test(m[1])) return json({ error: "Give the eBay item number" }, 400);
      const [row] = await pricingTable(env, m[1]);
      return row ? json(row) : json({ error: "No price has been worked out for that listing yet" }, 404);
    },
  },
  { path: "/pricing-accuracy", match: /^\/pricing-accuracy$/, run: async (env, q) => { const a = await accuracyTable(env, sinceDays(q.get("days"), 730)); return json({ ...a.summary, count: a.rows.length, items: a.rows }); } },
  { path: "/health-flags", match: /^\/health-flags$/, run: async (env, q) => items(await healthTable(env, sinceDays(q.get("days"), 30))) },
  { path: "/spend", match: /^\/spend$/, run: async (env, q) => items(await spendTable(env, sinceDays(q.get("days"), 30))) },
  { path: "/digest", match: /^\/digest$/, run: async (env, q) => json(await weeklyDigest(env, digestDays(q.get("days")))) },
  {
    path: "/export/{name}.csv",
    match: /^\/export\/([a-z_]{1,40})\.csv$/,
    run: async (env, q, m) => {
      const out = await readExport(env, m[1], q.get("live") === "1");
      if (!out) return json({ error: `Exports: ${Object.keys(EXPORTS).join(", ")}` }, 404);
      return new Response(out.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "X-Exported-At": new Date(out.exportedAt).toISOString() } });
    },
  },
];

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required });
const daysArg = { days: { type: "number", description: "How many days back to look (1 to 730)." } };

/** The same reads as tools, for an agent (Copilot Studio). There is no tool that changes anything. */
export const RO_TOOLS: McpTool[] = [
  { name: "shop_status", description: "How many listings are live, how many changes are waiting for a person, and when the nightly check last ran.", inputSchema: obj(), run: (env) => statusTable(env) },
  { name: "list_listings", description: "Every live eBay listing: title, price, watchers, views, days listed and any health flags.", inputSchema: obj(), run: (env) => listingsTable(env) },
  { name: "what_sold", description: "Items sold in the last N days (7 unless said), with the price and how long each took to sell.", inputSchema: obj(daysArg), run: async (env, a) => (await salesTable(env, sinceDays(a?.days, 7))).map(({ sold_ms, ...r }) => r) },
  { name: "what_is_waiting", description: "Changes waiting for a person to approve or reject, who each is for, how long is left, and the link to open the app. This tool cannot approve or reject: the person decides in the app.", inputSchema: obj(), run: (env) => waitingTable(env) },
  {
    name: "explain_price",
    description: "Why the pricing engine suggested its price for one listing: the strategy, the market price, the options and the reasoning in words. Give the eBay item number (find it with list_listings).",
    inputSchema: obj({ item_id: { type: "string", description: "The eBay item number." } }, ["item_id"]),
    run: async (env, a) => {
      if (!ITEM_ID.test(String(a?.item_id ?? ""))) throw new Error("Give the eBay item number");
      const [row] = await pricingTable(env, String(a.item_id));
      if (!row) throw new Error("No price has been worked out for that listing yet");
      return row;
    },
  },
  { name: "recent_suggestions", description: "Changes suggested in the last N days (7 unless said) and what happened to each: approved, rejected, expired or still waiting, with the reason given.", inputSchema: obj(daysArg), run: async (env, a) => (await proposalsTable(env, sinceDays(a?.days, 7))).map(({ created_ms, expires_ms, ...r }) => r) },
  { name: "pricing_accuracy", description: "How close the engine's prices were to what items actually sold for.", inputSchema: obj(daysArg), run: async (env, a) => { const r = await accuracyTable(env, sinceDays(a?.days, 730)); return { ...r.summary, items: r.rows.slice(-25) }; } },
  { name: "claude_spend", description: "What Claude cost per day and per job in the last N days (30 unless said), against the daily budget.", inputSchema: obj(daysArg), run: (env, a) => spendTable(env, sinceDays(a?.days, 30)) },
  { name: "weekly_digest", description: "A plain-English summary of the last 7 days: what sold, what is waiting, and what was suggested and why.", inputSchema: obj(), run: async (env) => (await weeklyDigest(env)).text },
];

const MCP_SERVER = {
  name: "ebaymanager-readonly",
  instructions: "Read-only answers about K's eBay shop. Nothing here can change a listing, a price or a proposal: when something is waiting, give the person its link and they decide in the app.",
};

/** Everything under /api/ro/. */
export async function handleReadOnly(env: Env, request: Request, url: URL): Promise<Response> {
  const key = env.RO_API_KEY ?? "";
  if (key.length < RO_MIN_KEY_LENGTH) return blank();
  if (!sameKey(request.headers.get(RO_KEY_HEADER) ?? "", key)) return blank();
  const wait = overLimit(Date.now());
  if (wait != null) return json({ error: "Too many requests. Try again in a minute." }, 429, { "Retry-After": String(wait) });

  const path = url.pathname.replace(/^\/api\/ro/, "");
  if (path === "/mcp") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    return rpcResponse(env, request, RO_TOOLS, MCP_SERVER);
  }
  if (request.method !== "GET") return json({ error: "This API only reads" }, 405, { Allow: "GET" });
  for (const r of RO_ROUTES) {
    const m = path.match(r.match);
    if (!m) continue;
    try {
      return await r.run(env, url.searchParams, m);
    } catch (e) {
      console.error(`ro ${r.path}: ${e instanceof Error ? e.message : String(e)}`);
      return json({ error: "That couldn't be read just now" }, 500);
    }
  }
  return json({ error: "Not found" }, 404);
}
