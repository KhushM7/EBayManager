import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { CLAUDE_DAILY_BUDGET_USD } from "./rules";
import { tools } from "./tools";

// Claude, called from the Worker with K's API key. A manual tool-use loop over an allowlist of the tools in
// src/tools.ts: none of them can change eBay (propose_* only record proposals for K), every call's cost is
// logged to claude_usage, and a daily budget stops runs before they start.

export const MODELS = { audit: "claude-sonnet-5-5", triage: "claude-haiku-5-5" } as const;
type Model = (typeof MODELS)[keyof typeof MODELS];

/** USD per million tokens (Anthropic list prices; cache writes 1.25x input, reads 0.1x). */
const PRICES: Record<Model, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

/** Per web search (server tool), USD. */
export const WEB_SEARCH_USD = 0.01;

export function costUsd(model: Model, u: Anthropic.Beta.BetaUsage): number {
  const p = PRICES[model];
  const m =
    u.input_tokens * p.input +
    u.output_tokens * p.output +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead;
  // Web searches cost $10 per 1,000 on top of tokens.
  return m / 1_000_000 + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

export async function spentTodayUsd(env: Env): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  return (await env.store.usage.since(since.getTime())).reduce((sum, u) => sum + u.cost_usd, 0);
}

/** The subset of the Messages API this loop uses, so tests can stand in for it. */
export interface MessagesApi {
  create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage>;
}

export interface AgentRun {
  job: string;
  model: Model;
  system: string;
  prompt: string;
  /** Names from src/tools.ts Claude may call in this run. Anything else is refused. */
  toolNames: string[];
  maxTurns?: number;
  effort?: "low" | "medium" | "high";
}

export interface AgentResult {
  text: string;
  turns: number;
  costUsd: number;
  stopReason: string | null;
}

const MAX_TOOL_RESULT_CHARS = 20_000;

export async function client(env: Env, api?: MessagesApi): Promise<MessagesApi> {
  if (!api && !env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on this Worker yet.");
  const spent = await spentTodayUsd(env);
  if (spent >= CLAUDE_DAILY_BUDGET_USD)
    throw new Error(`Today's Claude budget of $${CLAUDE_DAILY_BUDGET_USD.toFixed(2)} is used up ($${spent.toFixed(2)}).`);
  return api ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).beta.messages;
}

export async function logUsage(env: Env, job: string, model: Model, response: Anthropic.Beta.BetaMessage): Promise<number> {
  const cost = costUsd(model, response.usage);
  await env.store.usage.log({
    at: Date.now(),
    job,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cost_usd: cost,
    stop_reason: response.stop_reason,
  });
  return cost;
}

/**
 * One request, no tools: for drafts. With a JSON schema the reply is structured output, parsed and returned;
 * otherwise the text. Returns null when Claude declined or ran out of room.
 */
/** Images per request: enough for a full set of listing photos; URL lists (identification) pass at most 4. */
export const MAX_IMAGES = 12;

export async function completeOnce<T = string>(
  env: Env,
  req: {
    job: string;
    model: Model;
    system: string;
    prompt: string;
    schema?: Record<string, unknown>;
    effort?: "low" | "medium" | "high";
    /**
     * Images shown before the prompt: public URLs (eBay photos), or JPEG bytes as base64 (K's private draft
     * photos, which never get a public address).
     */
    images?: (string | { base64: string })[];
    maxTokens?: number;
  },
  api?: MessagesApi,
): Promise<T | null> {
  const messagesApi = await client(env, api);
  const images = (req.images ?? []).filter((u) => typeof u !== "string" || /^https:\/\//.test(u)).slice(0, MAX_IMAGES);
  const content: string | Anthropic.Beta.BetaContentBlockParam[] = images.length
    ? [
        ...images.map((img) =>
          typeof img === "string"
            ? { type: "image" as const, source: { type: "url" as const, url: img } }
            : { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: img.base64 } },
        ),
        { type: "text" as const, text: req.prompt },
      ]
    : req.prompt;
  const response = await messagesApi.create({
    model: req.model,
    max_tokens: req.maxTokens ?? 4000,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { effort: req.effort ?? "low", ...(req.schema ? { format: { type: "json_schema" as const, schema: req.schema } } : {}) },
  });
  await logUsage(env, req.job, req.model, response);
  if (response.stop_reason !== "end_turn") return null;
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return (req.schema ? JSON.parse(text) : text) as T;
}

export async function runAgent(env: Env, run: AgentRun, api?: MessagesApi): Promise<AgentResult> {
  const messagesApi = await client(env, api);
  const allowed = tools.filter((t) => run.toolNames.includes(t.name));
  // Stable order and a stable system prompt keep the cached prefix (tools, then system) byte-identical.
  const toolDefs: Anthropic.Beta.BetaTool[] = allowed.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: run.system, cache_control: { type: "ephemeral" } }];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: run.prompt }];

  let total = 0;
  let turns = 0;
  let last: Anthropic.Beta.BetaMessage | null = null;
  const maxTurns = run.maxTurns ?? 12;

  while (turns < maxTurns) {
    turns++;
    const response = await messagesApi.create({
      model: run.model,
      max_tokens: 16000,
      system,
      tools: toolDefs,
      messages,
      output_config: { effort: run.effort ?? "medium" },
      // Sonnet 5.5 on the Claude API: a refused request is re-run on a fallback model inside the same call.
      ...(run.model === MODELS.audit ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    last = response;
    total += await logUsage(env, run.job, run.model, response);

    // Thinking and fallback blocks go back unchanged with the rest of the turn.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") break;

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const results = await Promise.all(
      calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const tool = allowed.find((t) => t.name === call.name);
        if (!tool) return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Tool ${call.name} is not available in this job.` };
        try {
          const out = JSON.stringify(await tool.run(env, call.input ?? {}));
          return { type: "tool_result", tool_use_id: call.id, content: out.length > MAX_TOOL_RESULT_CHARS ? out.slice(0, MAX_TOOL_RESULT_CHARS) + " …(truncated)" : out };
        } catch (e) {
          return { type: "tool_result", tool_use_id: call.id, is_error: true, content: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
  }

  const text = (last?.content ?? [])
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { text, turns, costUsd: total, stopReason: last?.stop_reason ?? null };
}
