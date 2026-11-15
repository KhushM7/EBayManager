// The Power Platform surfaces (docs/power-platform.md): the read-only API and the Stock Room intake. These
// tests keep the plan's ground rules true in code: a separate key, reads only, no buyer personal data, no
// path to the write gate, and intake that can only make drafts.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { memoryStore } from "../src/store";
import { memoryPhotoStore } from "../src/photos";
import { verifyDecision } from "../src/links";
import { RO_REQUESTS_PER_MINUTE, RO_ROUTES, RO_TOOLS, resetRoRateLimit } from "../src/ro/handler";
import { EXPORTS, csvCell, writeExports } from "../src/ro/export";
import { INTAKE_DRAFTS_PER_DAY } from "../src/intake";
import { seedProposal, seedSnapshot } from "./fixtures";

const ORIGIN = "https://app.example";
const RO_KEY = "ro-key-0123456789abcdefghijklmnopqrstuv";
const INTAKE_KEY = "in-key-0123456789abcdefghijklmnopqrstuv";
const DAY = 86_400_000;
const NOW = Date.now();
const ITEM = "123456789012";

let env: Env;
const call = (path: string, init: RequestInit & { key?: string | null; ip?: string } = {}) => {
  const { key = RO_KEY, ip = "9.9.9.9", ...rest } = init;
  const headers = new Headers(rest.headers);
  if (key) headers.set("X-Api-Key", key);
  headers.set("Client-IP", `${ip}:4000`);
  return worker.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }), env);
};
const ro = async (path: string) => {
  const res = await call(`/api/ro${path}`);
  return { status: res.status, body: (await res.json()) as any };
};

/** A shop with a listing, a sale, a price the engine gave before the sale, proposals of each sort, flags and spend. */
async function seed(e: Env) {
  const s = e.store;
  await seedSnapshot(s, NOW - 40 * DAY, [{ item_id: ITEM, title: "Ninja air fryer AF100UK", price: 40 }]);
  await seedSnapshot(s, NOW - DAY, [{ item_id: ITEM, title: "Ninja air fryer AF100UK", price: 36 }]);
  await s.pricing.recordDecision({ item_id: ITEM, at: NOW - 10 * DAY, grp: "air fryer", strategy: "undercut", price: 34, total: 38, market_price: 39, predicted_days: 9, result: JSON.stringify({ decision: { why: "Just under the cheapest used one at £35.", confidence: 0.7, options: [{ price: 32, daysToSell: 5 }, { price: 34, daysToSell: 9 }] } }) });
  await s.orders.upsertFromApi([{ orderId: "12-34567-89012", createdAt: NOW - 2 * DAY, total: 36.5, fees: 0, currency: "GBP", status: "PAID", items: [{ itemId: ITEM, title: "Ninja air fryer AF100UK", quantity: 1, price: 32 }] }]);
  const base = { item_id: ITEM, created_at: NOW - 3 * DAY, expires_at: NOW + 4 * DAY };
  await seedProposal(s, { ...base, id: `${ITEM}_price`, kind: "price", status: "pending", payload: JSON.stringify({ oldPrice: 36, newPrice: 34, flags: [], secretField: "x" }) });
  await s.docs.patch("proposals", `${ITEM}_price`, ITEM, [{ op: "set", path: "/reason", value: "Just under the cheapest used one." }]);
  await seedProposal(s, { ...base, id: `${ITEM}_msg`, kind: "message", status: "pending", payload: JSON.stringify({ itemTitle: "Ninja air fryer AF100UK", recipientId: "buyer_bob_1987", question: "Hi, I'm Bob Smith of 4 Privet Drive, will you post it?", body: "Yes, tomorrow." }) });
  await s.docs.patch("proposals", `${ITEM}_msg`, ITEM, [{ op: "set", path: "/reason", value: "buyer_bob_1987 asked about postage to Privet Drive" }]);
  await seedProposal(s, { ...base, id: `${ITEM}_offer`, kind: "best_offer_response", status: "rejected", payload: JSON.stringify({ buyer: "buyer_bob_1987", buyerMessage: "Call me on 07700 900123", offerPrice: 25, listPrice: 36, action: "counter", counterPrice: 33, message: "Thanks Bob" }) });
  await s.docs.patch("proposals", `${ITEM}_offer`, ITEM, [{ op: "set", path: "/decided_at", value: NOW - 2 * DAY }, { op: "set", path: "/decided_by", value: "K" }]);
  await s.jobs.recordHealthFlags(NOW - DAY, [{ item_id: ITEM, flag: "stale", detail: "Listed 40 days with no watchers." }]);
  await s.usage.log({ at: NOW - DAY, job: `triage:${ITEM}`, model: "claude-haiku-5-5", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.004, stop_reason: "end_turn" });
}

