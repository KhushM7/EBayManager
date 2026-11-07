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
    await expect(searchSold(env, "trawl", { words: "anything" })).rejects.toThrow(/used up/);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });

  it("refuses a balance that isn't a sensible number of dollars", async () => {
    await expect(setClaudeCredit(env, -1)).rejects.toThrow();
    await expect(setClaudeCredit(env, Number.NaN)).rejects.toThrow();
  });
});
