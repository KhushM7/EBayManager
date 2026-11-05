import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import type { MessagesApi } from "../src/claude";
import { memoryPhotoStore } from "../src/photos";
import { withEbayTokens } from "./fixtures";
import {
  choosePrice,
  cleanFacts,
  cleanReview,
  composeDraft,
  COMPOSE_SYSTEM,
  descriptionHtml,
  factsText,
  missingSteps,
  priceDraft,
  reopenDraft,
  REVIEW_SYSTEM,
  reviewDraft,
  saveFacts,
  savePostage,
  sourcedSpecifics,
  submitDraft,
} from "../src/newlisting";
import { decide } from "../src/proposals";
import { cheapestSimpleDelivery, simpleDeliveryCarrier } from "../src/postage";

// Add Listing, steps L2 to L5 (docs/add-listing.md), with Claude and eBay stood in for.

const aspects = [
  { name: "Brand", required: true, values: ["Dyson", "Shark"], selectionOnly: false, multiple: false },
  { name: "Model", required: false, values: [], selectionOnly: false, multiple: false },
  { name: "Type", required: false, values: ["Upright", "Cylinder"], selectionOnly: true, multiple: false },
  { name: "Colour", required: false, values: [], selectionOnly: false, multiple: false },
  { name: "Item Weight", required: false, values: [], selectionOnly: false, multiple: false },
];

describe("keeping only sourced facts", () => {
  const ctx = {
    aspects,
    visibleFacts: [{ fact: "Dyson logo and 'Cinetic Big Ball Animal' on the body", photo: 1 }, { fact: "Grey and purple body", photo: 2 }],
    flaws: [{ text: "Split in the hose", photo: 3 }],
    fromK: "Condition: For parts or not working\nWorking: Motor and suction work; the hose is split",
    specs: [{ name: "Item Weight", value: "7.3 kg", source: "https://www.dyson.co.uk/spec" }],
  };

  it("keeps a value found in its photo, K's facts or a spec page, and drops the rest with the reason", () => {
    const { kept, dropped } = sourcedSpecifics(
      [
        { name: "Brand", values: ["Dyson"], source: "photo", ref: "1" },
        { name: "Model", values: ["Cinetic Big Ball Animal"], source: "photo", ref: "1" },
        { name: "Type", values: ["upright"], source: "you", ref: "you" },
        { name: "Colour", values: ["Grey"], source: "photo", ref: "2" },
        { name: "Item Weight", values: ["7.3 kg"], source: "spec", ref: "https://www.dyson.co.uk/spec" },
        { name: "Colour", values: ["Red"], source: "photo", ref: "2" },
        { name: "Item Weight", values: ["8 kg"], source: "spec", ref: "https://www.dyson.co.uk/spec" },
        { name: "Power", values: ["1300 W"], source: "you", ref: "you" },
      ],
      ctx,
    );
    expect(kept.map((s) => `${s.name}=${s.values.join("|")}@${s.source}`)).toEqual([
      "Brand=Dyson@photo",
      "Model=Cinetic Big Ball Animal@photo",
      "Colour=Grey@photo",
      "Item Weight=7.3 kg@spec",
    ]);
    // "upright" is one of eBay's values, but K never said it: dropped.
    expect(dropped).toEqual([
      "Type: the value isn't in its source (you)",
      "Colour: the value isn't in its source (photo 2)",
      "Item Weight: the value isn't in its source (spec https://www.dyson.co.uk/spec)",
      "Power: not an item specific for this category",
    ]);
  });

  it("uses eBay's own spelling for selection-only values, and refuses values eBay doesn't offer", () => {
    const fromK = "It's an upright vacuum";
    const { kept, dropped } = sourcedSpecifics(
      [
        { name: "Type", values: ["upright"], source: "you", ref: "you" },
        { name: "Type", values: ["Handheld"], source: "you", ref: "you" },
      ],
      { ...ctx, fromK },
    );
    expect(kept).toEqual([{ name: "Type", values: ["Upright"], source: "you", ref: "you" }]);
    expect(dropped).toEqual(["Type: not one of eBay's values for it"]);
  });
});

