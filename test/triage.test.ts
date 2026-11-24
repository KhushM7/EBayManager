import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import { seedProposal, withEbayTokens } from "./fixtures";
import type { Env } from "../src/env";

// Nightly triage: the cap counts only listings Claude is asked about, and one failure doesn't lose the rest.

const asked: string[] = [];
let fail: (job: string) => string | null = () => null;
vi.mock("../src/claude", async (real) => ({
  ...(await real<typeof import("../src/claude")>()),
  runAgent: vi.fn(async (_e: unknown, r: { job: string }) => {
    asked.push(r.job);
    const why = fail(r.job);
    if (why) throw new Error(why);
    return { text: "No change needed.", turns: 1, costUsd: 0, stopReason: "end_turn" };
  }),
}));
const { runNightly } = await import("../src/nightly");

const DAY = 86_400_000;
const listing = (id: string) => `<Item><ItemID>${id}</ItemID><Title>Item ${id}</Title><SellingStatus><CurrentPrice currencyID="GBP">20.0</CurrentPrice></SellingStatus><QuantityAvailable>1</QuantityAvailable><WatchCount>0</WatchCount><ListingDetails><StartTime>${new Date(Date.now() - 20 * DAY).toISOString()}</StartTime></ListingDetails></Item>`;

async function setup(over: Partial<Env> = {}) {
  asked.length = 0;
  fail = () => null;
  const ids = ["1", "2", "3", "4", "5", "6", "7"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: any) => {
      const url = String(u);
      if (url.endsWith("/ws/api.dll")) return new Response(`<GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray>${ids.map(listing).join("")}</ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>`);
      if (url.includes("/sell/fulfillment/")) return Response.json({ orders: [] });
      if (url.includes("/sell/negotiation/")) return new Response(null, { status: 204 });
      if (url.includes("/sell/analytics/"))
        return Response.json({ header: { metrics: [{ key: "LISTING_VIEWS_TOTAL" }, { key: "LISTING_IMPRESSION_TOTAL" }] }, records: ids.map((value) => ({ dimensionValues: [{ value }], metricValues: [{ value: 1 }, { value: 300 }] })) });
      return new Response("no", { status: 500 });
    }),
  );
  const env = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", EBAY_SITE_ID: "3", EBAY_MARKETPLACE: "EBAY_GB", NTFY_TOPIC: "", SIGNING_KEY: "k", PUBLIC_URL: "https://test.example", ANTHROPIC_API_KEY: "k", ...over } as Env;
  await withEbayTokens(env.store);
  // The first four were edited an hour ago, so they wait.
  for (const id of ids.slice(0, 4))
    await seedProposal(env.store, { id: `${id}_r`, kind: "revise", item_id: id, status: "rejected", created_at: Date.now() - 3_600_000, expires_at: Date.now() + DAY });
  return env;
}
afterEach(() => vi.unstubAllGlobals());

describe("nightly triage", () => {
  it("reaches the listings it can act on past those that are waiting, and files no health to-dos", async () => {
    const env = await setup();
    const r = await runNightly(env);
    expect(asked.filter((j) => j.startsWith("triage:")).sort()).toEqual(["triage:5", "triage:6", "triage:7"]);
    expect(r.steps.triage).toMatch(/^3 of 7 triaged, 4 on another step/);
    expect((await env.store.todos.list("open")).filter((t) => t.code === "health")).toEqual([]);
  });

  it("carries on after one failure, and stops cleanly when the budget is gone", async () => {
    let env = await setup();
    fail = (j) => (j === "triage:5" ? "overloaded" : null);
    let r = await runNightly(env);
    expect(r.triaged).toBe(2);
    expect(r.steps.triage).toMatch(/failed 5: overloaded/);
    env = await setup();
    fail = () => "Today's Claude budget of $1.00 is used up ($1.00).";
    r = await runNightly(env);
    expect(asked.filter((j) => j.startsWith("triage:"))).toHaveLength(1);
    expect(r.failed).not.toContain("triage");
  });

  it("skips without an error, calling nothing, when Claude is off", async () => {
    const r = await runNightly(await setup({ CLAUDE_DAILY_BUDGET_USD: "0" }));
    expect(r.steps.triage).toBe("skipped: Claude is off");
    expect(asked).toEqual([]);
  });
});
