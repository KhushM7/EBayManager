// Dev-only: under `MOCK=1 npm run dev:web`, the New listing wizard talks to the REAL drafts server code
// (src/drafts.ts, src/newlisting.ts, the pricing engine, the proposals and the write gate), running in this
// Vite process on the in-memory store, with stand-ins only at the edges: Claude, eBay, Trawl and Parcel2Go.
// So the screens are exercised against the server's real routes, replies and errors, not a hand-written copy.
// Never bundled into the app.
//
// The stand-ins replace globalThis.fetch for those hosts only, inside this dev server. Real photos from the
// browser are stored in memory and served back; nothing leaves the machine.

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const H = 3_600_000;

interface Real {
  env: any;
  handleDrafts: (env: any, req: Request, url: URL, path: string, user: { name: string }) => Promise<Response | null>;
  decide: (env: any, id: string, decision: "approve" | "reject", by: string) => Promise<string>;
}
let real: Promise<Real> | null = null;

/** The photo check's and the listing writer's system prompts (src/newlisting.ts), to tell the jobs apart. */
const prompts = { review: "", compose: "" };

/** Claude's answers, chosen by the job's system prompt (the same shapes the tests use). */
function claudeAnswer(system: string, images: number): unknown {
  if (prompts.review && system.includes(prompts.review))
    return {
      product: "Sony WH-1000XM4 wireless noise-cancelling headphones, black",
      exact: images >= 2,
      brand: "Sony",
      model: "WH-1000XM4",
      group: "headphones",
      condition: "used",
      visibleFacts: [
        { fact: "SONY logo and \"WH-1000XM4\" printed on the headband", photo: 1 },
        { fact: "Black finish", photo: 1 },
      ],
      flaws: images >= 2 ? [{ text: "Light scuff on the left ear cup", photo: 2 }] : [],
      missingShots: [{ shot: "The model label inside the headband", why: "Buyers check it's an XM4, not an XM3" }],
      photoNotes: images >= 2 ? [{ photo: 2, note: "A little dark: the scuff is hard to see." }] : [],
      questions: [{ id: "battery", question: "How long does the battery last on a full charge?", why: "Battery wear is the first thing buyers ask about" }],
    };
  if (prompts.compose && system.includes(prompts.compose))
    return {
      title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones Black",
      description: "Used, in good working order. Light scuff on the left ear cup (photo 2).\n\nNoise cancelling and Bluetooth both work. Comes with the carry case and USB-C cable.",
      specifics: [
        { name: "Brand", values: ["Sony"], source: "photo", ref: "1" },
        { name: "Model", values: ["WH-1000XM4"], source: "photo", ref: "1" },
        { name: "Colour", values: ["Black"], source: "photo", ref: "1" },
        { name: "Connectivity", values: ["Bluetooth"], source: "you", ref: "you" },
      ],
    };
  if (/identify an item/i.test(system))
    return { product: "Sony WH-1000XM4", group: "headphones", condition: "used", fault: "none", keyFacts: [], components: [{ name: "Sony WH-1000XM4", query: "Sony WH-1000XM4", valued: true }], priceable: true, question: null };
  if (/exact/.test(system) && /close/.test(system)) return { exact: Array.from({ length: 30 }, (_, i) => i + 1), close: [] };
  return {};
}

