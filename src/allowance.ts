import type { Env } from "./env";
import { push } from "./notify";
import { CLAUDE_DAILY_BUDGET_USD } from "./rules";
import { MONTHLY_CAP, providerEnabled, refreshQuota, usedThisMonth, type Provider } from "./solddata";
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
      // The provider's own figures (free to ask for, and they include searches made outside this app); the
      // app's own count only if the provider can't be reached.
      const q = await refreshQuota(env, p, 5 * 60_000, now);
      const cap = q?.limit ?? MONTHLY_CAP[p];
      const left = q ? q.remaining : Math.max(0, cap - (await usedThisMonth(env, p)));
      const level = left <= 0 ? "out" : cap > 0 && left / cap <= LOW_SHARE ? "low" : "ok";
      const resets = `Resets ${new Date(q?.resetAt ?? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1)).toISOString().slice(0, 10)}.`;
      const source = q
        ? `As reported by ${p === "trawl" ? "Trawl" : "CompsAPI"} ${minutesAgo(now - q.at)}.`
        : `Counted by this app only (${p === "trawl" ? "Trawl" : "CompsAPI"} couldn't be reached): searches made elsewhere with the same key aren't included.`;
      return { id: p, name, left, total: cap, unit: "searches", summary: `${left} of ${cap} searches left this month`, notes: [resets, source], level };
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
            ? `${a.name} has used all ${a.total} of this month's searches. Prices use the other provider and cached results until the 1st.`
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