describe("the review and K's facts", () => {
  it("keeps the review within bounds and only calls it exact with a brand and model", () => {
    const r = cleanReview(
      { product: "Dyson vacuum", exact: true, brand: "Dyson", model: "", group: "vacuums", condition: "broken", visibleFacts: [{ fact: "label", photo: 9 }], flaws: [], missingShots: [], photoNotes: [], questions: [{ id: "Works?", question: "Does it work?", why: "x" }, { id: "works", question: "dup", why: "" }] },
      3,
      1,
    );
    expect(r).toMatchObject({ exact: false, condition: "unknown", visibleFacts: [{ fact: "label", photo: 3 }], questions: [{ id: "works_", question: "Does it work?", why: "x" }, { id: "works" }] });
  });

  it("keeps K's answers only to the questions asked, condition always K's", () => {
    const review = cleanReview({ product: "x", questions: [{ id: "works", question: "Does it work?", why: "" }] }, 1, 1);
    const f = cleanFacts({ condition: "parts", works: " Motor works ", answers: { works: "Yes, tested", sneaky: "x" } }, review);
    expect(f).toMatchObject({ condition: "parts", works: "Motor works", answers: { works: "Yes, tested" } });
    expect(factsText(f, review)).toBe("Condition: For parts or not working\nWorking: Motor works\nDoes it work? Yes, tested");
    expect(cleanFacts({ condition: "excellent" }, review).condition).toBeNull();
  });

  it("writes the description as safe HTML", () => {
    expect(descriptionHtml("Used, works.\n\nIncludes <tools> & hose\nline two")).toBe("<p>Used, works.</p>\n<p>Includes &lt;tools&gt; &amp; hose<br>line two</p>");
  });
});

describe("postage", () => {
  it("keeps eBay's Simple Delivery carriers only, cheapest first", () => {
    expect(simpleDeliveryCarrier("Royal Mail Tracked 48")).toBe("Royal Mail");
    expect(simpleDeliveryCarrier("Evri Standard")).toBe("Evri");
    expect(simpleDeliveryCarrier("DPD Next Day")).toBeNull();
    expect(
      cheapestSimpleDelivery([
        { carrier: "DPD", service: "Next Day", price: 5 },
        { carrier: "Royal Mail", service: "Tracked 48", price: 7.99 },
        { carrier: "InPost", service: "Locker to Locker", price: 4.19 },
        { carrier: "Evri", service: "Standard", price: 4.99 },
      ]).map((q) => `${q.carrier} ${q.price}`),
    ).toEqual(["InPost 4.19", "Evri 4.99", "Royal Mail 7.99"]);
  });
});

/** A minimal JPEG of w×h. */
function jpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 1, 2, 0xff, 0xd9]);
}

