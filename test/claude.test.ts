import { beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import { costUsd, MODELS, runAgent, type MessagesApi } from "../src/claude";
import { AUDIT_SYSTEM, AUDIT_TOOLS } from "../src/jobs";
import { tools } from "../src/tools";

const usage = (input = 1000, output = 200, cacheRead = 0) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 }) as Anthropic.Beta.BetaUsage;

const msg = (stop: string, content: any[]) =>
  ({ id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, usage: usage() }) as unknown as Anthropic.Beta.BetaMessage;

function scripted(responses: Anthropic.Beta.BetaMessage[]) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const api: MessagesApi = {
    async create(params) {
      calls.push(structuredClone(params));
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
  return { api, calls };
}

let env: Env;
beforeEach(() => {
  env = { DB: fakeD1(), EBAY_ENV: "sandbox", WRITE_MODE: "approval" } as Env;
});

const run = (over: Partial<Parameters<typeof runAgent>[1]> = {}) => ({
  job: "test",
  model: MODELS.audit,
  system: "Stable system prompt.",
  prompt: "Go.",
  toolNames: ["list_proposals"],
  ...over,
});

describe("Claude tool-use loop", () => {
  it("runs a tool, sends all results back in one user turn, and logs each call's cost", async () => {
    const { api, calls } = scripted([
      msg("tool_use", [
        { type: "tool_use", id: "t1", name: "list_proposals", input: {} },
        { type: "tool_use", id: "t2", name: "list_proposals", input: { status: "applied" } },
      ]),
      msg("end_turn", [{ type: "text", text: "Nothing to change." }]),
    ]);
    const r = await runAgent(env, run(), api);
    expect(r.text).toBe("Nothing to change.");
    expect(r.turns).toBe(2);
    expect(calls).toHaveLength(2);

    const second = calls[1].messages;
    expect(second.at(-2)?.role).toBe("assistant");
    const results = second.at(-1)?.content as any[];
    expect(results.map((b) => [b.type, b.tool_use_id, b.content])).toEqual([
      ["tool_result", "t1", "[]"],
      ["tool_result", "t2", "[]"],
    ]);

    const logged = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(cost_usd) AS usd FROM claude_usage").first<any>();
    expect(logged.n).toBe(2);
    expect(logged.usd).toBeCloseTo(2 * costUsd(MODELS.audit, usage()), 10);
  });

  it("refuses tools outside the job's allowlist without running them", async () => {
    const { api, calls } = scripted([
      msg("tool_use", [{ type: "tool_use", id: "t1", name: "pause_writes", input: {} }]),
      msg("end_turn", [{ type: "text", text: "ok" }]),
    ]);
    await runAgent(env, run(), api);
    const result = (calls[1].messages.at(-1)?.content as any[])[0];
    expect(result.is_error).toBe(true);
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'writes_paused'").first()).toBeNull();
    // Only allowlisted tools are even offered.
    expect(calls[0].tools?.map((t: any) => t.name)).toEqual(["list_proposals"]);
  });

  it("stops at the turn limit", async () => {
    const { api, calls } = scripted([msg("tool_use", [{ type: "tool_use", id: "t", name: "list_proposals", input: {} }])]);
    const r = await runAgent(env, run({ maxTurns: 3 }), api);
    expect(calls).toHaveLength(3);
    expect(r.stopReason).toBe("tool_use");
  });

  it("won't start once today's budget is spent", async () => {
    await env.DB.prepare(
      "INSERT INTO claude_usage (at, job, model, input_tokens, output_tokens, cost_usd) VALUES (?, 'x', 'y', 0, 0, 5)",
    )
      .bind(Date.now())
      .run();
    const { api, calls } = scripted([msg("end_turn", [])]);
    await expect(runAgent(env, run(), api)).rejects.toThrow(/budget/);
    expect(calls).toHaveLength(0);
  });

  it("needs an API key when no stand-in is given", async () => {
    await expect(runAgent(env, run())).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("caches a stable prefix and asks for refusal fallbacks on Sonnet only", async () => {
    const sonnet = scripted([msg("end_turn", [])]);
    await runAgent(env, run(), sonnet.api);
    const p = sonnet.calls[0] as any;
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.output_config).toEqual({ effort: "medium" });

    const haiku = scripted([msg("end_turn", [])]);
    await runAgent(env, run({ model: MODELS.triage }), haiku.api);
    expect((haiku.calls[0] as any).fallbacks).toBeUndefined();
  });
});

describe("audit job", () => {
  it("offers only read and propose tools, all of which exist", () => {
    const names = tools.map((t) => t.name);
    for (const t of AUDIT_TOOLS) expect(names).toContain(t);
    expect(AUDIT_TOOLS.every((t) => /^(get_|search_|list_|propose_)/.test(t))).toBe(true);
  });

  it("keeps the system prompt free of anything that changes per run", () => {
    expect(AUDIT_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}|\$\{/);
  });

  it("prices Sonnet and Haiku calls from the usage block", () => {
    expect(costUsd(MODELS.audit, usage(1_000_000, 0))).toBeCloseTo(2);
    expect(costUsd(MODELS.triage, usage(0, 1_000_000))).toBeCloseTo(0.5);
    expect(costUsd(MODELS.audit, usage(0, 0, 1_000_000))).toBeCloseTo(0.2);
  });
});
