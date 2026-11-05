// Dev-only stand-in for the Worker's /api, so the screens can be built and screenshotted without an account.
// Used by `MOCK=1 npm run dev:web`. Never bundled into the app.
import type { Plugin } from "vite";

const now = Date.now();
const h = 3_600_000;

const me = {
  user: { id: "u1", name: "K", role: "owner" },
  mustAddPasskey: false,
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
  { id: 6, at: now - 50 * 60_000, env: "sandbox", proposal_id: "x6", call: "ReviseFixedPriceItem", outcome: "applied", actor: "Sam", response: null, kind: "price", item_id: "110591497601" },
  { id: 5, at: now - 2 * h, env: "sandbox", proposal_id: "x5", call: "ReviseFixedPriceItem", outcome: "refused", response: "Writes are paused", kind: "price", item_id: "110591497599" },
  { id: 4, at: now - 9 * h, env: "sandbox", proposal_id: "x4", call: "AddFixedPriceItem", outcome: "applied", actor: "K", response: null, kind: "create_listing", item_id: null },
  { id: 3, at: now - 10 * h, env: "sandbox", proposal_id: "x3", call: "AddFixedPriceItem", outcome: "failed", response: "AddFixedPriceItem failed: If you wish to offer either flat or calculated postage, then you must select at least one domestic postage service.", kind: "create_listing", item_id: null },
];

// Inbox to-dos (src/todos.ts), sample data: one of each kind.
const todo = (id: string, kind: string, code: string, title: string, detail: string, extra: Record<string, unknown> = {}) => ({
  id: `todo:${id}`, code, kind, source: "audit", item_id: null, item_title: null, title, detail, question: null, status: "open",
  created_at: now - 2 * h, at: now - 2 * h, decided_at: null as number | null, decided_by: null as string | null, note: null as string | null, ...extra,
});
const todos = [
  todo("a1", "answer", "engine_question", "Answer the pricing engine's question", "Your answer is saved as a fact about this listing, then the engine prices it again.", { item_id: "178310678490", item_title: "Designer ceiling lights x2, brushed brass", question: 'What exactly is the "ceiling light" (brand and model)?' }),
  todo("a2", "answer", "measurements", "Add the measurements", "Missing: Item Width, Item Height, Item Depth. They're saved as facts, and Claude puts them in the item specifics on a label for you to approve.", { item_id: "178305367532", item_title: "Hemnes TV bench, white stain, 148 cm", question: "Measurements, for example: Width 110 cm, Height 44 cm, Weight 32 kg" }),
  todo("c1", "claude", "claude_review", "Let Claude improve this listing", "6 specifics found in published specs: Brand, Model, Colour, Material, Type, Style, from the published specifications for the IKEA Hemnes TV bench.\nThin description: 140 characters. Add condition, what's included and measurements if known.", { item_id: "178305367532", item_title: "Hemnes TV bench, white stain, 148 cm" }),
  todo("c2", "claude", "claude_review", "Let Claude improve this listing", "1 specifics found in published specs: Connectivity, from the published specifications for the Galaxy Buds 2 Pro.", { item_id: "178245985136", item_title: "Samsung Galaxy Buds 2 Pro Case" }),
  todo("y1", "you", "photos", "Add more photos", "4 photos now. More angles, the label or model number, and close-ups of any wear help it sell.", { item_id: "178310678490", item_title: "Designer ceiling lights x2, brushed brass" }),
  todo("y2", "you", "health", "Freshen this listing", "Listed 112 days with no watchers.\nOnly 0 views in the last 7 days.\nClaude: A clearer title with the brand and diameter should bring it into more searches.", { source: "nightly", item_id: "178310678490", item_title: "Designer ceiling lights x2, brushed brass" }),
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
        if (p === "/todos") return send(todos.filter((x) => x.status === (url.searchParams.get("status") ?? "open")));
        const todoAction = p.match(/^\/todos\/(todo:[\w-]+)\/(done|dismiss|answer|claude)$/);
        if (todoAction) {
          const x = todos.find((y) => y.id === todoAction[1]);
          if (!x || x.status !== "open") return send({ error: "Already dealt with" }, 409);
          await new Promise((r) => setTimeout(r, 400));
          const note = { answer: "Saved. The engine is pricing it again; you'll get a notification.", claude: "Claude is reviewing it. Its changes arrive as labels to approve.", done: null, dismiss: null }[todoAction[2] as "done"];
          Object.assign(x, { status: todoAction[2] === "dismiss" ? "dismissed" : "done", decided_at: Date.now(), decided_by: "K", note });
          return send({ ok: true, note: note ?? undefined });
        }
        if (p === "/listings") return send(listings);
        if (p === "/listings/refresh") return send({ count: listings.length });
        if (p === "/activity") return send(activity);
        if (p === "/push/devices") return send(devices);
        if (p === "/people") return send({ people: [{ id: "u1", name: "K", role: "owner", created_at: now - 3 * 24 * h, passkeys: [{ id: "c1", label: "Android phone", last_used_at: now - h }, { id: "c2", label: "Windows computer", last_used_at: now - 26 * h }] }, { id: "u2", name: "Sam", role: "manager", created_at: now - 2 * 24 * h, passkeys: [{ id: "c3", label: "iPhone or iPad", last_used_at: now - 5 * h }] }], invites: [{ name: "Alex", expires_at: now + 20 * h }], max: 3 });
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
        if (p === "/firstday") return send({ report: mockReport });
        if (/^\/items\/\d+\/settings$/.test(p)) return send({ floorPrice: 55, notes: "Width 110 cm" });
        if (p === "/firstday/run") { await new Promise((r) => setTimeout(r, 800)); return send({ report: { ...mockReport, at: Date.now() } }); }
        if (p === "/style" && req.method === "GET") return send({ style: mockStyle });
        if (p === "/style") { Object.assign(mockStyle, body.style, { editedBy: "K", at: Date.now() }); return send({ style: mockStyle }); }
        if (p === "/usage") return send({ today: { usd: 0.04, calls: 6 }, month: { usd: 0.61, calls: 88 }, byJob: [{ job: "audit", calls: 40, usd: 0.52 }, { job: "triage", calls: 48, usd: 0.09 }], dailyBudgetUsd: 1, apiKeySet: false });
        if (p === "/audit") { await new Promise((r) => setTimeout(r, 600)); return send({ error: "ANTHROPIC_API_KEY is not set on this Worker yet." }, 503); }
        if (p === "/settings/writes") { me.writesPaused = Boolean(body.paused); (me as any).writesBlocked = me.writesPaused ? "Writes are paused" : null; return send({ writesPaused: me.writesPaused }); }
        return send({ ok: true });
      });
    },
  };
}

