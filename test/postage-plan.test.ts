import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import type { MessagesApi } from "../src/claude";
import { memoryPhotoStore } from "../src/photos";
import { cleanFacts, cleanReview, listingPayload, PARCEL_SYSTEM, planPostage, roundedParcel, savePostage } from "../src/newlisting";
import { fitsSize, PARCEL_SIZES, recommendSize, sizeByCode, sizeName } from "../src/postage";

// Postage done for K (2026-11-06): the packed parcel worked out, the Simple Delivery size from eBay's own list
// (K's screenshot), a courier quote for what Simple Delivery can't take, and the postage filled in.

const sizeOf = (l: number, w: number, h: number, kg: number) => recommendSize({ lengthCm: l, widthCm: w, heightCm: h, weightKg: kg })?.code ?? null;

describe("choosing the Simple Delivery size", () => {
  it("has eBay's seven options, in eBay's order", () => {
    expect(PARCEL_SIZES.map(sizeName)).toEqual([
      "Large letter, up to 1 kg",
      "Small parcel, up to 1 kg",
      "Small parcel, up to 2 kg",
      "Medium parcel, up to 1 kg",
      "Medium parcel, up to 2 kg",
      "Medium parcel, up to 10 kg",
      "Medium parcel, up to 20 kg",
    ]);
  });

  it("picks the smallest size the packed parcel fits", () => {
    expect(sizeOf(30, 22, 2, 0.3)).toBe("large_letter_1kg"); // a top in a mailing bag
    expect(sizeOf(25, 18, 4, 0.5)).toBe("small_parcel_1kg"); // a hardback: too thick for a large letter
    expect(sizeOf(42, 33, 30, 4.4)).toBe("medium_parcel_10kg"); // the boxed air fryer: what eBay recommended to K
    expect(sizeOf(60, 45, 40, 14)).toBe("medium_parcel_20kg");
  });

  it("compares the longest side with the longest limit, however it's measured", () => {
    expect(fitsSize({ lengthCm: 16, widthCm: 45, heightCm: 35, weightKg: 1.5 }, sizeByCode("small_parcel_2kg")!)).toBe(true);
  });

  it("errs larger on weight: 5% under a band's limit", () => {
    expect(sizeOf(40, 30, 10, 1.9)).toBe("small_parcel_2kg");
    expect(sizeOf(40, 30, 10, 1.95)).toBe("medium_parcel_10kg"); // 1.95 kg + 5% is over 2 kg
  });

  it("needs a courier when it's bigger than a medium parcel or over 20 kg", () => {
    expect(sizeOf(70, 40, 40, 8)).toBeNull(); // a boxed upright vacuum
    expect(sizeOf(50, 40, 40, 19.5)).toBeNull();
  });

  it("rounds a parcel up, never down", () => {
    expect(roundedParcel({ lengthCm: 41.2, widthCm: 32, heightCm: 29.01, weightKg: 4.32 })).toEqual({ lengthCm: 42, widthCm: 32, heightCm: 30, weightKg: 4.4 });
    expect(roundedParcel({ lengthCm: 0, widthCm: 1, heightCm: 1, weightKg: 1 })).toBeNull();
  });
});

