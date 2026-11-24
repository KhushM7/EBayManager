import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { log, swallow } from "../src/log";
import { redact } from "../src/redact";
import { buyerFee, buyerPays } from "../src/buyerfee";
import { memoryStore } from "../src/store";
import { claudeAvailable } from "../src/rules";

const env = () => ({ store: memoryStore() }) as unknown as Env;

describe("the app's log", () => {
  it("writes a line and an event, and never throws", async () => {
    const e = env();
    const lines: string[] = [];
    e.logSink = (_l, line) => void lines.push(line);
    await log(e, "error", "poll.offer", { itemId: "1", err: new Error("eBay said no") });
    const [row] = await e.store.jobs.recentEvents({ since: 0 });
    expect(row).toMatchObject({ kind: "poll.offer", status: "error", item_id: "1" });
    expect(lines[0]).toContain("eBay said no");
    await expect(log({ store: null } as unknown as Env, "error", "x")).resolves.toBeUndefined();
    await expect(log({ ...e, logSink: () => { throw new Error("sink"); } }, "info", "x")).resolves.toBeUndefined();
    expect(await Promise.reject(new Error("boom")).catch(swallow(e, "swallowed"))).toBeNull();
  });

  it("removes secrets and personal details", () => {
    const out = redact("Bearer abc.def v^1.1#i^1#xyz sk-ant-abc refresh_token=abcdefghij bob@example.com 07700 900123 SW1A 1AA <Buyer>bob</Buyer> /s/secretpath");
    for (const s of ["abc.def", "i^1", "sk-ant-abc", "abcdefghij", "bob", "900123", "SW1A", "secretpath"]) expect(out).not.toContain(s);
  });
});

describe("buyer fee", () => {
  it("works out the fee bands", () => {
    expect(buyerFee(10)).toBe(0.8);
    expect(buyerFee(30)).toBe(1.9);
    expect(buyerPays(10)).toBe(10.8);
    expect(buyerPays(5)).toBe(5.45);
  });
});

it("Claude is available only with a key and a budget", () => {
  expect(claudeAvailable({ ANTHROPIC_API_KEY: "k" })).toBe(true);
  expect(claudeAvailable({ ANTHROPIC_API_KEY: "k", CLAUDE_DAILY_BUDGET_USD: "0" })).toBe(false);
  expect(claudeAvailable({})).toBe(false);
});
