// The D1 -> store import (src/store/migrate.ts): rows shaped as the D1 export gives them, mapped, loaded into
// a store, then read back through the app's own repositories, which must see exactly the original data.
import { describe, expect, it } from "vitest";
import { MemoryDocStore } from "../src/store/memory";
import { makeStore } from "../src/store";
import { expectedCounts, planImport, type Rows } from "../src/store/migrate";
import type { Env } from "../src/env";
import { metrics } from "../src/api";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY = 86_400_000;

const rows: Rows = {
  settings: [
    { key: "writes_paused", value: "0" },
    { key: "reply_style", value: JSON.stringify({ tone: "warm" }) },
    { key: "ebay_public_key:abc/def?x", value: "PEM" },
  ],
  ebay_tokens: [{ id: 1, access_token: "at", access_expires_at: NOW + 3600_000, refresh_token: "rt", refresh_expires_at: NOW + 90 * DAY, scopes: "s.readonly" }],
  solddata_usage: [{ provider: "trawl", month: "2026-11", used: 26 }, { provider: "compsapi", month: "2026-11", used: 27 }],
  users: [
    { id: "kid", name: "K", role: "owner", created_at: NOW - 5 * DAY, disabled: 0, is_test: 0 },
    { id: "test-1", name: "Sandbox test key", role: "owner", created_at: NOW, disabled: 0, is_test: 1 },
  ],
  recovery_codes: [{ code_hash: "h1", user_id: "kid", used_at: null }, { code_hash: "h2", user_id: "kid", used_at: NOW - DAY }],
  credentials: [{ id: "cred", user_id: "kid", alg: -7, public_key: "{}", sign_count: 3 }],
  sessions: [{ id_hash: "s", user_id: "kid" }],
  push_subscriptions: [{ endpoint: "https://push.example/1" }],
  proposals: [
    { id: "11111111-1111-4111-8111-111111111111", kind: "price", item_id: "178305367532", payload: "{}", reason: "r", status: "agreed", dry_run: 1, created_at: NOW - 2 * DAY, expires_at: NOW + 5 * DAY, decided_at: NOW - DAY, decided_by: "K", result: "Dry run: recorded" },
    { id: "22222222-2222-4222-8222-222222222222", kind: "promote", item_id: "178305367532", payload: "{}", reason: null, status: "rejected", dry_run: 1, created_at: NOW - 2 * DAY, expires_at: NOW + 5 * DAY, decided_at: NOW - DAY, decided_by: "K", result: null },
    { id: "33333333-3333-4333-8333-333333333333", kind: "policy", item_id: null, payload: "{}", reason: null, status: "pending", dry_run: 1, created_at: NOW - DAY, expires_at: NOW + 6 * DAY, decided_at: null, decided_by: null, result: null },
  ],
  audit_log: [{ id: 7, at: NOW - DAY, env: "production", proposal_id: "11111111-1111-4111-8111-111111111111", call: "ReviseFixedPriceItem", request: "<x/>", response: "Writes are off", outcome: "refused", actor: "K" }],
  listing_snapshots: [
    { item_id: "178305367532", taken_at: NOW - DAY, title: "TV stand", price: 76.24, currency: "GBP", quantity_available: 1, watch_count: 5, view_count: null, start_time: "2026-07-14T10:00:00.000Z" },
    { item_id: "178305367532", taken_at: NOW - 3600_000, title: "TV stand", price: 69.99, currency: "GBP", quantity_available: 1, watch_count: 5, view_count: null, start_time: "2026-07-14T10:00:00.000Z" },
    { item_id: "178310678490", taken_at: NOW - 3600_000, title: "Surface Dock", price: 9.24, currency: "GBP", quantity_available: 1, watch_count: 0, view_count: null, start_time: "2026-07-16T10:00:00.000Z" },
  ],
  listing_traffic: [{ item_id: "178305367532", taken_at: NOW - 2 * 3600_000, views_7d: 2, impressions_7d: 72 }],
  item_settings: [{ item_id: "178305367532", floor_price: 55, collection_only: 1, notes: "120 x 45 x 50 cm" }],
  product_specs: [{ item_id: "178305367532", title: "TV stand", at: NOW - DAY, lookup: JSON.stringify({ exact: true, specs: [] }) }],
  orders: [{ order_id: "o1", created_at: NOW - 10 * DAY, total: 33.5, fees: null, currency: "GBP", status: "IMPORTED" }],
  order_items: [{ order_id: "o1", item_id: "176887824593", title: "Nerf", quantity: 1, price: 32.97 }, { order_id: "gone", item_id: "1", title: "x", quantity: 1, price: 1 }],
  health_flags: [{ item_id: "178305367532", checked_at: NOW - DAY, flag: "stale", detail: "d" }],
  buyer_messages: [{ message_id: "m1", item_id: "178305367532", sender: "buyer1", body: "hi", received_at: NOW - DAY, proposal_id: "p" }],
  price_decisions: [
    { id: 1, item_id: "178305367532", at: NOW - 2 * DAY, grp: "furniture", strategy: "compete", price: 70, total: 70, market_price: 72, predicted_days: 20, result: '{"decision":{"price":70}}' },
    { id: 2, item_id: "178305367532", at: NOW - DAY, grp: "furniture", strategy: "compete", price: 68, total: 68, market_price: 70, predicted_days: 18, result: '{"decision":{"price":68}}' },
  ],
  pricing_params: [{ grp: "furniture", tau: 0.07, alpha: 1.1, n: 40, updated_at: NOW - DAY }],
  bundle_advice: [{ id: 3, at: NOW - DAY, kind: "combine", item_ids: "1,2", detail: '{"kind":"combine"}', status: "open" }],
  market_snapshots: [
    { key: "tv stand", taken_at: NOW - 5 * DAY, item_id: "a", total: 60, grp: "furniture", market: 70, share: 0.1 },
    { key: "tv stand", taken_at: NOW - 5 * DAY, item_id: "b", total: 80, grp: "furniture", market: 70, share: 0.1 },
    { key: "tv stand", taken_at: NOW - 200 * DAY, item_id: "a", total: 60, grp: "furniture", market: 70, share: 0.1 },
  ],
  solddata_cache: [{ key: '["trawl","tv stand"]', provider: "trawl", fetched_at: NOW - 5 * DAY, sales: "[]" }, { key: "old", provider: "trawl", fetched_at: NOW - 40 * DAY, sales: "[]" }],
  item_identity: [{ key: "v3|TV stand||0|", item_id: "178305367532", identity: '{"product":"x"}', at: NOW - DAY }],
  claude_usage: [{ id: 9, at: NOW - 3600_000, job: "audit:1", model: "claude-sonnet-5-5", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.05, stop_reason: "end_turn" }],
  audit_reports: [{ id: 2, at: NOW - 3600_000, env: "production", report: JSON.stringify({ at: NOW - 3600_000, listings: [] }) }],
};