// The first-day audit report and style guide (src/firstday.ts, src/style.ts), sample data.
const day = 86_400_000;
const mockStyle = {
  tone: "Warm and brief",
  length: "One or two sentences",
  greeting: "Hi there,",
  signOff: "Thanks, K",
  habits: ["British English", "Answers the question first", "No emoji"],
  phrasings: [
    { topic: "Postage", example: "I post within [n] working days by Royal Mail, tracked." },
    { topic: "Offers", example: "You're welcome to make an offer through the listing." },
  ],
  avoid: ["Agreeing prices in messages"],
  source: { replies: 14, from: "2025-11-20", to: "2026-10-30", learned: true },
  at: Date.now() - 2 * day,
  editedBy: null,
};
const finding = (severity: string, title: string, detail: string, fix: string, itemTitle: string | null = null, area = "listing") => ({ area, severity, title, detail, fix, itemTitle });
const mockReport = {
  at: Date.now() - 3 * 3_600_000,
  env: "production",
  seller: { userId: "k-sells", feedbackScore: 41, positivePercent: 100, businessType: "Private" },
  listings: [
    {
      itemId: "178305367532", title: "Samsung Galaxy Buds 2 Pro Case", url: null, price: 18.99, postage: 2.7, collectionOnly: false, listedDays: 113, watchers: 5, views7d: 2,
      photos: 3, specifics: 2, descriptionChars: 90,
      pricing: { strategy: "compete", price: 15.5, why: "A crowded market: 14 weeks of supply at the recent sales rate.", confidence: 0.55 },
      promotion: { action: "promote", rate: 2.5, why: "Saturated market and 113 days listed without a sale. A 2.5% general ad should cut the wait from about 60 to 48 days.", suggestedRate: 6.4 },
      findings: [finding("high", "Above the market by 23%", "Compete at £15.50.", "proposal"), finding("medium", "Short title", "Uses 31 of 80 characters.", "claude"), finding("medium", "Thin description", "90 characters.", "claude")],
    },
    {
      itemId: "178310678490", title: "Designer ceiling lights x2, brushed brass", url: null, price: 45, postage: null, collectionOnly: true, listedDays: 111, watchers: 0, views7d: 1,
      photos: 2, specifics: 1, descriptionChars: 0,
      pricing: { strategy: "ask", price: null, why: "", confidence: 0, question: "Which brand and model are the lights, and what diameter?" },
      promotion: null,
      findings: [finding("high", "No description", "Say what it is.", "claude"), finding("high", "2 photos", "Buyers want every side.", "you"), finding("medium", "Engine needs your answer", "Which brand and model are the lights?", "you")],
    },
  ],
  sold: {
    count: 23, revenue: 612.4, median: 21.5, first: "2025-03-08", last: "2026-09-27",
    byMonth: [{ month: "2025-03", sales: 4, revenue: 88 }, { month: "2025-06", sales: 6, revenue: 140.5 }, { month: "2026-01", sales: 7, revenue: 201.9 }, { month: "2026-09", sales: 6, revenue: 182 }],
    top: [{ title: "Sony WH-1000XM3 headphones", price: 95, date: "2026-01-14" }, { title: "Kindle Paperwhite 10th gen", price: 48, date: "2025-06-02" }],
    avgDaysToSell: 18.4, timedSales: 5, feeShare: null, askingVsSold: [],
  },
  unsold: [{ itemId: "1", title: "Phone case bundle", price: 9.99, days: 30, watchers: 3, views: 80, likely: "3 people watched it but nobody bought: the price was probably a little high." }],
  messages: { replies: 14, questionsAnswered: 9, note: "Learned from 14 of your past messages." },
  settings: {
    policies: {
      returns: [{ id: "r1", name: "Returns accepted", accepted: true, periodDays: 30, buyerPaysReturnPostage: true }],
      postage: [{ id: "f1", name: "Royal Mail 2nd", handlingDays: 2, services: [{ service: "UK_RoyalMailSecondClassStandard", cost: 2.7, free: false }], collection: false }],
      payment: [{ id: "p1", name: "eBay payments" }],
    },
    note: "1 return, 1 postage and 1 payment policies.",
  },
  findings: [
    finding("high", "Above the market by 23%", "Compete at £15.50: a crowded market.", "proposal", "Samsung Galaxy Buds 2 Pro Case"),
    finding("high", "No description", "Say what it is, its condition in plain words, and what's included.", "claude", "Designer ceiling lights x2, brushed brass"),
    finding("high", "2 photos", "Buyers want every side, labels and any flaws. eBay allows 24.", "you", "Designer ceiling lights x2, brushed brass"),
    finding("medium", "Promote at 2.5%", "Saturated market and 113 days listed without a sale.", "proposal", "Samsung Galaxy Buds 2 Pro Case", "promotion"),
    finding("medium", "Ended unsold: Phone case bundle", "3 people watched it but nobody bought: the price was probably a little high.", "you", "Phone case bundle", "unsold"),
  ],
  proposals: [{ id: "x", kind: "price", itemId: "178305367532" }, { id: "y", kind: "promote", itemId: "178305367532" }],
  forClaude: ["178305367532", "178310678490"],
  steps: { snapshot: "4 listings", listings: "4 read in full", prices: "2 priced, 1 proposed, 1 need your answer", promotion: "4 checked, 1 proposed", messages: "9 answered questions, 5 sent messages", style: "learned from 14 replies", policies: "1 return, 1 postage and 1 payment policies." },
};
