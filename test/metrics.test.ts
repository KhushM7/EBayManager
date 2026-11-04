// metrics() on a fixed fixture, with the numbers worked out by hand: pins the aggregation that replaced
// the SQL (last snapshot of each day, SQLite SUM semantics, one row per order item, medians).
import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { metrics, sqlSum } from "../src/api";
import { seedProposal } from "./fixtures";

const DAY = 86_400_000;

describe("metrics", () => {
  it("SUM of nothing or only nulls is null, as in SQLite", () => {
    expect(sqlSum([])).toBeNull();
    expect(sqlSum([null, undefined])).toBeNull();
    expect(sqlSum([1, null, 2])).toBe(3);
  });

  it("matches hand-worked figures", async () => {
    const store = memoryStore();
    const env = { store } as Env;
    const now = Date.now();
    const d2 = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 2 * DAY; // two days ago, 00:00 UTC
    const row = (item_id: string, price: number, qty: number, watch: number, start: string) => ({ item_id, title: `T${item_id}`, price, currency: "GBP", quantity_available: qty, watch_count: watch, start_time: start });
    // Day A: two snapshots; only the later one (3 listings) counts.
    await store.listings.writeSnapshot(d2 + 3600_000, [row("1", 10, 1, 1, new Date(d2 - 20 * DAY).toISOString())]);
    await store.listings.writeSnapshot(d2 + 7200_000, [row("1", 10, 1, 2, new Date(d2 - 20 * DAY).toISOString()), row("2", 5, 3, 0, new Date(d2 - 10 * DAY).toISOString()), row("3", 8, 0, 1, new Date(d2 - 5 * DAY).toISOString())]);
    // Day B: one snapshot, 2 listings.
    await store.listings.writeSnapshot(d2 + DAY + 3600_000, [row("1", 9, 1, 2, new Date(d2 - 20 * DAY).toISOString()), row("2", 5, 3, 1, new Date(d2 - 10 * DAY).toISOString())]);

    // Orders: one two-item order and one single-item order in the last 30 days; one older.
    await store.orders.insertIfAbsent([
      { orderId: "o1", createdAt: d2 + DAY + 5000, total: 30, fees: 2, currency: "GBP", status: "PAID", items: [{ itemId: "3", title: "T3", quantity: 1, price: 8 }, { itemId: "4", title: "T4", quantity: 1, price: 20 }] },
      { orderId: "o2", createdAt: d2 + DAY + 9000, total: 12, fees: null, currency: "GBP", status: "PAID", items: [{ itemId: "2", title: "T2", quantity: 1, price: 10 }] },
      { orderId: "o3", createdAt: now - 60 * DAY, total: 50, fees: 5, currency: "GBP", status: "PAID", items: [{ itemId: "9", title: "T9", quantity: 1, price: 50 }] },
    ]);
    await store.usage.log({ at: d2 + 1000, job: "audit:1", model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.25, stop_reason: null });
    await store.usage.log({ at: d2 + 2000, job: "triage:1", model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.5, stop_reason: null });
    // Proposals: decided after 10, 30 and 20 minutes; one pending.
    for (const [id, status, mins] of [["a", "approved", 10], ["b", "rejected", 30], ["c", "applied", 20], ["d", "pending", null]] as const)
      await seedProposal(store, { id, kind: "price", item_id: "1", status, created_at: now - DAY, expires_at: now + DAY, ...(mins != null ? {} : {}) });
    for (const [id, mins] of [["a", 10], ["b", 30], ["c", 20]] as const) {
      const [doc] = await store.docs.query("proposals", { where: [{ f: "id", op: "=", v: id }] });
      await store.docs.upsert("proposals", { ...doc, decided_at: doc.created_at + mins * 60_000 });
    }
    await store.jobs.recordHealthFlags(now - DAY, [{ item_id: "1", flag: "stale", detail: "x" }]);
    await store.kv.setJson("last_nightly", { at: 1 });

    const m = await metrics(env);
    const dayA = new Date(d2).toISOString().slice(0, 10);
    const dayB = new Date(d2 + DAY).toISOString().slice(0, 10);
    expect(m.listings).toEqual([
      // 10*1 + 5*3 + 8*max(0,1) = 33; watchers 2+0+1
      { day: dayA, active: 3, asking: 33, watchers: 3 },
      { day: dayB, active: 2, asking: 24, watchers: 3 },
    ]);
    expect(m.sales).toEqual([
      { day: new Date(now - 60 * DAY).toISOString().slice(0, 10), orders: 1, revenue: 50, fees: 5 },
      { day: dayB, orders: 2, revenue: 42, fees: 2 },
    ]);
    expect(m.spend).toEqual([{ day: dayA, usd: 0.75, calls: 2 }]);
    // Last 30 days, one row per order item: items {3,4,2}; revenue 30+30+12 (a two-item order counts twice, as before).
    expect(m.sold30).toEqual({ items: 3, revenue: 72, fees: 4, sellThrough: 3 / (3 + 2) });
    // Items with a known first start: 3 (sold d2+1d, started d2-5d) and 2 (started d2-10d): 6 and 11 days.
    expect(m.avgDaysToSell).toBeCloseTo((6 + 11) / 2 + (5000 + 9000) / 2 / DAY, 6);
    expect(m.proposals).toEqual({ approved: 1, rejected: 1, applied: 1, pending: 1 });
    expect(m.medianMinutesToDecide).toBe(20);
    expect(m.flags).toEqual([{ item_id: "1", flag: "stale", detail: "x", title: "T1" }]);
    expect(m.lastNightly).toEqual({ at: 1 });
  });
});
