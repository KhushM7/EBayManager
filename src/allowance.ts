import type { Env } from "./env";
import { push } from "./notify";
import { CLAUDE_DAILY_BUDGET_USD } from "./rules";
import { MONTHLY_CAP, providerEnabled, providerKeys, refreshQuota, usedThisMonth, type Provider, type Slot } from "./solddata";
import type { TodoInput } from "./store/todos";

// What's left of each paid allowance the app uses: Claude credit (and today's budget) and the sold-data
// providers' monthly searches. Shown in Settings; when one runs low or out, an Inbox to-do and a notification.
//
// Anthropic doesn't report a prepaid balance through an API key, so K enters the balance shown in the Claude
// Console, and what's left is that figure less what the app has logged since. It's an estimate: spend from
// anywhere else on the same key isn't seen.

/** A to-do opens at or below this share left (and again when it runs out). */
export const LOW_SHARE = 0.2;
/** Claude credit counts as low at or below this many dollars, whatever the share. */
export const CLAUDE_LOW_USD = 2;
/**
 * Sold data (K, 2026-11-07): alert only when the first key is used up and the second is below this share
 * (with one key, when it is below this share).
 */
export const KEY_LOW_SHARE = 0.1;

const CREDIT_KEY = "claude_credit";

export interface Allowance {
  id: "claude" | Provider;
  name: string;
  /** What's left, in the allowance's own unit; null when unknown (Claude credit not entered). */
  left: number | null;
  /** The size of the allowance (the entered balance, or the monthly cap). */
  total: number | null;
  unit: "usd" | "searches";
  /** Plain words for Settings: "$3.65 left", "180 of 250 searches left this month". */
  summary: string;
  /** Extra lines (today's budget, when the balance was entered). */
  notes: string[];
  level: "ok" | "low" | "out" | "unknown" | "off";
  /** Sold data: each key's own figures, and which one searches use now. */
  keys?: { slot: Slot; left: number; total: number; inUse: boolean; reported: boolean }[];
}