const message = (answer: unknown) =>
  Response.json({
    id: "mock",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: JSON.stringify(answer) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

const ASPECTS = [
  { name: "Brand", required: true, values: ["Sony", "Bose", "Apple"], selectionOnly: false },
  { name: "Model", required: true, values: [], selectionOnly: false },
  { name: "Colour", required: false, values: ["Black", "Silver", "Blue"], selectionOnly: false },
  { name: "Connectivity", required: false, values: ["Bluetooth", "Wired"], selectionOnly: true },
  { name: "Form Factor", required: false, values: ["Over-Ear", "On-Ear", "In-Ear"], selectionOnly: true },
];

let itemNo = 110_599_000_000;

/** The stand-ins for every outside service the drafts server calls. */
function standIns(realFetch: typeof fetch): typeof fetch {
  return async (input: any, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (u.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const system = Array.isArray(body.system) ? body.system.map((s: any) => s.text).join("\n") : String(body.system ?? "");
      const content = body.messages?.[0]?.content;
      const images = Array.isArray(content) ? content.filter((b: any) => b.type === "image").length : 0;
      await wait(1500);
      return message(claudeAnswer(system, images));
    }
    if (u.includes("ebay.com")) {
      if (u.includes("/identity/v1/oauth2/token")) return Response.json({ access_token: "app", expires_in: 7200 });
      if (u.includes("get_category_suggestions"))
        return Response.json({
          categorySuggestions: [
            { category: { categoryId: "112529", categoryName: "Headphones" }, categoryTreeNodeAncestors: [{ categoryName: "Portable Audio & Headphones" }, { categoryName: "Sound & Vision" }] },
            { category: { categoryId: "80077", categoryName: "Headphone Cases" }, categoryTreeNodeAncestors: [{ categoryName: "Headphone Accessories" }] },
          ],
        });
      if (u.includes("get_item_aspects_for_category"))
        return Response.json({ aspects: ASPECTS.map((a) => ({ localizedAspectName: a.name, aspectConstraint: { aspectRequired: a.required, aspectUsage: "RECOMMENDED", aspectMode: a.selectionOnly ? "SELECTION_ONLY" : "FREE_TEXT" }, aspectValues: a.values.map((v) => ({ localizedValue: v })) })) });
      if (u.includes("item_summary/search")) return Response.json({ itemSummaries: [], total: 0 });
      if (u.includes("/ws/api.dll")) {
        const call = String((init?.headers as any)?.["X-EBAY-API-CALL-NAME"]);
        await wait(call === "VerifyAddFixedPriceItem" ? 900 : 300);
        const reply =
          call === "VerifyAddFixedPriceItem"
            ? "<Ack>Success</Ack><Fees><Fee><Name>InsertionFee</Name><Fee>0.0</Fee></Fee></Fees>"
            : call === "UploadSiteHostedPictures"
              ? `<Ack>Success</Ack><SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/images/mock-${Date.now()}.jpg</FullURL></SiteHostedPictureDetails>`
              : call === "AddFixedPriceItem"
                ? `<Ack>Success</Ack><ItemID>${++itemNo}</ItemID>`
                : "<Ack>Success</Ack>";
        return new Response(`<?xml version="1.0"?><${call}Response xmlns="urn:ebay:apis:eBLBaseComponents">${reply}</${call}Response>`);
      }
      return Response.json({});
    }
    if (u.startsWith("https://api.trawl.dev/")) {
      // Eight recent sales of the same headphones, so the engine has a market to price from.
      const day = 86_400_000;
      const prices = [118, 124, 129, 115, 132, 121, 127, 119];
      return Response.json({
        currency: "GBP",
        credits_charged: 1,
        results: prices.map((p, i) => ({ title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones Black", sale_price: p, shipping_price: 0, condition: "Used", date_sold: new Date(Date.now() - (i * 6 + 2) * day).toISOString().slice(0, 10), buying_format: "Fixed price", item_link: `https://www.ebay.co.uk/itm/${2_000 + i}` })),
      });
    }
    if (u.includes("parcel2go.com")) return Response.json({ error: "stand-in" }, { status: 503 });
    return realFetch(input, init);
  };
}

async function load(server: ViteDevServer): Promise<Real> {
  const mod = (p: string) => server.ssrLoadModule(path.join(root, p));
  globalThis.fetch = standIns(globalThis.fetch.bind(globalThis));
  const [{ memoryStore }, { memoryPhotoStore }, drafts, proposals, newlisting] = await Promise.all([mod("src/store/index.ts"), mod("src/photos.ts"), mod("src/drafts.ts"), mod("src/proposals.ts"), mod("src/newlisting.ts")]);
  prompts.review = newlisting.REVIEW_SYSTEM;
  prompts.compose = newlisting.COMPOSE_SYSTEM;
  const store = memoryStore();
  await store.kv.saveEbayTokens({ access_token: "t", access_expires_at: Date.now() + 24 * H, refresh_token: "r", refresh_expires_at: Date.now() + 24 * H, scopes: "full" });
  const env = {
    store,
    photos: memoryPhotoStore(),
    EBAY_ENV: "sandbox",
    WRITE_MODE: "approval",
    EBAY_SITE_ID: "3",
    EBAY_MARKETPLACE: "EBAY_GB",
    EBAY_APP_ID: "mock",
    EBAY_CERT_ID: "mock",
    EBAY_DEV_ID: "mock",
    SIGNING_KEY: "mock-signing-key",
    PUBLIC_URL: "http://localhost:5173",
    ANTHROPIC_API_KEY: "mock",
    TRAWL_API_KEY: "mock",
  };
  return { env, handleDrafts: drafts.handleDrafts, decide: proposals.decide };
}

/**
 * Answers /api/drafts/* with the real server, and lets labels it files (create_listing) appear in the sample
 * Inbox and be decided there, through the real proposals code and write gate. Returns true if it answered.
 */
export async function draftsMock(server: ViteDevServer, req: any, res: any, raw: Buffer, sample: { proposals: any[] }): Promise<boolean> {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname.slice(4);
  const isDrafts = p.startsWith("/drafts");
  const isInbox = p === "/proposals" || p === "/proposals/decide";
  if (!isDrafts && !isInbox) return false;
  real ??= load(server);
  const { env, handleDrafts, decide } = await real;
  const reply = async (r: Response) => {
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await r.arrayBuffer()));
  };

  if (isDrafts) {
    const request = new Request(url, { method: req.method, headers: { "Content-Type": String(req.headers["content-type"] ?? "") }, body: req.method === "POST" ? new Uint8Array(raw) : undefined });
    const out = await handleDrafts(env, request, url, p, { name: "K" });
    await reply(out ?? Response.json({ error: "Not found" }, { status: 404 }));
    return true;
  }

  // The Inbox: the sample labels, plus the real ones the drafts server filed.
  const status = url.searchParams.get("status") ?? "pending";
  if (p === "/proposals" && req.method === "GET") {
    const rows = await env.store.proposals.listByStatus(status, "desc", 200);
    const mine = rows.map((r: any) => ({ ...r, item_title: null, item_price: null, payload: JSON.parse(r.payload) }));
    await reply(Response.json([...mine, ...sample.proposals.filter((x) => x.status === status)]));
    return true;
  }
  const body = JSON.parse(raw.toString() || "{}");
  const results: { id: string; result: string }[] = [];
  for (const id of body.ids as string[]) {
    if (await env.store.proposals.get(id)) results.push({ id, result: await decide(env, id, body.decision, "K").catch((e: Error) => e.message) });
    else {
      const x = sample.proposals.find((y) => y.id === id);
      if (!x) continue;
      x.status = body.decision === "approve" ? "applied" : "rejected";
      x.decided_at = Date.now();
      x.result = body.decision === "approve" ? "ReviseFixedPriceItem ok" : "Rejected";
      results.push({ id, result: x.result });
    }
  }
  await reply(Response.json({ results }));
  return true;
}