function fakeClaude(answer: unknown) {
  const prompts: string[] = [];
  const api: MessagesApi = {
    async create(params: any) {
      expect(params.system[0].text).toBe(PARCEL_SYSTEM);
      prompts.push(params.messages[0].content);
      return {
        id: "m", type: "message", role: "assistant", model: "x",
        content: [{ type: "text", text: JSON.stringify(answer) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
  return { api, prompts };
}

/** Parcel2Go's reply: Simple Delivery carriers and other couriers. */
function stubParcel2Go(seen: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/auth/connect/token")) return Response.json({ access_token: "t", expires_in: 7200 });
      seen.push(String(init?.body ?? ""));
      const q = (CourierName: string, Name: string, TotalPrice: number) => ({ Service: { CourierName, Name }, TotalPrice, CurrencyCode: "GBP" });
      return Response.json({ Quotes: [q("DPD", "DPD Drop Off", 7.94), q("Evri Drop-off", "Evri ParcelShop", 5.46), q("Royal Mail", "Royal Mail 48 Tracked Medium", 6.2), q("Parcelforce", "Parcelforce 48 Large", 5.1)] });
    }),
  );
}

async function draft(env: Env, price = 32.49) {
  const d = await env.store.drafts.create("K", 1);
  await env.store.drafts.patch(
    d.id,
    {
      review: cleanReview({ product: "SilverCrest SHFD 1400 C1 air fryer", visibleFacts: [{ fact: "Original box", photo: 1 }] }, 1, 1),
      facts: cleanFacts({ condition: "opened", included: "Air fryer, basket, manual, original box" }, null),
      specs: { product: "SilverCrest SHFD 1400 C1", exact: true, note: "", specs: [{ name: "Item Weight", value: "approx. 3.18 kg", source: "https://manualslib.com/x", sourceTitle: "Manual" }] },
      price: { value: price, kind: "engine", floor: null, bestOffer: true },
    },
    1,
  );
  return d.id;
}

const env0 = () => ({ store: memoryStore(), photos: memoryPhotoStore(), EBAY_ENV: "sandbox", PARCEL2GO_CLIENT_ID: "c", PARCEL2GO_CLIENT_SECRET: "s" }) as unknown as Env;

describe("planning the postage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("works out the packed parcel, picks the size, quotes it and fills in the postage", async () => {
    const env = env0();
    await env.store.kv.set("seller_postcode", "SW1A 1AA");
    const seen: string[] = [];
    stubParcel2Go(seen);
    const { api, prompts } = fakeClaude({
      item: { lengthCm: 34, widthCm: 28, heightCm: 26, weightKg: 3.18, source: "estimate" },
      packed: { lengthCm: 41.5, widthCm: 33, heightCm: 30, weightKg: 4.32 },
      packaging: "In its original box, inside a shipping box with 3 cm of padding",
      confidence: "medium",
      missing: [],
    });
    const id = await draft(env);
    const d = await planPostage(env, id, api);
    expect(prompts[0]).toContain("Item Weight: approx. 3.18 kg");
    expect(prompts[0]).toContain("Included: Air fryer, basket, manual, original box");
    expect(d.parcel).toEqual({ lengthCm: 42, widthCm: 33, heightCm: 30, weightKg: 4.4 });
    expect(d.parcelPlan).toMatchObject({ confidence: "medium", packaging: "In its original box, inside a shipping box with 3 cm of padding" });
    // eBay's Simple Delivery carriers only, cheapest first; the cheapest fills in the postage, rounded up to 50p.
    expect(d.quotes!.quotes.map((q) => q.carrier)).toEqual(["Evri", "Royal Mail"]);
    expect(d.postage).toMatchObject({ mode: "simple_delivery", size: "medium_parcel_10kg", sizeBy: "app", cost: 5.5, carrier: "Evri", postcode: "SW1A 1AA" });
    expect(JSON.parse(seen[0]).Parcels[0]).toMatchObject({ Weight: 4.4, Length: 42, Width: 33, Height: 30, Value: 32 });
  });

  it("asks K for the measurements when it can't tell, and fills in nothing", async () => {
    const env = env0();
    await env.store.kv.set("seller_postcode", "SW1A 1AA");
    stubParcel2Go([]);
    const { api } = fakeClaude({ item: { lengthCm: null, widthCm: null, heightCm: null, weightKg: null, source: "unknown" }, packed: { lengthCm: 30, widthCm: 20, heightCm: 10, weightKg: 1 }, packaging: "Unknown", confidence: "low", missing: ["the box's length, width and height", "its weight"] });
    const d = await planPostage(env, await draft(env), api);
    expect(d.parcelPlan!.missing).toEqual(["the box's length, width and height", "its weight"]);
    expect(d.postage).toBeNull();
  });

  it("sends a parcel too big for Simple Delivery by courier, quoted across every courier", async () => {
    const env = env0();
    await env.store.kv.set("seller_postcode", "SW1A 1AA");
    stubParcel2Go([]);
    const { api } = fakeClaude({ item: { lengthCm: 30, widthCm: 30, heightCm: 110, weightKg: 7.9, source: "spec" }, packed: { lengthCm: 120, widthCm: 36, heightCm: 36, weightKg: 9.5 }, packaging: "In its original box", confidence: "high", missing: [] });
    const d = await planPostage(env, await draft(env), api);
    expect(d.postage).toMatchObject({ mode: "courier", size: null, carrier: "Parcelforce", cost: 5.5 });
    expect(d.quotes!.quotes.map((q) => q.carrier)).toEqual(["Parcelforce", "Evri Drop-off", "Royal Mail", "DPD"]);
  });

  it("uses a courier above Simple Delivery's £750 price limit", async () => {
    const env = env0();
    await env.store.kv.set("seller_postcode", "SW1A 1AA");
    stubParcel2Go([]);
    const { api } = fakeClaude({ item: { lengthCm: 30, widthCm: 20, heightCm: 2, weightKg: 1.5, source: "spec" }, packed: { lengthCm: 38, widthCm: 28, heightCm: 10, weightKg: 2.2 }, packaging: "Box", confidence: "high", missing: [] });
    expect((await planPostage(env, await draft(env, 899), api)).postage!.mode).toBe("courier");
  });

  it("keeps K's own size choice, and works one out when K only changes the measurements", async () => {
    const env = env0();
    const id = await draft(env);
    const mine = await savePostage(env, id, { cost: 6, postcode: "SW1A 1AA", size: "medium_parcel_20kg", parcel: { lengthCm: 42, widthCm: 33, heightCm: 30, weightKg: 4.4 } });
    expect(mine.postage).toMatchObject({ mode: "simple_delivery", size: "medium_parcel_20kg", sizeBy: "you" });
    const worked = await savePostage(env, id, { cost: 3, postcode: "SW1A 1AA", parcel: { lengthCm: 30, widthCm: 20, heightCm: 10, weightKg: 0.8 } });
    expect(worked.postage).toMatchObject({ mode: "simple_delivery", size: "small_parcel_1kg", sizeBy: "app" });
  });

  it("offers collection as well as postage unless K turns it off", async () => {
    const env = env0();
    const id = await draft(env);
    expect((await savePostage(env, id, { cost: 6, postcode: "SW1A 1AA" })).postage).toMatchObject({ collectionOffered: true, collectionOnly: false });
    expect((await savePostage(env, id, { cost: 6, postcode: "SW1A 1AA", collectionOffered: false })).postage).toMatchObject({ collectionOffered: false });
  });

  it("puts what K does in Seller Hub after publishing in the listing's label", async () => {
    const env = env0();
    const id = await draft(env);
    await env.store.drafts.patch(id, { category: { id: "1", name: "Fryers", path: "" }, listing: { title: "Air fryer", description: "x", specifics: [], dropped: [], at: 1, editedByK: false } }, 1);
    await savePostage(env, id, { cost: 5.5, postcode: "SW1A 1AA", parcel: { lengthCm: 42, widthCm: 33, heightCm: 30, weightKg: 4.4 } });
    const p = listingPayload((await env.store.drafts.get(id))!);
    expect(p.afterPublish).toMatchObject({ code: "simple_delivery", title: "Switch postage to Simple Delivery: Medium parcel, up to 10 kg" });
    expect(p.afterPublish!.detail).toMatch(/Under Postage, choose Buyer pays postage/);
  });
});