const money = (n: number) => `$${n.toFixed(2)}`;
const minutesAgo = (ms: number) => (ms < 90_000 ? "just now" : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} minutes ago` : `${Math.round(ms / 3_600_000)} hours ago`);
const dayStart = (now: number) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};

export async function getClaudeCredit(env: Env): Promise<{ usd: number; at: number } | null> {
  return env.store.kv.getJson<{ usd: number; at: number }>(CREDIT_KEY).catch(() => null);
}

/** K's entry from the Claude Console's balance (owner only, from Settings). null clears it. */
export async function setClaudeCredit(env: Env, usd: number | null, now = Date.now()) {
  if (usd == null) return env.store.kv.set(CREDIT_KEY, "null");
  if (!Number.isFinite(usd) || usd < 0 || usd > 100_000) throw new Error("Enter the balance in dollars, like 12.50.");
  await env.store.kv.set(CREDIT_KEY, JSON.stringify({ usd: Math.round(usd * 100) / 100, at: now }));
}

export async function allowances(env: Env, now = Date.now()): Promise<Allowance[]> {
  const credit = await getClaudeCredit(env);
  const since = Math.min(dayStart(now), credit?.at ?? Infinity);
  const rows = await env.store.usage.since(since);
  const today = rows.filter((r) => r.at >= dayStart(now)).reduce((s, r) => s + r.cost_usd, 0);
  const budgetLeft = Math.max(0, CLAUDE_DAILY_BUDGET_USD - today);
  const notes = [`Today: ${money(today)} of the ${money(CLAUDE_DAILY_BUDGET_USD)} daily budget used${budgetLeft <= 0 ? " (used up until midnight UTC)" : ""}.`];

  let claude: Allowance;
  if (!env.ANTHROPIC_API_KEY) {
    claude = { id: "claude", name: "Claude", left: null, total: null, unit: "usd", summary: "No API key set", notes: [], level: "off" };
  } else if (!credit) {
    claude = { id: "claude", name: "Claude", left: null, total: null, unit: "usd", summary: "Balance not entered", notes, level: "unknown" };
  } else {
    const spent = rows.filter((r) => r.at >= credit.at).reduce((s, r) => s + r.cost_usd, 0);
    const left = Math.max(0, Math.round((credit.usd - spent) * 100) / 100);
    const share = credit.usd > 0 ? left / credit.usd : 0;
    const level = left <= 0 ? "out" : left <= CLAUDE_LOW_USD || share <= LOW_SHARE ? "low" : "ok";
    claude = {
      id: "claude",
      name: "Claude",
      left,
      total: credit.usd,
      unit: "usd",
      summary: `${money(left)} left`,
      notes: [...notes, `From ${money(credit.usd)} entered ${new Date(credit.at).toISOString().slice(0, 10)}, less ${money(spent)} the app has used since.`],
      level,
    };
  }

  const sold = await Promise.all(
    (["trawl", "compsapi"] as Provider[]).map(async (p): Promise<Allowance> => {
      const name = p === "trawl" ? "Trawl (sold prices)" : "CompsAPI (sold prices)";
      if (!providerEnabled(env, p)) return { id: p, name, left: null, total: null, unit: "searches", summary: "Not set up", notes: [], level: "off" };
      const who = p === "trawl" ? "Trawl" : "CompsAPI";
      // Each key's own figures from the provider (free to ask for, and they include searches made outside
      // this app); the app's own count only if the provider can't be reached.
      const keys = [];
      let resetAt: number | null = null;
      let oldest: number | null = null;
      for (const k of providerKeys(env, p)) {
        const q = await refreshQuota(env, p, k.slot, 5 * 60_000, now);
        const total = q?.limit ?? MONTHLY_CAP[p];
        const left = q ? q.remaining : Math.max(0, total - (await usedThisMonth(env, p, k.slot)));
        if (q) {
          resetAt = Math.min(resetAt ?? Infinity, q.resetAt);
          oldest = Math.min(oldest ?? Infinity, q.at);
        }
        keys.push({ slot: k.slot, left, total, inUse: false, reported: Boolean(q) });
      }
      const inUse = keys.find((k) => k.left > 0);
      if (inUse) inUse.inUse = true;
      const left = keys.reduce((s, k) => s + k.left, 0);
      const total = keys.reduce((s, k) => s + k.total, 0);
      // The alert rule: with two keys, the first used up and the second below 10%; with one, it below 10%.
      const [first, second] = keys;
      const low = second ? first.left <= 0 && second.left / second.total < KEY_LOW_SHARE : first.left / first.total < KEY_LOW_SHARE;
      const level = left <= 0 ? "out" : low ? "low" : "ok";
      const resets = `Resets ${new Date(resetAt ?? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1)).toISOString().slice(0, 10)}.`;
      const source = keys.every((k) => k.reported)
        ? `As reported by ${who} ${minutesAgo(now - (oldest ?? now))}.`
        : `Partly counted by this app (${who} couldn't be reached): searches made elsewhere with the same key aren't included.`;
      const summary =
        keys.length > 1
          ? inUse
            ? `Key ${inUse.slot} in use: ${inUse.left} of ${inUse.total} left`
            : "Both keys used up"
          : `${left} of ${total} searches left this month`;
      return { id: p, name, left, total, unit: "searches", summary, notes: [resets, source], level, keys };
    }),
  );
  return [claude, ...sold];
}

const CODE = "allowance_low";

/**
 * Files an Inbox to-do for each allowance that's low or out, resolves those that recovered, and sends a
 * notification for each newly opened one. Cheap (store reads only): run nightly and after each inbox poll.
 */
export async function checkAllowances(env: Env, now = Date.now()): Promise<string> {
  const all = await allowances(env, now);
  const month = new Date(now).toISOString().slice(0, 7);
  const todos: TodoInput[] = all
    .filter((a) => a.level === "low" || a.level === "out")
    .map((a) => {
      const out = a.level === "out";
      const what =
        a.id === "claude"
          ? out
            ? "Claude's credit has run out: listing checks, reviews and reply drafts will stop until it's topped up."
            : `Claude's credit is running low: ${a.summary}. Top it up in the Claude Console, then enter the new balance in Settings.`
          : out
            ? `${a.name} has used all of this month's searches${(a.keys?.length ?? 0) > 1 ? " on both keys" : ""}. Prices use the other provider and cached results until it resets.`
            : (a.keys?.length ?? 0) > 1
              ? `${a.name}: the first key is used up and the second has ${a.keys![1].left} of ${a.keys![1].total} searches left this month.`
              : `${a.name}: ${a.summary}.`;
      return {
        code: CODE,
        kind: "you",
        itemId: null,
        itemTitle: null,
        subject: a.id,
        title: `${a.id === "claude" ? "Claude credit" : a.name.replace(/ \(.+\)$/, "") + " searches"} ${out ? "used up" : "running low"}`,
        detail: what,
        // Same problem until it gets worse, or (sold data) a new month starts; a new balance is a new one too.
        fingerprint: `${a.level}|${a.id === "claude" ? a.total : month}`,
      } satisfies TodoInput;
    });
  const before = new Set((await env.store.todos.list("open")).filter((t) => t.code === CODE).map((t) => t.id));
  const r = await env.store.todos.sync("allowance", { codes: [CODE] }, todos, now);
  if (r.opened) {
    const fresh = (await env.store.todos.list("open")).filter((t) => t.code === CODE && !before.has(t.id));
    for (const t of fresh) await push(env, t.title, t.detail, undefined, `allowance-${t.id}`).catch(() => null);
  }
  return `${todos.length} low or out${r.opened ? `, ${r.opened} new` : ""}`;
}