describe("importing D1 into the store", () => {
  it("lands every table where the app reads it, and leaves out what can't move", async () => {
    const { docs, notes } = await planImport(rows, NOW);
    const memory = new MemoryDocStore(() => NOW);
    for (const d of docs) await memory.upsert(d.container, d.doc);
    const store = makeStore(memory);

    expect(await store.kv.get("writes_paused")).toBe("0");
    expect(await store.kv.get("ebay_public_key:abc/def?x")).toBe("PEM");
    expect(await store.kv.getJson("reply_style")).toEqual({ tone: "warm" });
    expect((await store.kv.getEbayTokens())!.refresh_token).toBe("rt");
    expect(await store.solddata.used("compsapi", "2026-11")).toBe(27);

    // K is there (same id, so history stays attributed); the test-key user, passkeys and sessions aren't.
    expect(await store.auth.getUser("kid")).toMatchObject({ name: "K", role: "owner", disabled: 0 });
    expect(await store.auth.getUser("test-1")).toBeNull();
    expect(await store.auth.getCredentialWithUser("cred")).toBeNull();
    expect(await store.auth.consumeRecoveryCode("h1", NOW)).toBe("kid");
    expect(await store.auth.consumeRecoveryCode("h2", NOW)).toBeNull();

    // Proposals keep their ids, decisions and who made them; the audit log keeps its link to them.
    const agreed = (await store.proposals.get("11111111-1111-4111-8111-111111111111"))!;
    expect(agreed).toMatchObject({ status: "agreed", decided_by: "K", dry_run: 1, result: "Dry run: recorded" });
    expect((await store.proposals.listByStatus("rejected", "asc")).map((p) => p.kind)).toEqual(["promote"]);
    expect((await store.proposals.listByStatus("pending", "asc")).map((p) => p.item_id)).toEqual([null]);
    const [audit] = await store.audit.recent(10);
    expect(audit).toMatchObject({ outcome: "refused", actor: "K", kind: "price", item_id: "178305367532" });

    // The latest snapshot set, with traffic and K's settings.
    const latest = await store.listings.latestSet();
    expect(latest.map((l) => [l.item_id, l.price])).toEqual([
      ["178305367532", 69.99],
      ["178310678490", 9.24],
    ]);
    expect(latest[0]).toMatchObject({ views_7d: 2, impressions_7d: 72, first_start_time: "2026-07-14T10:00:00.000Z" });
    expect(await store.listings.getSettings("178305367532")).toMatchObject({ floor_price: 55, collection_only: 1, notes: "120 x 45 x 50 cm" });
    expect(await store.listings.getSpecs("178305367532", "TV stand")).toContain('"exact":true');

    // Pricing: the latest decision is the newest one; learned parameters; open advice.
    expect((await store.pricing.latestDecision("178305367532"))!.price).toBe(68);
    expect(await store.pricing.paramsFor("furniture")).toEqual({ tau: 0.07, alpha: 1.1 });
    expect((await store.pricing.openAdvice()).length).toBe(1);
    expect((await store.pricing.marketSince(0)).length).toBe(2); // the 200-day-old day is gone
    expect(await store.solddata.cacheGet('["trawl","tv stand"]', 0)).toBe("[]");
    expect(await store.solddata.cacheGet("old", 0)).toBeNull();
    expect(await store.pricing.getIdentity("v3|TV stand||0|")).toBe('{"product":"x"}');

    expect(await store.messages.seenQuestion("m1")).toBe(true);
    expect((await store.usage.since(0)).map((u) => u.cost_usd)).toEqual([0.05]);
    expect(JSON.parse((await store.reports.latest("production"))!).listings).toEqual([]);
    expect((await store.jobs.latestHealthFlags()).map((f) => f.flag)).toEqual(["stale"]);

    // Every table arrived in full.
    for (const [table, want, got] of expectedCounts(rows, docs)) expect(got, table).toBe(want);
    expect(notes.join("\n")).toMatch(/1 order items had no order/);
    expect(notes.join("\n")).toMatch(/credentials: 1 rows not carried over/);

    // The app's metrics read the imported data.
    const m = await metrics({ store } as Env);
    expect(m.proposals).toEqual({ agreed: 1, rejected: 1, pending: 1 });
  });

  it("gives the same documents on a second run (an interrupted import can be run again)", async () => {
    const a = await planImport(rows, NOW);
    const b = await planImport(rows, NOW);
    expect(b.docs.map((d) => `${d.container}/${d.doc.pk}/${d.doc.id}`)).toEqual(a.docs.map((d) => `${d.container}/${d.doc.pk}/${d.doc.id}`));
  });
});