beforeEach(async () => {
  resetRoRateLimit();
  env = { store: memoryStore(), photos: memoryPhotoStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", PUBLIC_URL: ORIGIN, SIGNING_KEY: "sign", DASHBOARD_KEY: "boot-key-123", RO_API_KEY: RO_KEY, INTAKE_API_KEY: INTAKE_KEY } as unknown as Env;
  await seed(env);
});

// --- Source checks ---

/** Every file a module reaches through real imports (type-only imports load nothing, so they don't count). */
function reachable(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, "utf8");
  for (const m of src.matchAll(/^\s*(import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) {
    const base = join(dirname(entry), m[2]);
    const file = [`${base}.ts`, join(base, "index.ts")].find(existsSync);
    if (file) reachable(file.replace(/\\/g, "/"), seen);
  }
  // A real dynamic import (a type written as import("…").Name loads nothing).
  for (const m of src.matchAll(/await import\("(\.[^"]+)"\)/g)) {
    const base = join(dirname(entry), m[1]);
    if (existsSync(`${base}.ts`)) reachable(`${base}.ts`.replace(/\\/g, "/"), seen);
  }
  return seen;
}

describe("the Power Platform code can't reach the write gate", () => {
  const FORBIDDEN = ["src/ebay/write.ts", "src/proposals.ts", "src/ebay/trading.ts", "src/ebay/sell.ts", "src/ebay/auth.ts", "src/claude.ts", "src/tools.ts", "src/api.ts", "src/drafts.ts", "src/newlisting.ts"];
  for (const entry of ["src/ro/handler.ts", "src/ro/export.ts", "src/intake.ts"])
    it(`${entry} imports nothing that writes to eBay, decides a proposal or calls Claude`, () => {
      const files = reachable(entry);
      for (const f of FORBIDDEN) expect(files.has(f), `${entry} reaches ${f}`).toBe(false);
      // The whole of what it does load, so a new import is a deliberate change to this list.
      const allowed = /^src\/(ro\/|store\/(index|data|doc|memory|proposals|auth|todos|drafts)\.ts$|(env|rules|links|util|mcp-core|photos|intake)\.ts$)/;
      for (const f of files) expect(allowed.test(f), `${entry} reaches ${f}`).toBe(true);
    });

  it("the read-only code makes no network calls and names no store write", () => {
    for (const f of ["src/ro/handler.ts", "src/ro/tables.ts", "src/ro/digest.ts", "src/links.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(/\bfetch\(/.test(src), f).toBe(false);
      // Every store call it makes is a read (the test below also runs them against a store whose writes throw).
      for (const m of src.matchAll(/env\.store\.\w+\.(\w+)\(/g)) expect(/^(get|list|latest|since|snapshots|healthRuns|decision|used|any|open|recent|count)/.test(m[1]), `${f}: env.store….${m[1]}`).toBe(true);
    }
  });

  it("the connector file lists exactly the routes the API serves", () => {
    const spec = JSON.parse(readFileSync("powerplatform/connector/ebaymanager-readonly.swagger.json", "utf8"));
    expect(Object.keys(spec.paths).sort()).toEqual(RO_ROUTES.map((r) => r.path).sort());
    for (const p of Object.values<any>(spec.paths)) expect(Object.keys(p)).toEqual(["get"]);
    expect(spec.swagger).toBe("2.0"); // Power Platform custom connectors import OpenAPI 2.0
    expect(spec.paths["/export/{name}.csv"].get.parameters[0].enum.sort()).toEqual(Object.keys(EXPORTS).sort());
    const intake = JSON.parse(readFileSync("powerplatform/connector/ebaymanager-intake.swagger.json", "utf8"));
    expect(Object.keys(intake.paths)).toEqual(["/drafts"]);
  });
});

// --- The key ---

describe("the read-only key", () => {
  it("without the key, or with a wrong one, the API is the same blank 404 as the rest of the hidden site", async () => {
    for (const key of [null, "wrong", `${RO_KEY}x`, INTAKE_KEY, "boot-key-123"]) {
      const res = await call("/api/ro/status", { key });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  it("doesn't exist when the key is unset or short", async () => {
    for (const k of [undefined, "", "short-key"]) {
      env.RO_API_KEY = k;
      expect((await call("/api/ro/status", { key: k || "x" })).status).toBe(404);
    }
  });

  it("a wrong key writes nothing and locks nobody out: wrong guesses from a shared address can't shut the flows out", async () => {
    const docs = env.store.docs as any;
    const create = docs.create.bind(docs);
    docs.create = () => { throw new Error("a wrong key wrote to the store"); };
    for (let i = 0; i < 30; i++) expect((await call("/api/ro/status", { key: `guess-${i}`, ip: "5.5.5.5" })).status).toBe(404);
    for (let i = 0; i < 30; i++) expect((await call("/api/intake/drafts", { key: `guess-${i}`, ip: "5.5.5.5", method: "POST", body: "{}" })).status).toBe(404);
    docs.create = create;
    expect((await call("/api/ro/status", { ip: "5.5.5.5" })).status).toBe(200);
  });

  it("allows 60 requests a minute", async () => {
    for (let i = 0; i < RO_REQUESTS_PER_MINUTE; i++) expect((await call("/api/ro/status")).status).toBe(200);
    const res = await call("/api/ro/status");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("opens nothing else: not the dashboard API, the approval links or the intake", async () => {
    expect((await call("/api/me")).status).toBe(404);
    expect((await call("/api/proposals")).status).toBe(404);
    expect((await call("/api/proposals/decide", { method: "POST", headers: { "X-EbayManager": "1", "Content-Type": "application/json" }, body: JSON.stringify({ ids: [`${ITEM}_price`], decision: "approve" }) })).status).toBe(404);
    expect((await call("/api/intake/drafts", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await env.store.proposals.get(`${ITEM}_price`))!.status).toBe("pending");
  });

  it("refuses every method but GET", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) for (const path of ["/proposals", "/proposals/waiting", "/listings"]) expect((await call(`/api/ro${path}`, { method })).status).toBe(405);
    expect((await env.store.proposals.get(`${ITEM}_price`))!.status).toBe("pending");
  });
});

// --- Reads only ---

const ALL_PATHS = ["/status", "/listings", "/sales", "/proposals", "/proposals?status=pending", "/proposals/waiting", "/pricing", `/pricing/${ITEM}`, "/pricing-accuracy", "/health-flags", "/spend", "/digest", ...Object.keys(EXPORTS).map((n) => `/export/${n}.csv`)];

describe("the read-only API only reads", () => {
  it("serves every route from a store whose every write throws", async () => {
    const docs = env.store.docs as any;
    for (const m of ["create", "upsert", "replace", "patch", "delete", "batch"]) docs[m] = () => { throw new Error(`write attempted: ${m}`); };
    env.exports = { get: async () => null, put: async () => { throw new Error("write attempted: export"); } };
    for (const path of ALL_PATHS) {
      resetRoRateLimit();
      const res = await call(`/api/ro${path}`);
      expect(res.status, path).toBe(200);
    }
    for (const t of RO_TOOLS) await t.run(env, { item_id: ITEM, days: 30 });
  });

  it("covers every route in the list", () => {
    for (const r of RO_ROUTES) expect(ALL_PATHS.some((p) => r.match.test(p.split("?")[0])), r.path).toBe(true);
  });

  it("answers with what the shop holds", async () => {
    expect((await ro("/status")).body).toMatchObject({ environment: "sandbox", read_only: true, active_listings: 1, waiting_changes: 2 });
    expect((await ro("/listings")).body.items[0]).toMatchObject({ item_id: ITEM, price: 36, health_flags: "stale", waiting_changes: 2, days_listed: 40 });
    const sale = (await ro("/sales")).body.items[0];
    expect(sale).toMatchObject({ item_id: ITEM, item_price: 32, quantity: 1, source: "ebay" });
    expect(sale.days_to_sell).toBeCloseTo(38, 0);
    const acc = (await ro("/pricing-accuracy")).body;
    expect(acc).toMatchObject({ sales: 1, priced: 1, mean_abs_pct_error: 0.063 });
    expect(acc.items[0]).toMatchObject({ predicted_price: 34, sold_price: 32, error: -2 });
    expect((await ro(`/pricing/${ITEM}`)).body).toMatchObject({ suggested_price: 34, why: "Just under the cheapest used one at £35.", confidence: 0.7 });
    expect((await ro("/pricing/999999999")).status).toBe(404);
    expect((await ro("/pricing/abc")).status).toBe(400);
    expect((await ro("/health-flags")).body.items[0]).toMatchObject({ flag: "stale", item_id: ITEM });
    expect((await ro("/spend")).body.items[0]).toMatchObject({ job: "triage", calls: 1, cost_usd: 0.004, daily_budget_usd: 1 });
    expect((await ro("/proposals?status=nonsense")).status).toBe(400);
    const digest = (await ro("/digest")).body;
    expect(digest.sold.count).toBe(1);
    expect(digest.text).toContain("Sold: 1 item for £32.00.");
    expect(digest.text).toContain("Price change for Ninja air fryer AF100UK: Just under the cheapest used one.");
  });
});

// --- No buyer personal data ---

describe("no buyer personal data leaves", () => {
  const BUYER = ["buyer_bob_1987", "Bob", "Privet", "07700", "12-34567-89012", "Call me", "Yes, tomorrow", "secretField"];

  it("in any route, tool or export", async () => {
    for (const path of ALL_PATHS) {
      resetRoRateLimit();
      const text = await (await call(`/api/ro${path}`)).text();
      for (const word of BUYER) expect(text.includes(word), `${path} contains ${word}`).toBe(false);
    }
    for (const t of RO_TOOLS) {
      const text = JSON.stringify(await t.run(env, { item_id: ITEM, days: 30 }));
      for (const word of BUYER) expect(text.includes(word), `${t.name} contains ${word}`).toBe(false);
    }
  });

  it("a reply to a buyer leaves with no text at all, and an offer answer with prices only", async () => {
    const { items } = (await ro("/proposals")).body;
    const msg = items.find((p: any) => p.kind === "message");
    expect(msg).toMatchObject({ reason: null, details: {}, item_title: "Ninja air fryer AF100UK" });
    const offer = items.find((p: any) => p.kind === "best_offer_response");
    expect(offer).toMatchObject({ reason: null, outcome: "rejected", decided_by: "K", details: { offerPrice: 25, listPrice: 36, action: "counter", counterPrice: 33 } });
    expect(items.find((p: any) => p.kind === "price").details).toEqual({ oldPrice: 36, newPrice: 34 });
  });

  it("never sends the floor price, K's notes or the eBay token", async () => {
    await env.store.listings.setFloorAndNotes(ITEM, 28.17, "Bought from Dave for a tenner");
    await env.store.kv.saveEbayTokens({ access_token: "tok-access", access_expires_at: NOW + 1000, refresh_token: "tok-refresh", refresh_expires_at: NOW + 1000, scopes: "s" });
    for (const path of ALL_PATHS) {
      resetRoRateLimit();
      const text = await (await call(`/api/ro${path}`)).text();
      for (const word of ["28.17", "Dave", "tok-access", "tok-refresh", "boot-key-123", RO_KEY]) expect(text.includes(word), `${path} contains ${word}`).toBe(false);
    }
  });
});

// --- Approval stays with a person ---

describe("what's waiting", () => {
  it("on Sandbox gives only the link to the app: this key can never decide", async () => {
    const { items } = (await ro("/proposals/waiting")).body;
    expect(items).toHaveLength(2);
    for (const w of items) expect(w).toMatchObject({ open_url: `${ORIGIN}/`, approve_url: null, reject_url: null, for: "owner" });
    expect(items[0].hours_waiting).toBeCloseTo(72, 0);
    expect(items[0].hours_left).toBeCloseTo(96, 0);
  });

  it("on the real account gives the existing signed links, which still need a signed-in device and a POST", async () => {
    env.EBAY_ENV = "production";
    const { items } = (await ro("/proposals/waiting")).body;
    const price = items.find((w: any) => w.kind === "price");
    const u = new URL(price.approve_url);
    expect(await verifyDecision(env, `${ITEM}_price`, "approve", Number(u.searchParams.get("e")), u.searchParams.get("s")!)).toBe(true);
    // Replies are decided in the app, never from a link.
    expect(items.find((w: any) => w.kind === "message")).toMatchObject({ approve_url: null, reject_url: null });
    // Opening the link without a session shows the sign-in notice, and posting to it decides nothing.
    expect((await worker.fetch(new Request(price.approve_url), env)).status).toBe(401);
    expect((await worker.fetch(new Request(price.approve_url, { method: "POST", headers: { "X-Api-Key": RO_KEY } }), env)).status).toBe(401);
    expect((await env.store.proposals.get(`${ITEM}_price`))!.status).toBe("pending");
  });

  it("a dry run gets no signed link, and an expired proposal isn't waiting", async () => {
    env.EBAY_ENV = "production";
    await seedProposal(env.store, { id: `${ITEM}_dry`, kind: "revise", item_id: ITEM, status: "pending", created_at: NOW, expires_at: NOW + DAY, dry_run: 1 });
    await seedProposal(env.store, { id: `${ITEM}_old`, kind: "promote", item_id: ITEM, status: "pending", created_at: NOW - 9 * DAY, expires_at: NOW - 2 * DAY });
    const { items } = (await ro("/proposals/waiting")).body;
    expect(items.find((w: any) => w.id === `${ITEM}_dry`).approve_url).toBeNull();
    expect(items.some((w: any) => w.id === `${ITEM}_old`)).toBe(false);
  });
});

// --- The agent tools ---

describe("the read-only tools for an agent (MCP)", () => {
  const mcp = async (body: unknown, key: string | null = RO_KEY) => call("/api/ro/mcp", { method: "POST", key, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("needs the same key", async () => {
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null)).status).toBe(404);
  });

  it("lists only tools that read: nothing proposes, approves, rejects, pauses or sets", async () => {
    const res = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    const names: string[] = res.result.tools.map((t: any) => t.name);
    expect(names.sort()).toEqual(["claude_spend", "explain_price", "list_listings", "pricing_accuracy", "recent_suggestions", "shop_status", "weekly_digest", "what_is_waiting", "what_sold"]);
    for (const n of names) expect(/propos|approv|reject|decid|pause|set_|write|create|send|edit|delete/.test(n), n).toBe(false);
  });

  it("explains a price, and refuses a tool from K's own set", async () => {
    const ok = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "explain_price", arguments: { item_id: ITEM } } })).json()) as any;
    expect(ok.result.content[0].text).toContain("Just under the cheapest used one at £35.");
    for (const name of ["propose_price_change", "pause_writes", "set_item_settings"]) {
      const no = (await (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: { item_id: ITEM, new_price: 1, reason: "x" } } })).json()) as any;
      expect(no.error.message).toContain("Unknown tool");
    }
    expect((await env.store.proposals.listByStatus("pending", "asc")).length).toBe(2);
  });
});

