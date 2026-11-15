import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import { withEbayTokens } from "./fixtures";
import type { Env } from "../src/env";
import { createProposal, decide, getProposal } from "../src/proposals";
import { callFor, CAMPAIGN_NAME, WriteRefused } from "../src/ebay/write";
import { reviewWatcherOffers, watcherOffer, type WatcherOfferInput } from "../src/watchers";
import { LOCKED_KINDS, WATCHER_OFFER } from "../src/rules";

// Offers to watchers and Promoted Listings through the write gate (K, 2026-11-15). The offer is a reminder, so
// the discount is as small as possible: 2% to 5%, enforced by the gate whatever a proposal says.

const DAY = 86_400_000;
const now = Date.parse("2026-11-15T02:00:00Z");
const input = (over: Partial<WatcherOfferInput> = {}): WatcherOfferInput => ({ price: 40, watchers: 3, listedDays: 20, floor: null, sentBefore: 0, lastSentAt: null, priceMoving: false, now, ...over });

describe("the offer to watchers", () => {
  it("starts at 2% and goes up a point each time it's sent again, never above 5%", () => {
    expect(watcherOffer(input())).toMatchObject({ percent: 2, offerPrice: 39.2 });
    expect(watcherOffer(input({ sentBefore: 1 }))).toMatchObject({ percent: 3 });
    expect(watcherOffer(input({ sentBefore: 3 }))).toMatchObject({ percent: 5, offerPrice: 38 });
    expect(watcherOffer(input({ sentBefore: 9 }))).toMatchObject({ percent: 5 });
  });

  it("needs watchers, a week listed, a settled price and two weeks since the last offer", () => {
    expect(watcherOffer(input({ watchers: 0 }))).toHaveProperty("skip");
    expect(watcherOffer(input({ listedDays: 3 }))).toHaveProperty("skip");
    expect(watcherOffer(input({ priceMoving: true }))).toHaveProperty("skip");
    expect(watcherOffer(input({ lastSentAt: now - 5 * DAY }))).toHaveProperty("skip");
    expect(watcherOffer(input({ lastSentAt: now - 15 * DAY, sentBefore: 1 }))).toMatchObject({ percent: 3 });
  });

  it("never goes under K's floor: a smaller discount, or none", () => {
    expect(watcherOffer(input({ sentBefore: 3, floor: 38.9 }))).toMatchObject({ percent: 2 });
    expect(watcherOffer(input({ floor: 39.5 }))).toHaveProperty("skip");
  });

  it("is a locked kind", () => {
    expect(LOCKED_KINDS).toContain("offer_to_watchers");
    expect(LOCKED_KINDS).toContain("promote");
  });
});

describe("the gate's limits", () => {
  const offer = (percent: unknown) => callFor({ kind: "offer_to_watchers", item_id: "111", payload: JSON.stringify({ percent, message: "hi" }) });
  const promote = (a: unknown) => callFor({ kind: "promote", item_id: "111", payload: JSON.stringify(a) });

  it("sends only 2% to 5% offers, with no counter-offers", () => {
    const c = offer(3);
    expect(c.rest?.path).toBe("/sell/negotiation/v1/send_offer_to_interested_buyers");
    expect(c.rest?.body).toMatchObject({ allowCounterOffer: false, offerDuration: { unit: "DAY", value: WATCHER_OFFER.durationDays }, offeredItems: [{ listingId: "111", quantity: 1, discountPercentage: "3" }] });
    for (const bad of [1, 6, 10, 50, "x", null]) expect(() => offer(bad)).toThrow(WriteRefused);
  });

  it("sets only 2% to 4% ad rates", () => {
    expect(promote({ action: "promote", rate: 3 }).promote).toEqual({ action: "promote", rate: 3 });
    expect(promote({ action: "end", rate: null }).promote).toEqual({ action: "end", rate: null });
    for (const bad of [1, 5, 12]) expect(() => promote({ action: "promote", rate: bad })).toThrow(WriteRefused);
    expect(() => promote({ action: "boost", rate: 3 })).toThrow(WriteRefused);
  });
});

