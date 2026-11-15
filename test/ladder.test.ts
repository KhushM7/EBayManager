import { beforeEach, describe, expect, it } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { ladderFor, ladderStep, ladderSummary, type LadderInput } from "../src/ladder";
import { promotionAdvice, promotionReview, proposePromotions, reviewRunningPromotions, type PromotionInput, type Traffic } from "../src/promotion";
import { seedProposal } from "./fixtures";
import type { MarketState } from "../src/pricing/model";

// The sales ladder and the 14-day promotion review (K, 2026-11-15): one push per listing at a time, the one its
// own figures call for; an ad that hasn't got the listing seen after two weeks is ended.

const DAY = 86_400_000;
const now = Date.parse("2026-11-15T02:00:00Z");
const input = (over: Partial<LadderInput> = {}): LadderInput => ({ listedDays: 30, views7d: 20, impressions7d: 600, watchers: 0, last: {}, promoted: false, now, ...over });

describe("the sales ladder", () => {
  it("unseen: the listing first, then promotion, then the price", () => {
    const unseen = { views7d: 1, impressions7d: 300 };
    expect(ladderStep(input(unseen)).rung).toBe("listing");
    expect(ladderStep(input({ impressions7d: 40 })).rung).toBe("listing");
    expect(ladderStep(input({ ...unseen, last: { revise: now - 10 * DAY } })).rung).toBe("promote");
    expect(ladderStep(input({ ...unseen, last: { revise: now - 10 * DAY }, promoted: true })).rung).toBe("price");
  });

  it("watched but not selling: an offer to the watchers, then the price", () => {
    expect(ladderStep(input({ watchers: 3 }))).toMatchObject({ rung: "offer" });
    expect(ladderStep(input({ watchers: 3, last: { offer_to_watchers: now - 9 * DAY } })).rung).toBe("price");
    expect(ladderStep(input({ watchers: 3, last: { offer_to_watchers: now - 20 * DAY } })).rung).toBe("offer");
  });

  it("seen but nobody watching: the price", () => {
    expect(ladderStep(input())).toMatchObject({ rung: "price" });
    expect(ladderStep(input()).why).toMatch(/Seen \(20 views in 7 days\) but nobody is watching/);
  });

  it("one step a week, and nothing for a new listing or one with no figures", () => {
    expect(ladderStep(input({ watchers: 3, last: { price: now - 2 * DAY } })).rung).toBe("wait");
    expect(ladderStep(input({ listedDays: 3, views7d: 0 })).rung).toBe("none");
    expect(ladderStep(input({ views7d: null, impressions7d: null })).rung).toBe("none");
  });

  it("reads each listing's rung from the store, ignoring expired labels and read-only dry runs", async () => {
    const env = { store: memoryStore(), WRITE_MODE: "approval" } as Env;
    const start = new Date(now - 40 * DAY).toISOString();
    await env.store.listings.writeSnapshot(now, [
      { item_id: "1", title: "Watched", price: 20, currency: "GBP", quantity_available: 1, watch_count: 2, start_time: start },
      { item_id: "2", title: "Unseen", price: 20, currency: "GBP", quantity_available: 1, watch_count: 0, start_time: start },
      { item_id: "3", title: "Just changed", price: 20, currency: "GBP", quantity_available: 1, watch_count: 2, start_time: start },
      { item_id: "4", title: "Old dry run only", price: 20, currency: "GBP", quantity_available: 1, watch_count: 2, start_time: start },
    ]);
    await env.store.listings.writeTraffic(now, [{ itemId: "1", views: 30, impressions: 800 }, { itemId: "2", views: 0, impressions: 300 }, { itemId: "3", views: 30, impressions: 800 }, { itemId: "4", views: 30, impressions: 800 }]);
    await seedProposal(env.store, { id: "p3", kind: "price", item_id: "3", status: "applied", created_at: now - 2 * DAY, expires_at: now + DAY });
    await seedProposal(env.store, { id: "p4", kind: "price", item_id: "4", status: "agreed", created_at: now - 2 * DAY, expires_at: now + DAY, dry_run: 1 });
    await seedProposal(env.store, { id: "p1", kind: "revise", item_id: "1", status: "expired", created_at: now - DAY, expires_at: now });
    const steps = await ladderFor(env, now);
    expect([...steps].map(([id, s]) => [id, s.rung])).toEqual([["1", "offer"], ["2", "listing"], ["3", "wait"], ["4", "offer"]]);
    expect(ladderSummary(steps)).toBe("1 listing, 0 price, 2 offer, 0 promote, 1 waiting, 0 fine");
  });
});

const market: MarketState = { sales: 20, effective: 20, mNow: 30, mLong: 31, valueFloor: 25, trend30: -0.01, p25: 27, p75: 33, demand28: 0.1, demand91: 0.1, supply: 40, cheapest: 26, weeksOfSupply: 57, dip: 0.03, recoveryDays: null, regime: "normal", why: "" };
const promo = (over: Partial<PromotionInput> = {}): PromotionInput => ({ price: 27, postage: 3, floor: null, listedDays: 45, views7d: 2, watchers: 0, impressions7d: 300, market, suggestedRate: 8, ebayRecommends: true, currentRate: null, ...over });
const traffic = (views7d: number | null, impressions7d: number | null, watchers: number | null, at = now): Traffic => ({ views7d, impressions7d, watchers, at });

