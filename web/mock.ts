// Dev-only stand-in for the Worker's /api, so the screens can be built and screenshotted without an account.
// Used by `MOCK=1 npm run dev:web`. Never bundled into the app.
import type { Plugin } from "vite";

const now = Date.now();
const h = 3_600_000;

const me = {
  ebayEnv: "sandbox",
  writeMode: "approval",
  writesPaused: false,
  writesBlocked: null,
  ebayConnected: true,
  ebayScopes: "full",
  vapidPublicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
  lastPushAt: now - 2 * h,
};

let proposals: any[] = [
  {
    id: "q1", kind: "message", item_id: "110591497601", item_title: "TEST White Ceramic Coffee Mug 350ml", item_price: 6,
    payload: { recipientId: "buyer_one", parentMessageId: "m1", question: "Hi, is this dishwasher safe?", body: "Hi, the listing doesn't say, so I'll check the base and reply shortly." },
    reason: "Drafted from the listing's own details.", status: "pending", dry_run: 0, created_at: now - 12 * 60_000, expires_at: now + 7 * 24 * h, decided_at: null, result: null,
  },
  {
    id: "o1", kind: "best_offer_response", item_id: "110591497965", item_title: "TEST Classic Strategy Board Game Complete", item_price: 12,
    payload: { bestOfferId: "bo1", buyer: "offer_buyer", offerPrice: 9, listPrice: 12, buyerMessage: "Would you take 9? Can collect today.", action: "counter", counterPrice: 10.5, message: "Thanks! I can do £10.50.", flags: [] },
    reason: "25% below the asking price; meets halfway.", status: "pending", dry_run: 0, created_at: now - 30 * 60_000, expires_at: now + 2 * 24 * h, decided_at: null, result: null,
  },
  {
    id: "p1", kind: "price", item_id: "110591497601", item_title: "TEST White Ceramic Coffee Mug 350ml", item_price: 6,
    payload: { oldPrice: 6, newPrice: 5.5, flags: [] }, reason: "Three identical mugs sold for £5.00 to £5.80 in the last 30 days; 9 are listed now.",
    status: "pending", dry_run: 0, created_at: now - 40 * 60_000, expires_at: now + 7 * 24 * h, decided_at: null, result: null,
  },
  {
    id: "p2", kind: "revise", item_id: "110591497599", item_title: "TEST The Hobbit by J.R.R. Tolkien Paperback", item_price: 4.5,
    payload: { title: "The Hobbit J.R.R. Tolkien HarperCollins Paperback 2012 Very Good", itemSpecifics: { Author: ["J.R.R. Tolkien"] } },
    reason: "Adds publisher, year and condition to the title; buyers search for these.", status: "pending", dry_run: 0,
    created_at: now - 3 * h, expires_at: now + 6 * 24 * h, decided_at: null, result: null,
  },
  {
    id: "p3", kind: "price", item_id: "110591497965", item_title: "TEST Classic Strategy Board Game Complete", item_price: 12,
    payload: { oldPrice: 12, newPrice: 9.5, flags: ["more than 10% from 12", "price already changed in the last 7 days"] },
    reason: "Collection-only games of this kind sell for £8 to £10 locally.", status: "pending", dry_run: 0,
    created_at: now - 5 * h, expires_at: now + 6 * 24 * h, decided_at: null, result: null,
  },
  {
    id: "p4", kind: "create_listing", item_id: null, item_title: null, item_price: null,
    payload: { title: "Sony WH-1000XM4 Headphones Black, Boxed", price: 120, collectionOnly: false, verifiedFees: 0 },
    reason: "Sold comps for boxed, used pairs: £115 to £140; priced at the lower end.", status: "pending", dry_run: 0,
    created_at: now - 26 * h, expires_at: now + 5 * 24 * h, decided_at: null, result: null,
  },
];

const listings = [
  { item_id: "110591497599", title: "TEST The Hobbit by J.R.R. Tolkien Paperback", price: 4.5, currency: "GBP", watch_count: 2, view_count: 31, quantity_available: 1, start_time: new Date(now - 12 * 24 * h).toISOString(), taken_at: now - 3 * h, floor_price: 3.5, collection_only: 0, pending: 1 },
  { item_id: "110591497601", title: "TEST White Ceramic Coffee Mug 350ml", price: 6, currency: "GBP", watch_count: 0, view_count: 9, quantity_available: 1, start_time: new Date(now - 12 * 24 * h).toISOString(), taken_at: now - 3 * h, floor_price: null, collection_only: 0, pending: 1 },
  { item_id: "110591497965", title: "TEST Classic Strategy Board Game Complete", price: 12, currency: "GBP", watch_count: 5, view_count: 64, quantity_available: 1, start_time: new Date(now - 30 * 24 * h).toISOString(), taken_at: now - 3 * h, floor_price: 8, collection_only: 1, pending: 1 },
];