describe("applying them", () => {
  let env: Env;
  let calls: { method: string; path: string; body: any }[];
  /** eBay's Marketing and Negotiation replies, by method and path. */
  let ebay: (method: string, path: string, body: any) => Response;

  beforeEach(async () => {
    env = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", EBAY_SITE_ID: "3", EBAY_MARKETPLACE: "EBAY_GB", PUBLIC_URL: "https://test.example", SIGNING_KEY: "k", NTFY_TOPIC: "" } as Env;
    await withEbayTokens(env.store);
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: any, init: any) => {
        const url = new URL(String(u));
        if (!url.hostname.endsWith("ebay.com")) return new Response("{}");
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ method, path: url.pathname, body });
        return ebay(method, url.pathname, body);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  const json = (x: unknown, init?: ResponseInit) => new Response(JSON.stringify(x), init);
  const writes = () => calls.filter((c) => c.method !== "GET");

  it("promotes a listing: makes the app's campaign once, then the ad at the approved rate", async () => {
    ebay = (method, path) => {
      if (method === "GET" && path.endsWith("/ad_campaign")) return json({ campaigns: [] });
      if (method === "POST" && path.endsWith("/ad_campaign")) return new Response(null, { status: 201, headers: { Location: "https://api.sandbox.ebay.com/sell/marketing/v1/ad_campaign/777" } });
      if (method === "POST" && path.endsWith("/ad_campaign/777/ad")) return new Response(null, { status: 201, headers: { Location: "https://api.sandbox.ebay.com/sell/marketing/v1/ad_campaign/777/ad/9" } });
      return new Response("unexpected", { status: 500 });
    };
    const p = await createProposal(env, { kind: "promote", itemId: "111", payload: { action: "promote", rate: 2.5 } });
    expect(await decide(env, p.id, "approve")).toBe(`Promoted at 2.5% in "${CAMPAIGN_NAME}"`);
    expect((await getProposal(env, p.id))?.status).toBe("applied");
    expect(writes()).toEqual([
      { method: "POST", path: "/sell/marketing/v1/ad_campaign", body: expect.objectContaining({ campaignName: CAMPAIGN_NAME, marketplaceId: "EBAY_GB", fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: "2.5" } }) },
      { method: "POST", path: "/sell/marketing/v1/ad_campaign/777/ad", body: { listingId: "111", bidPercentage: "2.5" } },
    ]);
    expect((await env.store.audit.recent(10)).map((r) => r.call).sort()).toEqual(["createAdByListingId", "createCampaign"]);
  });

  it("lowers and ends an existing ad by its id", async () => {
    ebay = (method, path) => {
      if (method === "GET" && path.endsWith("/ad_campaign")) return json({ campaigns: [{ campaignId: "5", campaignName: "Old", fundingStrategy: { fundingModel: "COST_PER_SALE" } }] });
      if (method === "GET" && path.endsWith("/ad_campaign/5/ad")) return json({ ads: [{ listingId: "111", adId: "42", bidPercentage: "9.0" }] });
      return new Response(null, { status: 204 });
    };
    const lower = await createProposal(env, { kind: "promote", itemId: "111", payload: { action: "lower", rate: 3 } });
    expect(await decide(env, lower.id, "approve")).toBe("Ad rate changed from 9% to 3%");
    const end = await createProposal(env, { kind: "promote", itemId: "111", payload: { action: "end", rate: null } });
    expect(await decide(env, end.id, "approve")).toBe("Promotion ended (was 9%)");
    expect(writes()).toEqual([
      { method: "POST", path: "/sell/marketing/v1/ad_campaign/5/ad/42/update_bid", body: { bidPercentage: "3.0" } },
      { method: "DELETE", path: "/sell/marketing/v1/ad_campaign/5/ad/42", body: null },
    ]);
  });

  it("sends an approved offer to watchers, and refuses one over 5% however it was filed", async () => {
    ebay = () => json({ offers: [{ offerId: "1" }] });
    const ok = await createProposal(env, { kind: "offer_to_watchers", itemId: "111", payload: { percent: 2, message: "hi" } });
    expect(await decide(env, ok.id, "approve")).toBe("sendOfferToInterestedBuyers ok");
    const big = await createProposal(env, { kind: "offer_to_watchers", itemId: "111", payload: { percent: 20, message: "hi" } });
    expect(await decide(env, big.id, "approve")).toMatch(/must be 2% to 5% off/);
    expect((await getProposal(env, big.id))?.status).toBe("pending");
    expect(writes()).toHaveLength(1);
  });

  it("the nightly proposes one small offer per eligible watched listing, and not twice", async () => {
    await env.store.listings.writeSnapshot(now, [
      { item_id: "111", title: "Watched", price: 40, currency: "GBP", quantity_available: 1, watch_count: 2, start_time: new Date(now - 20 * DAY).toISOString() },
      { item_id: "222", title: "Watched, not eligible on eBay", price: 30, currency: "GBP", quantity_available: 1, watch_count: 1, start_time: new Date(now - 20 * DAY).toISOString() },
      { item_id: "333", title: "Nobody watching", price: 30, currency: "GBP", quantity_available: 1, watch_count: 0, start_time: new Date(now - 20 * DAY).toISOString() },
    ]);
    ebay = (_m, path) => (path.endsWith("/find_eligible_items") ? json({ eligibleItems: [{ listingId: "111" }, { listingId: "333" }] }) : json({}));
    expect(await reviewWatcherOffers(env, now)).toMatch(/1 proposed/);
    expect(await reviewWatcherOffers(env, now)).toMatch(/0 proposed/);
    const made = await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "offer_to_watchers" }]);
    expect(made).toHaveLength(1);
    expect(JSON.parse(made[0].payload)).toMatchObject({ percent: 2, offerPrice: 39.2, watchers: 2 });
    expect(writes()).toHaveLength(0);
  });
});