describe("the 14-day promotion review", () => {
  it("keeps an ad that got the listing seen, and ends one that didn't", () => {
    expect(promotionReview(traffic(2, 300, 0), traffic(9, 320, 0), 3, 14).verdict).toBe("working"); // views up
    expect(promotionReview(traffic(2, 300, 0), traffic(3, 500, 0), 3, 14).verdict).toBe("working"); // impressions up
    expect(promotionReview(traffic(2, 300, 0), traffic(2, 300, 1), 3, 14).verdict).toBe("working"); // someone watching
    const flat = promotionReview(traffic(2, 300, 0), traffic(3, 310, 0), 3, 14);
    expect(flat.verdict).toBe("not_working");
    expect(flat.why).toMatch(/3% ad, 14 days on: no more people are seeing it \(search impressions in 7 days 300 to 310, views 2 to 3, watchers 0 to 0\)/);
    expect(promotionReview(null, traffic(3, 310, 0), 3, 14).verdict).toBe("unknown");
    expect(promotionReview(traffic(2, 300, 0), traffic(null, null, 0), 3, 14).verdict).toBe("unknown");
  });

  it("doesn't end a promoted listing just because it's now being seen: that's the ad working", () => {
    const a = promotionAdvice(promo({ currentRate: 3, views7d: 40, watchers: 2, impressions7d: 900, market: { ...market, weeksOfSupply: 2 } }));
    expect(a.action).toBe("none");
    expect(a.why).toMatch(/14-day review/);
    // Its rate is still brought down when it's above the limit.
    expect(promotionAdvice(promo({ currentRate: 9, views7d: 40, watchers: 2 }))).toMatchObject({ action: "lower", rate: 3 });
  });

  describe("nightly", () => {
    let env: Env;
    const start = new Date(now - 60 * DAY).toISOString();
    const snapshot = async (views: number, impressions: number, watchers = 0) => {
      await env.store.listings.writeSnapshot(now, [{ item_id: "1", title: "Kettle", price: 20, currency: "GBP", quantity_available: 1, watch_count: watchers, start_time: start }]);
      await env.store.listings.writeTraffic(now, [{ itemId: "1", views, impressions }]);
    };
    const ad = (daysAgo: number, baseline: Traffic | null = traffic(2, 300, 0, now - daysAgo * DAY)) =>
      env.store.docs.create("proposals", { id: "ad", kind: "promote", item_id: "1", status: "applied", created_at: now - (daysAgo + 1) * DAY, decided_at: now - daysAgo * DAY, expires_at: now, payload: JSON.stringify({ action: "promote", rate: 3, baseline }), reason: null, dry_run: 0, decided_by: "K", result: null, pk: "1", type: "proposal" });
    const ends = async () => (await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "promote" }])).filter((p) => JSON.parse(p.payload).action === "end");

    beforeEach(() => {
      env = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", PUBLIC_URL: "https://test.example", SIGNING_KEY: "k", NTFY_TOPIC: "" } as Env;
    });

    it("leaves an ad alone for its first 14 days", async () => {
      await snapshot(2, 300);
      await ad(10);
      expect(await reviewRunningPromotions(env, now)).toBe("no ads due a review");
    });

    it("files an end label for an ad that changed nothing, once", async () => {
      await snapshot(2, 310);
      await ad(15);
      expect(await reviewRunningPromotions(env, now)).toMatch(/1 reviewed, 1 to end/);
      const [end] = await ends();
      expect(end.status).toBe("pending");
      expect(end.reason).toMatch(/no more people are seeing it/);
      expect(await reviewRunningPromotions(env, now + DAY)).toBe("no ads due a review");
      expect(await ends()).toHaveLength(1);
    });

    it("keeps one that's working, and judges it again two weeks later against tonight's figures", async () => {
      await snapshot(12, 700);
      await ad(15);
      expect(await reviewRunningPromotions(env, now)).toMatch(/1 reviewed, 0 to end; Kettle: working/);
      expect(await reviewRunningPromotions(env, now + 5 * DAY)).toBe("no ads due a review");
      // Two weeks on, flat against tonight's 12 views and 700 impressions: now it isn't adding anything.
      expect(await reviewRunningPromotions(env, now + 14 * DAY)).toMatch(/1 to end/);
    });

    it("with no figures from before, keeps tonight's as the starting point", async () => {
      await snapshot(2, 300);
      await ad(20, null);
      expect(await reviewRunningPromotions(env, now)).toMatch(/0 to end; Kettle: no figures yet/);
      expect(await ends()).toHaveLength(0);
    });

    it("a new promotion is proposed only when promotion is the listing's step on the ladder", async () => {
      const found = [{ itemId: "1", title: "Kettle", advice: promotionAdvice(promo()), suggestedRate: 8, ebayRecommends: true, currentRate: null, traffic: traffic(2, 300, 0) }];
      expect(found[0].advice.action).toBe("promote");
      expect(await proposePromotions(env, found, new Map([["1", { rung: "listing", why: "" }]]))).toBe(0);
      expect(await proposePromotions(env, found, new Map([["1", { rung: "promote", why: "" }]]))).toBe(1);
      const [p] = await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "promote" }]);
      expect(JSON.parse(p.payload).baseline).toMatchObject({ views7d: 2, impressions7d: 300, watchers: 0 });
    });
  });
});