const activity = [
  { id: 6, at: now - 50 * 60_000, env: "sandbox", proposal_id: "x6", call: "ReviseFixedPriceItem", outcome: "applied", response: null, kind: "price", item_id: "110591497601" },
  { id: 5, at: now - 2 * h, env: "sandbox", proposal_id: "x5", call: "ReviseFixedPriceItem", outcome: "refused", response: "Writes are paused", kind: "price", item_id: "110591497599" },
  { id: 4, at: now - 9 * h, env: "sandbox", proposal_id: "x4", call: "AddFixedPriceItem", outcome: "applied", response: null, kind: "create_listing", item_id: null },
  { id: 3, at: now - 10 * h, env: "sandbox", proposal_id: "x3", call: "AddFixedPriceItem", outcome: "failed", response: "AddFixedPriceItem failed: If you wish to offer either flat or calculated postage, then you must select at least one domestic postage service.", kind: "create_listing", item_id: null },
];

const devices = [{ endpoint: "https://fcm.googleapis.com/fcm/send/abc", user_agent: "Mozilla/5.0 (Linux; Android 15) Chrome/141.0", created_at: now - 26 * h, last_ok_at: now - 2 * h, last_error: null }];

export function mockApi(): Plugin {
  return {
    name: "mock-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        const url = new URL(req.url, "http://x");
        let body: any = {};
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch {}
        }
        const send = (d: unknown, status = 200) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(d)); };
        const p = url.pathname.slice(4);
        if (process.env.MOCK === "signedout" && p !== "/login") return send({ error: "Sign in" }, 401);
        if (p === "/me") return send(me);
        if (p === "/login") return body.key === "demo" ? send({ ok: true }) : send({ error: "Wrong key" }, 401);
        if (p === "/proposals") return send(proposals.filter((x) => x.status === (url.searchParams.get("status") ?? "pending")));
        if (p === "/proposals/decide") {
          const results = (body.ids as string[]).map((id) => {
            const x = proposals.find((y) => y.id === id)!;
            x.status = body.decision === "approve" ? "applied" : "rejected";
            x.decided_at = Date.now();
            x.result = body.decision === "approve" ? "ReviseFixedPriceItem ok" : "Rejected";
            return { id, result: x.result };
          });
          return send({ results });
        }
        if (p === "/listings") return send(listings);
        if (p === "/listings/refresh") return send({ count: listings.length });
        if (p === "/activity") return send(activity);
        if (p === "/push/devices") return send(devices);
        if (p === "/metrics") {
          const days = (n: number, f: (i: number) => any) =>
            Array.from({ length: n }, (_, i) => ({ day: new Date(now - (n - 1 - i) * 24 * h).toISOString().slice(0, 10), ...f(i) }));
          const ago = (d: number) => new Date(now - d * 24 * h).toISOString().slice(0, 10);
          return send({
            listings: days(30, (i) => ({ active: 3 + Math.floor(i / 6), asking: 22.5 + Math.floor(i / 6) * 18 + (i % 5), watchers: 2 + Math.round(3 * Math.sin(i / 4) + i / 5) })),
            sales: [{ day: ago(3), orders: 1, revenue: 12.5, fees: 1.6 }, { day: ago(11), orders: 2, revenue: 31, fees: 3.9 }, { day: ago(19), orders: 1, revenue: 8.75, fees: 1.1 }],
            spend: days(30, (i) => ({ usd: i % 7 === 3 ? 0.42 : 0.01 + (i % 3) * 0.006, calls: 4 })),
            sold30: { items: 4, revenue: 52.25, fees: 6.6, sellThrough: 0.36 },
            avgDaysToSell: 17.4,
            proposals: { applied: 9, rejected: 2, pending: 4 },
            medianMinutesToDecide: 95,
            flags: [{ item_id: "110591497601", flag: "stale", detail: "Listed 34 days with no watchers.", title: "TEST White Ceramic Coffee Mug 350ml" }],
            lastNightly: { at: now - 5 * h, steps: { snapshot: "3 listings", orders: "0 orders", traffic: "failed: 500", health: "1 flagged", triage: "skipped" }, triaged: 0, proposals: 0 },
          });
        }
        if (p === "/usage") return send({ today: { usd: 0.04, calls: 6 }, month: { usd: 0.61, calls: 88 }, byJob: [{ job: "audit", calls: 40, usd: 0.52 }, { job: "triage", calls: 48, usd: 0.09 }], dailyBudgetUsd: 1, apiKeySet: false });
        if (p === "/audit") { await new Promise((r) => setTimeout(r, 600)); return send({ error: "ANTHROPIC_API_KEY is not set on this Worker yet." }, 503); }
        if (p === "/settings/writes") { me.writesPaused = Boolean(body.paused); (me as any).writesBlocked = me.writesPaused ? "Writes are paused" : null; return send({ writesPaused: me.writesPaused }); }
        return send({ ok: true });
      });
    },
  };
}
