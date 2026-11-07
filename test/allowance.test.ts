import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { allowances, checkAllowances, setClaudeCredit } from "../src/allowance";
import { providerQuota, quotaFromHeaders, searchSold } from "../src/solddata";

let env: Env;
const spend = (usd: number, at = Date.now()) =>
  env.store.usage.log({ at, job: "x", model: "claude-haiku-5-5", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: usd, stop_reason: "end_turn" });
const month = () => new Date().toISOString().slice(0, 7);

beforeEach(() => {
  env = { store: memoryStore(), EBAY_ENV: "sandbox", ANTHROPIC_API_KEY: "k", TRAWL_API_KEY: "t" } as Env;
  // By default the providers can't be reached, so the app's own count stands in.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("allowances", () => {
  it("says what's left: Claude from the entered balance less spend since, sold data from the monthly cap", async () => {
    await spend(5, Date.now() - 60_000); // before the balance was entered: not counted
    await setClaudeCredit(env, 10);
    await spend(6.35);
    await env.store.solddata.addUsage("trawl", month(), 70);
    const [claude, trawl, comps] = await allowances(env);
    expect(claude).toMatchObject({ left: 3.65, summary: "$3.65 left", level: "ok" });
    expect(trawl).toMatchObject({ left: 180, total: 250, summary: "180 of 250 searches left this month", level: "ok" });
    expect(comps.level).toBe("off");
  });

  it("asks for the balance until it's entered", async () => {
    const [claude] = await allowances(env);
    expect(claude).toMatchObject({ left: null, level: "unknown", summary: "Balance not entered" });
  });

  it("files one to-do and one notification when an allowance runs low, and resolves it when topped up", async () => {
    await setClaudeCredit(env, 10);
    await spend(8.5);
    await env.store.solddata.addUsage("trawl", month(), 250);
    expect(await checkAllowances(env)).toBe("2 low or out, 2 new");
    const open = (await env.store.todos.list("open")).filter((t) => t.code === "allowance_low");
    expect(open.map((t) => t.title).sort()).toEqual(["Claude credit running low", "Trawl searches used up"]);
    // Again with nothing changed: no new to-do.
    expect(await checkAllowances(env)).toBe("2 low or out");
    // Topped up: the Claude one resolves.
    await setClaudeCredit(env, 20);
    await checkAllowances(env);
    const still = (await env.store.todos.list("open")).filter((t) => t.code === "allowance_low");
    expect(still.map((t) => t.title)).toEqual(["Trawl searches used up"]);
  });

  it("uses the provider's own figures (free calls), which include searches made elsewhere", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: any) => {
        urls.push(String(u));
        return String(u).includes("trawl")
          ? new Response("{}", { headers: { "X-RateLimit-Limit": "250", "X-RateLimit-Remaining": "189", "X-RateLimit-Reset": "1796083200", "X-Credits-Charged": "0" } })
          : new Response("{}", { headers: { "X-Quota-Monthly": "100", "X-Quota-Used": "79", "X-RateLimit-Limit": "10", "X-RateLimit-Remaining": "10" } });
      }),
    );
    env = { ...env, COMPSAPI_KEY: "c" } as Env;
    await env.store.solddata.addUsage("trawl", month(), 37); // the app saw fewer searches than Trawl did
    const [, trawl, comps] = await allowances(env, Date.parse("2026-11-07T12:00:00Z"));
    expect(trawl).toMatchObject({ left: 189, total: 250, summary: "189 of 250 searches left this month", level: "ok" });
    expect(trawl.notes[0]).toBe("Resets 2026-12-01.");
    expect(comps).toMatchObject({ left: 21, total: 100, summary: "21 of 100 searches left this month" });
    // Only the free calls: Trawl's /health and CompsAPI's /v1/usage.
    expect(urls.map((u) => new URL(u).pathname).sort()).toEqual(["/health", "/v1/usage"]);
  });

  it("refuses a search when the provider says the month is used up", async () => {
    const h = new Headers({ "X-RateLimit-Limit": "250", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) });
    await env.store.kv.setJson("solddata_quota:trawl", quotaFromHeaders("trawl", h)!);
    expect(await providerQuota(env, "trawl")).toMatchObject({ remaining: 0 });
    await expect(searchSold(env, "trawl", { words: "anything" })).rejects.toThrow(/no searches left/);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });

  describe("a second key", () => {
    const trawlReply = (remaining: number) =>
      new Response(JSON.stringify({ currency: "GBP", results: [], credits_charged: 1 }), {
        headers: { "X-RateLimit-Limit": "250", "X-RateLimit-Remaining": String(remaining), "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 86_400), "X-Credits-Charged": "1" },
      });
    const usedKeys = () => (globalThis.fetch as any).mock.calls.map((c: any[]) => c[1]?.headers?.["x-api-key"]);
    const setQuota = (slot: 1 | 2, remaining: number) =>
      env.store.kv.setJson(slot === 1 ? "solddata_quota:trawl" : "solddata_quota:trawl:2", { limit: 250, remaining, resetAt: Date.now() + 86_400_000, at: Date.now() });

    beforeEach(() => {
      env = { ...env, TRAWL_API_KEY: "first", TRAWL_API_KEY_2: "second" } as Env;
    });

    it("takes over when the first key is used up", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => trawlReply(240)));
      await setQuota(1, 0);
      await searchSold(env, "trawl", { words: "air fryer" });
      expect(usedKeys()).toEqual(["second"]);
    });

    it("takes over in the same search when the provider refuses the first key as out of credit", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_u: any, init: any) => (init.headers["x-api-key"] === "first" ? new Response("{}", { status: 429 }) : trawlReply(249))),
      );
      await searchSold(env, "trawl", { words: "kettle" });
      expect(usedKeys()).toEqual(["first", "second"]);
      expect(await providerQuota(env, "trawl", 1)).toMatchObject({ remaining: 0 });
      // The next search goes straight to the second key.
      await searchSold(env, "trawl", { words: "toaster" });
      expect(usedKeys()).toEqual(["first", "second", "second"]);
    });

    it("shows each key, and which one is in use", async () => {
      vi.stubGlobal("fetch", vi.fn(async (_u: any, init: any) => trawlReply(init.headers["x-api-key"] === "first" ? 0 : 200)));
      const trawl = (await allowances(env))[1];
      expect(trawl.keys).toEqual([
        { slot: 1, left: 0, total: 250, inUse: false, reported: true },
        { slot: 2, left: 200, total: 250, inUse: true, reported: true },
      ]);
      expect(trawl).toMatchObject({ summary: "Key 2 in use: 200 of 250 left", level: "ok" });
    });

    it("alerts only when the first key is used up and the second is below 10%", async () => {
      const open = async () => (await env.store.todos.list("open")).filter((t) => t.code === "allowance_low" && t.title.startsWith("Trawl"));
      const run = async (first: number, second: number) => {
        vi.stubGlobal("fetch", vi.fn(async (_u: any, init: any) => trawlReply(init.headers["x-api-key"] === "first" ? first : second)));
        await env.store.kv.set("solddata_quota:trawl", "null");
        await env.store.kv.set("solddata_quota:trawl:2", "null");
        await checkAllowances(env);
        return open();
      };
      expect(await run(10, 10)).toHaveLength(0); // the first key isn't used up yet
      expect(await run(0, 30)).toHaveLength(0); // 12% left on the second
      const t = await run(0, 20); // 8% left on the second
      expect(t).toHaveLength(1);
      expect(t[0].detail).toContain("the second has 20 of 250 searches left");
    });
  });

  it("with one key, alerts below 10%", async () => {
    const reply = (remaining: number) => new Response("{}", { headers: { "X-RateLimit-Limit": "250", "X-RateLimit-Remaining": String(remaining) } });
    vi.stubGlobal("fetch", vi.fn(async () => reply(30)));
    expect((await allowances(env))[1].level).toBe("ok");
    await env.store.kv.set("solddata_quota:trawl", "null");
    vi.stubGlobal("fetch", vi.fn(async () => reply(20)));
    expect((await allowances(env))[1].level).toBe("low");
  });

  it("refuses a balance that isn't a sensible number of dollars", async () => {
    await expect(setClaudeCredit(env, -1)).rejects.toThrow();
    await expect(setClaudeCredit(env, Number.NaN)).rejects.toThrow();
  });
});