// --- The export files ---

describe("the Power BI export", () => {
  it("writes every table nightly and serves the stored file; ?live=1 builds it now", async () => {
    const files = new Map<string, Uint8Array>();
    env.exports = { put: async (k, b) => void files.set(k, b), get: async (k) => files.get(k) ?? null };
    expect(await writeExports(env, NOW)).toBe(`${Object.keys(EXPORTS).length} files`);
    expect([...files.keys()].sort()).toEqual([...Object.keys(EXPORTS).map((n) => `${n}.csv`), "manifest.json"].sort());
    await seedSnapshot(env.store, NOW, [{ item_id: ITEM, price: 30 }, { item_id: "222222222222", price: 5 }]);
    const stored = await call("/api/ro/export/listings.csv");
    expect(stored.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(stored.headers.get("X-Exported-At")).toBe(new Date(NOW).toISOString());
    expect((await stored.text()).trim().split("\r\n")).toHaveLength(2);
    expect((await (await call("/api/ro/export/listings.csv?live=1")).text()).trim().split("\r\n")).toHaveLength(3);
    expect((await call("/api/ro/export/secrets.csv")).status).toBe(404);
  });

  it("has the columns the Power BI model names, in order", async () => {
    for (const [name, e] of Object.entries(EXPORTS)) {
      resetRoRateLimit();
      const csv = await (await call(`/api/ro/export/${name}.csv`)).text();
      expect(csv.split("\r\n")[0], name).toBe(e.columns.join(","));
    }
    const sales = (await (await call("/api/ro/export/sales.csv")).text()).split("\r\n");
    expect(sales[1]).toMatch(new RegExp(`^[0-9a-f]{16},\\d{4}-\\d\\d-\\d\\dT[^,]+,${ITEM},Ninja air fryer AF100UK,1,32,32,\\d+(\\.\\d)?,ebay$`));
    // Every column the model's Power Query reads exists in the export of that name.
    const model = readFileSync("powerplatform/powerbi/queries.pq", "utf8");
    for (const [name, e] of Object.entries(EXPORTS)) {
      const block = model.split(`// ${name}\n`)[1]?.split("\n// ")[0] ?? "";
      expect(block, `queries.pq has no query for ${name}`).not.toBe("");
      for (const m of block.matchAll(/\{"([a-z_0-9]+)",/g)) expect(e.columns, `${name}.${m[1]}`).toContain(m[1]);
    }
  });

  it("quotes cells safely and defuses spreadsheet formulas", () => {
    expect(csvCell('He said "hi", twice')).toBe('"He said ""hi"", twice"');
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+44 phone")).toBe("'+44 phone");
    expect(csvCell(-2)).toBe("-2");
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("true");
  });

  it("is skipped quietly where there's no export storage", async () => {
    expect(await writeExports(env, NOW)).toBe("skipped: no export storage");
  });
});

// --- Stock Room intake ---

describe("Stock Room intake", () => {
  const send = (body: unknown, key: string | null = INTAKE_KEY) => call("/api/intake/drafts", { method: "POST", key, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const jpeg = readFileSync(join("test", "fixtures-photos", "front.jpg"));

  it("needs its own key: the read-only key, no key and a wrong key all see the blank 404", async () => {
    for (const key of [null, RO_KEY, "wrong"]) expect((await send({ sourceId: "row-1", title: "Lamp" }, key)).status).toBe(404);
    env.INTAKE_API_KEY = undefined;
    expect((await send({ sourceId: "row-1", title: "Lamp" })).status).toBe(404);
    expect(await env.store.drafts.list("open")).toHaveLength(0);
  });

  it("makes a draft and nothing else: no proposal, no label, nothing for eBay", async () => {
    const before = (await env.store.proposals.listWhere([])).length;
    const res = await send({ sourceId: "row-1", title: "  Brass desk lamp\n<b>", owner: "Mum", location: "Garage, box 3", condition: "Works, small dent" });
    expect(res.status).toBe(201);
    const out = (await res.json()) as any;
    expect(out).toMatchObject({ created: true, photoAdded: false });
    const [d] = await env.store.drafts.list("open");
    expect(d).toMatchObject({ id: out.draftId, status: "open", title: "Brass desk lamp <b>", created_by: "Mum (Stock Room)", name: "Brass desk lamp <b> · in Garage, box 3 · Works, small dent · from Mum", photos: [] });
    // What the family typed isn't recorded as a fact about the item: the wizard asks the person listing it.
    expect(d.facts ?? null).toBeNull();
    expect((await env.store.proposals.listWhere([])).length).toBe(before);
    expect(await env.store.audit.recent(10)).toHaveLength(0);
  });

  it("sending the same row twice makes one draft", async () => {
    const a = (await (await send({ sourceId: "row-7", title: "Kettle" })).json()) as any;
    const again = await send({ sourceId: "row-7", title: "Kettle" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ draftId: a.draftId, created: false });
    expect(await env.store.drafts.list("open")).toHaveLength(1);
  });

  it("checks what it's sent", async () => {
    expect((await send("not json")).status).toBe(400);
    expect((await send({ sourceId: "row-1" })).status).toBe(400);
    expect((await send({ title: "Lamp" })).status).toBe(400);
    expect((await send({ sourceId: "../../x", title: "Lamp" })).status).toBe(400);
    expect((await send({ sourceId: "row-1", title: "Lamp", photoBase64: "bm90IGEgcGhvdG8=" })).status).toBe(400);
    expect((await call("/api/intake/drafts", { key: INTAKE_KEY })).status).toBe(405);
    expect((await call("/api/intake/other", { key: INTAKE_KEY, method: "POST", body: "{}" })).status).toBe(404);
    expect(await env.store.drafts.list("open")).toHaveLength(0);
  });

  it("stores a photo through the same checks as the app, with its metadata stripped", async () => {
    const res = await send({ sourceId: "row-2", title: "Camera", photoBase64: Buffer.from(jpeg).toString("base64") });
    expect(res.status).toBe(201);
    const [d] = await env.store.drafts.list("open");
    expect(d.photos).toHaveLength(1);
    expect(d.photos[0].key).toBe(`drafts/${d.id}/${d.photos[0].id}.jpg`);
    expect(await env.photos!.get(d.photos[0].key)).not.toBeNull();
  });

  it("stops at the day's limit and at the app's limit on open drafts", async () => {
    for (let i = 0; i < INTAKE_DRAFTS_PER_DAY; i++) expect((await send({ sourceId: `r-${i}`, title: `Thing ${i}` })).status).toBe(201);
    expect((await send({ sourceId: "r-more", title: "One more" })).status).toBe(429);
    env.store = memoryStore();
    for (let i = 0; i < 50; i++) await env.store.drafts.create("K", NOW);
    expect((await send({ sourceId: "r-full", title: "No room" })).status).toBe(409);
  });
});