/** Claude stand-in: answers each job by its system prompt; records what it was shown. */
function fakeClaude() {
  const seen: { system: string; images: number }[] = [];
  const api: MessagesApi = {
    async create(params: any) {
      const system = params.system[0].text as string;
      const content = params.messages[0].content;
      seen.push({ system, images: Array.isArray(content) ? content.filter((b: any) => b.type === "image").length : 0 });
      const answer =
        system === REVIEW_SYSTEM
          ? {
              product: "Dyson Cinetic Big Ball Animal upright vacuum",
              exact: false,
              brand: "Dyson",
              model: "Cinetic Big Ball Animal",
              group: "vacuum cleaners",
              condition: "parts",
              visibleFacts: [{ fact: "Dyson Cinetic Big Ball Animal on the body", photo: 1 }],
              flaws: [{ text: "Split hose", photo: 1 }],
              missingShots: [{ shot: "The rating plate underneath", why: "Buyers check the model number" }],
              photoNotes: [],
              questions: [{ id: "works", question: "Does the motor run?", why: "Spares buyers need to know" }],
            }
          : system === COMPOSE_SYSTEM
            ? {
                title: "Dyson Cinetic Big Ball Animal Upright Vacuum Spares or Repair Split Hose",
                description: "For parts: the hose is split.\n\nMotor runs.",
                specifics: [
                  { name: "Brand", values: ["Dyson"], source: "photo", ref: "1" },
                  { name: "Colour", values: ["Purple"], source: "photo", ref: "1" },
                ],
              }
            : /identify an item/.test(system)
              ? { product: "Dyson Cinetic Big Ball Animal", group: "vacuum cleaners", condition: "parts", fault: "minor", keyFacts: [], components: [{ name: "Dyson Cinetic Big Ball Animal", query: "Dyson Cinetic Big Ball Animal", valued: true }], priceable: true, question: null }
              : { exact: [], close: [] };
      return {
        id: "m",
        type: "message",
        role: "assistant",
        model: "x",
        content: [{ type: "text", text: JSON.stringify(answer) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
  return { api, seen };
}

describe("a new listing, end to end", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("goes from photos to a label, and on approval uploads the photos and lists the item", async () => {
    const calls: { call: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("get_category_suggestions"))
          return Response.json({ categorySuggestions: [{ category: { categoryId: "20614", categoryName: "Vacuum Cleaners" }, categoryTreeNodeAncestors: [{ categoryName: "Vacuum Cleaners & Parts" }, { categoryName: "Home, Furniture & DIY" }] }] });
        if (u.includes("get_item_aspects_for_category"))
          return Response.json({ aspects: aspects.map((a) => ({ localizedAspectName: a.name, aspectConstraint: { aspectRequired: a.required, aspectUsage: "RECOMMENDED", aspectMode: a.selectionOnly ? "SELECTION_ONLY" : "FREE_TEXT" }, aspectValues: a.values.map((v) => ({ localizedValue: v })) })) });
        if (u.includes("/identity/v1/oauth2/token")) return Response.json({ access_token: "app", expires_in: 7200 });
        if (u.includes("item_summary/search")) return Response.json({ itemSummaries: [], total: 0 });
        if (u.includes("/ws/api.dll")) {
          const call = String((init?.headers as any)?.["X-EBAY-API-CALL-NAME"]);
          const body = init?.body instanceof Uint8Array ? new TextDecoder().decode((init.body as Uint8Array).slice(0, 2000)) : String(init?.body ?? "");
          calls.push({ call, body });
          const reply =
            call === "VerifyAddFixedPriceItem"
              ? "<Ack>Success</Ack><Fees><Fee><Name>InsertionFee</Name><Fee>0.0</Fee></Fee></Fees>"
              : call === "UploadSiteHostedPictures"
                ? `<Ack>Success</Ack><SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/images/${calls.length}.jpg</FullURL></SiteHostedPictureDetails>`
                : call === "AddFixedPriceItem"
                  ? "<Ack>Success</Ack><ItemID>110599999999</ItemID>"
                  : "<Ack>Success</Ack>";
          return new Response(`<?xml version="1.0"?><${call}Response xmlns="urn:ebay:apis:eBLBaseComponents">${reply}</${call}Response>`);
        }
        return new Response("not stubbed", { status: 500 });
      }),
    );
    const photos = memoryPhotoStore();
    const env = { store: memoryStore(), photos, EBAY_ENV: "sandbox", WRITE_MODE: "approval", EBAY_SITE_ID: "3", EBAY_MARKETPLACE: "EBAY_GB", EBAY_APP_ID: "a", EBAY_CERT_ID: "c", SIGNING_KEY: "k", PUBLIC_URL: "https://test.example", ANTHROPIC_API_KEY: "test" } as unknown as Env;
    await withEbayTokens(env.store);
    const { api, seen } = fakeClaude();

    // L1: a draft with two photos.
    const d0 = await env.store.drafts.create("K", Date.now());
    for (const [i, p] of [jpeg(2400, 1800), jpeg(1800, 2400)].entries()) {
      await photos.put(`drafts/${d0.id}/p${i}.jpg`, p, "image/jpeg");
      await env.store.drafts.addPhoto(d0.id, { id: `p${i}`, key: `drafts/${d0.id}/p${i}.jpg`, width: 2400, height: 1800, bytes: p.length, issues: [], hash: null, added_at: Date.now() }, 24, Date.now());
    }
    expect(missingSteps((await env.store.drafts.get(d0.id))!)[0]).toBe("Check the photos.");

    // L2: Claude sees both photos as image data; eBay suggests the category; the question for K.
    const reviewed = await reviewDraft(env, d0.id, api);
    expect(seen[0]).toMatchObject({ system: REVIEW_SYSTEM, images: 2 });
    expect(reviewed.review).toMatchObject({ brand: "Dyson", questions: [{ id: "works" }], missingShots: [{ shot: "The rating plate underneath" }] });
    expect(reviewed.category).toEqual({ id: "20614", name: "Vacuum Cleaners", path: "Home, Furniture & DIY > Vacuum Cleaners & Parts" });
    expect(reviewed.aspects?.map((a) => a.name)).toContain("Brand");

    await expect(composeDraft(env, d0.id, api)).rejects.toThrow(/condition/);
    await saveFacts(env, d0.id, { condition: "parts", works: "Motor runs, the hose is split", answers: { works: "Yes, it runs" } });

    // L3: the listing text; the unsourced colour is dropped.
    const composed = await composeDraft(env, d0.id, api);
    expect(composed.listing).toMatchObject({ title: "Dyson Cinetic Big Ball Animal Upright Vacuum Spares or Repair Split Hose", specifics: [{ name: "Brand", values: ["Dyson"], source: "photo" }] });
    expect(composed.listing!.dropped).toEqual(["Colour: the value isn't in its source (photo 1)"]);

    // L4: no sold-data providers here, so nothing comparable: K's own price is allowed; any other is not.
    const priced = await priceDraft(env, d0.id, api);
    expect(priced.pricing).toMatchObject({ strategy: "ask", reason: "no_sales" });
    await expect(choosePrice(env, d0.id, { value: 30, floor: 40 })).rejects.toThrow(/floor/);
    expect((await choosePrice(env, d0.id, { value: 29.99, floor: 20 })).price).toEqual({ value: 29.99, kind: "own", floor: 20, bestOffer: true });
    await expect(savePostage(env, d0.id, { cost: 18, postcode: "not a postcode" })).rejects.toThrow(/postcode/);
    await savePostage(env, d0.id, { cost: 18, collectionOffered: true, postcode: "sw1a 1aa" });
    expect(await env.store.kv.get("seller_postcode")).toBe("SW1A 1AA");

    // L5: eBay's check, then a label; the draft is locked while it waits.
    const ready = (await env.store.drafts.get(d0.id))!;
    expect(missingSteps(ready)).toEqual([]);
    const { draft: submitted, note } = await submitDraft(env, d0.id);
    expect(note).toMatch(/Sent for approval/);
    expect(submitted.status).toBe("submitted");
    expect(calls.map((c) => c.call)).toEqual(["VerifyAddFixedPriceItem"]);
    await expect(reopenDraft(env, d0.id)).rejects.toThrow(/still waiting/);
    const label = (await env.store.proposals.get(submitted.proposal_id!))!;
    expect(label).toMatchObject({ kind: "create_listing", status: "pending" });
    expect(JSON.parse(label.payload)).toMatchObject({ price: 29.99, conditionId: "7000", collectionOffered: true, photoKeys: [`drafts/${d0.id}/p0.jpg`, `drafts/${d0.id}/p1.jpg`] });

    // Approval: the gate uploads both photos, then lists the item with eBay's picture addresses.
    const result = await decide(env, label.id, "approve", "K");
    expect(result).toMatch(/AddFixedPriceItem ok, item 110599999999/);
    // (After an approved change the app re-reads its listings: a read, left out here.)
    const writes = calls.filter((c) => c.call !== "GetMyeBaySelling");
    expect(writes.map((c) => c.call)).toEqual(["VerifyAddFixedPriceItem", "UploadSiteHostedPictures", "UploadSiteHostedPictures", "AddFixedPriceItem"]);
    expect(writes[1].body).toMatch(/name="XML Payload"[\s\S]*<PictureName>photo-1<\/PictureName>[\s\S]*filename="photo-1\.jpg"/);
    const add = writes[3].body;
    expect(add).toMatch(/<PictureURL>https:\/\/i\.ebayimg\.com\/images\/2\.jpg<\/PictureURL><PictureURL>https:\/\/i\.ebayimg\.com\/images\/3\.jpg<\/PictureURL>/);
    expect(add).toContain("<ShippingService>UK_CollectInPerson</ShippingService>");
    expect(add).toContain("<ConditionID>7000</ConditionID>");
    expect(add).toContain("<Name>Brand</Name><Value>Dyson</Value>");
    expect((await env.store.drafts.get(d0.id))!).toMatchObject({ status: "published", item_id: "110599999999" });
    const log = await env.store.audit.recent(10);
    expect(log.map((a) => `${a.call}:${a.outcome}`).sort()).toEqual(["AddFixedPriceItem:applied", "UploadSiteHostedPictures:applied", "UploadSiteHostedPictures:applied"]);
  });

  it("never publishes while changes are off: the label is a dry run and nothing reaches eBay", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        calls.push(String((init?.headers as any)?.["X-EBAY-API-CALL-NAME"] ?? "rest"));
        return new Response(`<?xml version="1.0"?><VerifyAddFixedPriceItemResponse><Ack>Success</Ack></VerifyAddFixedPriceItemResponse>`);
      }),
    );
    const photos = memoryPhotoStore();
    const env = { store: memoryStore(), photos, EBAY_ENV: "production", WRITE_MODE: "off", EBAY_SITE_ID: "3", SIGNING_KEY: "k", PUBLIC_URL: "https://test.example" } as unknown as Env;
    await withEbayTokens(env.store);
    const d = await env.store.drafts.create("K", Date.now());
    await env.store.drafts.addPhoto(d.id, { id: "p", key: "k", width: 2400, height: 1800, bytes: 1, issues: [], hash: null, added_at: 1 }, 24, 1);
    await env.store.drafts.patch(
      d.id,
      {
        review: cleanReview({ product: "x" }, 1, 1),
        facts: cleanFacts({ condition: "used" }, null),
        category: { id: "1", name: "Thing", path: "" },
        aspects: [],
        listing: { title: "Thing", description: "Used.", specifics: [], dropped: [], at: 1, editedByK: false },
        price: { value: 10, kind: "own", floor: null, bestOffer: true },
        postage: { cost: 3, carrier: null, service: null, source: "you", collectionOffered: false, collectionOnly: false, postcode: "SW1A 1AA" },
      },
      1,
    );
    const { draft } = await submitDraft(env, d.id);
    const label = (await env.store.proposals.get(draft.proposal_id!))!;
    expect(label.dry_run).toBe(1);
    expect(await decide(env, label.id, "approve", "K")).toMatch(/Dry run/);
    expect(calls).toEqual(["VerifyAddFixedPriceItem"]);
    // Recorded as a dry run, so the draft can go back to editing.
    expect((await reopenDraft(env, d.id)).status).toBe("open");
  });
});
