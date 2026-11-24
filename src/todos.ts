import type { Env } from "./env";
import type { AuditReport, Finding } from "./firstday";
import { claudeAvailable } from "./rules";
import type { TodoInput } from "./store";

// Inbox to-dos (docs/approvals.md, "To-dos"): everything that needs K but isn't an eBay change. The first-day
// audit and the nightly run file them; each says what to do, first. Three kinds:
// - answer: only what K alone can know, with the answer box in the Inbox: what an item is when the engine
//   can't tell, the price when nothing comparable has sold, a fault. Never something Claude can do itself
//   (K, 2026-11-05): missing measurements are part of Claude's listing review, not a question.
// - claude: one per listing, "let Claude improve this listing"; it runs the Claude listing review, which files
//   ordinary approval labels.
// - you: something only K can do on eBay or in the app (photos, Best Offer), closed with Done or Dismiss.
// Findings that already have an approval label (fix "proposal") get no to-do: the label is the item.

const firstLine = (s: string) => s.split(/(?<=\.)\s/)[0].replace(/\.$/, "");

interface Wording {
  kind: "answer" | "you";
  title: string | ((f: Finding) => string);
  detail?: (f: Finding) => string;
  question?: (f: Finding) => string;
  /** What makes it the same problem; default the code alone. */
  fp?: (f: Finding) => string;
}

/** How each of K's to-do checks reads in the Inbox. Unlisted codes fall back to the finding's own words. */
const WORDING: Record<string, Wording> = {
  engine_question: {
    kind: "answer",
    title: "Answer the pricing engine's question",
    question: (f) => f.detail,
    detail: () => "Your answer is saved as a fact about this listing, then the engine prices it again.",
    fp: (f) => f.detail,
  },
  own_price: {
    kind: "answer",
    title: "Set the price yourself",
    question: (f) => f.detail,
    detail: () => "Your answer becomes this listing's price. The engine won't change it (clear it on Listings), and if it isn't the current price you get a label to approve.",
  },
  fault: {
    kind: "answer",
    title: "Describe the fault",
    question: () => "What's wrong with it, and what still works?",
    detail: (f) => f.detail,
  },
  condition_note: {
    kind: "answer",
    title: "Describe the condition",
    question: () => "Any marks, wear or missing parts? Or say it's in good condition.",
    detail: (f) => f.detail,
  },
  photos: { kind: "you", title: "Add more photos", detail: (f) => `${f.title} now. ${f.detail}`, fp: (f) => f.title },
  no_postage: { kind: "you", title: "Check the postage", detail: (f) => f.detail },
  handling: { kind: "you", title: "Shorten the handling time", detail: (f) => `${f.title}. ${f.detail}`, fp: (f) => f.title },
  best_offer: { kind: "you", title: "Consider turning on Best Offer", detail: (f) => f.detail },
  price_gap: {
    kind: "answer",
    title: "Check the price",
    question: () => "What should it sell for? Dismiss to keep today's price.",
    detail: (f) => `${f.title}. ${f.detail} The engine isn't confident enough to propose a change. Your answer becomes this listing's price, with a label to approve.`,
    fp: (f) => f.title.split(" by ")[0],
  },
  ended_unsold: { kind: "you", title: "Decide whether to relist", detail: (f) => f.detail },
  policy_return_period: { kind: "you", title: (f) => `Lengthen the returns in ${f.title.match(/"(.+)"/)?.[1] ?? "your return policy"} to 30 days`, detail: (f) => f.detail },
  policy_handling: { kind: "you", title: (f) => `Shorten the handling time in ${f.title.match(/"(.+)"/)?.[1] ?? "a postage policy"}`, detail: (f) => f.detail },
  policy_no_service: { kind: "you", title: (f) => `Add a UK postage service to ${f.title.match(/"(.+)"/)?.[1] ?? "a postage policy"}`, detail: (f) => f.detail },
  business_seller: { kind: "you", title: "Tell Claude you sell as a business", detail: (f) => f.detail },
  no_replies: { kind: "you", title: "Write your reply style", detail: () => "No past replies were found to learn from. Edit the style guide in Settings so drafts sound like you." },
};

/** Every check the audit files to-dos for: an audit run is responsible for all of them, on every listing. */
export const AUDIT_TODO_CODES = ["claude_review", ...Object.keys(WORDING), "measurements" /* now part of claude_review */];

/** Turns a finding K must deal with into a to-do. */
function fromFinding(f: Finding): TodoInput {
  const w = WORDING[f.code] ?? { kind: "you" as const, title: f.title, detail: (x: Finding) => x.detail };
  const policy = f.area === "settings" ? f.title : null;
  return {
    code: f.code,
    kind: w.kind,
    itemId: f.itemId ?? null,
    itemTitle: f.itemTitle ?? null,
    subject: f.itemId ? null : (policy ?? null),
    title: typeof w.title === "function" ? w.title(f) : w.title,
    detail: w.detail ? w.detail(f) : f.detail,
    question: w.question ? w.question(f) : null,
    fingerprint: `${f.code}|${w.fp ? w.fp(f) : ""}`,
  };
}

/** The audit's to-dos: one Claude review per listing that needs one, and each finding only K can fix. */
export function auditTodos(report: Pick<AuditReport, "listings" | "findings">): TodoInput[] {
  const out: TodoInput[] = [];
  for (const l of report.listings) {
    const forClaude = l.findings.filter((f) => f.fix === "claude");
    if (!forClaude.length) continue;
    out.push({
      code: "claude_review",
      kind: "claude",
      itemId: l.itemId,
      itemTitle: l.title,
      title: "Let Claude improve this listing",
      detail: forClaude.map((f) => `${f.title}: ${f.detail}`).join("\n"),
      fingerprint: forClaude.map((f) => f.code).sort().join(","),
    });
  }
  for (const f of report.findings) if (f.fix === "you") out.push(fromFinding(f));
  return out;
}

export async function fileAuditTodos(env: Env, report: Pick<AuditReport, "listings" | "findings">, now: number) {
  // With Claude off, a review nobody can run isn't filed (and one already open is left as it is).
  const codes = AUDIT_TODO_CODES.filter((c) => c !== "claude_review" || claudeAvailable(env));
  return env.store.todos.sync("audit", { codes }, auditTodos(withCodes(report)).filter((x) => x.code !== "claude_review" || claudeAvailable(env)), now);
}

/** Codes for findings in reports saved before findings had one (before 2026-11-05), from their wording. */
const OLD_TITLES: [RegExp, string][] = [
  [/^(Returns not accepted|You pay return postage)$/, "returns"],
  [/^Short title$/, "short_title"],
  [/^Title in capitals$/, "title_caps"],
  [/^Required item specifics missing$/, "required_specifics"],
  [/specifics found in published specs$/, "published_specifics"],
  [/^Measurements missing$/, "measurements"],
  [/other recommended item specifics missing$/, "other_specifics"],
  [/^Few item specifics$/, "few_specifics"],
  [/^No description$/, "no_description"],
  [/^Thin description$/, "thin_description"],
  [/^Fault not described$/, "fault"],
  [/^No condition note$/, "condition_note"],
  [/^\d+ photos?$/, "photos"],
  [/^No postage found$/, "no_postage"],
  [/^\d+-day handling time$/, "handling"],
  [/^Best Offer off$/, "best_offer"],
  [/^Not priced against the market$/, "not_priced"],
  [/^Engine needs your answer$/, "engine_question"],
  [/the market by \d+%$/, "price_gap"],
  [/^(Promote at|Lower the ad rate|End the promotion)/, "promotion"],
  [/^Ended unsold: /, "ended_unsold"],
  [/^Return policy .*(doesn't accept returns|you pay return postage)$/, "policy_returns"],
  [/^Return policy .*-day returns$/, "policy_return_period"],
  [/^Postage policy .*-day handling$/, "policy_handling"],
  [/^Postage policy .*has no UK service$/, "policy_no_service"],
  [/^Registered as a business seller$/, "business_seller"],
  [/^No past replies found$/, "no_replies"],
];
export const oldCode = (title: string) => OLD_TITLES.find(([re]) => re.test(title))?.[1] ?? `other:${title}`;

function withCodes<R extends Pick<AuditReport, "listings" | "findings">>(report: R): R {
  // Old reports asked K for missing measurements; Claude fills them now (from K's facts or published specs).
  const fix = (f: Finding): Finding => {
    const code = f.code ?? oldCode(f.title);
    return { ...f, code, fix: code === "measurements" && f.fix === "you" ? "claude" : f.fix };
  };
  return { ...report, findings: report.findings.map(fix), listings: report.listings.map((l) => ({ ...l, findings: l.findings.map(fix) })) };
}

/** The nightly price review's questions, for the listings it priced this run. */
export async function filePriceQuestions(env: Env, priced: string[], asked: { itemId: string; title: string; question: string; reason?: string }[], now: number) {
  // With Claude off the engine can't read K's answer about what the item is, so it isn't asked for; a price is.
  const codes = claudeAvailable(env) ? ["engine_question", "own_price"] : ["own_price"];
  const todos = asked.map((a) =>
    fromFinding({
      area: "listing",
      code: a.reason === "no_sales" ? "own_price" : "engine_question",
      severity: "medium",
      itemId: a.itemId,
      itemTitle: a.title,
      title: a.reason === "no_sales" ? "No sales to price from" : "Engine needs your answer",
      detail: a.question,
      fix: "you",
    }),
  );
  return env.store.todos.sync("nightly", { codes, itemIds: priced }, todos.filter((x) => codes.includes(x.code)), now);
}

/** A price in K's words ("£65", "65.50", "about 60 quid"): the first amount, or null. */
export function parsePrice(text: string): number | null {
  const m = text.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n < 100_000 ? Math.round(n * 100) / 100 : null;
}

/**
 * Closes to-dos that no longer apply. Health flags alone are never a to-do (K, 2026-11-24): "help buyers find this
 * listing" with nothing to approve helps nobody. The sales ladder files the step that can be taken, as a label, and
 * says nothing when there isn't one; the flags themselves stay on Insights.
 */
export async function closeStaleTodos(env: Env, live: { itemId: string }[], now: number) {
  const ids = live.map((l) => l.itemId);
  const r = await env.store.todos.sync("nightly", { codes: ["health"], itemIds: ids }, [], now);
  return { opened: r.opened, resolved: r.resolved + (await env.store.todos.resolveForEnded(ids, now)) };
}

/** Days an own-priced listing may go unsold before the Inbox suggests K reviews the price (and again after each further period). */
export const OWN_PRICE_REVIEW_DAYS = 30;

/**
 * A listing on K's own price isn't forgotten (K, 2026-11-05): after 30 days unsold, a to-do suggests K reviews
 * it, with what has happened since. Dismissed, it comes back after the next 30 days (the period is in the
 * fingerprint). It closes when the listing ends or K's price is cleared.
 */
export async function fileOwnPriceReminders(
  env: Env,
  live: { itemId: string; title: string; price: number; watchers: number; views7d: number | null }[],
  settings: Map<string, { own_price: number | null; own_price_set_at?: number | null }>,
  now: number,
) {
  const todos: TodoInput[] = [];
  for (const l of live) {
    const s = settings.get(l.itemId);
    if (s?.own_price == null || !s.own_price_set_at) continue;
    const days = Math.floor((now - s.own_price_set_at) / 86_400_000);
    if (days < OWN_PRICE_REVIEW_DAYS) continue;
    const since = new Date(s.own_price_set_at).toISOString().slice(0, 10);
    todos.push({
      code: "own_price_review",
      kind: "answer",
      question: `A new price for it? (Now £${s.own_price.toFixed(2)})`,
      itemId: l.itemId,
      itemTitle: l.title,
      title: `Review your price: no sale in ${days} days`,
      detail: [
        `You set £${s.own_price.toFixed(2)} on ${since}, as nothing comparable had sold. The engine still finds no market for it, and looks again each week.`,
        `Now: ${l.watchers} watcher${l.watchers === 1 ? "" : "s"}${l.views7d != null ? `, ${l.views7d} view${l.views7d === 1 ? "" : "s"} in the last 7 days` : ""}.`,
        `Answer with a new price and it becomes your price, with a label to change the listing; or dismiss to keep £${s.own_price.toFixed(2)} for another ${OWN_PRICE_REVIEW_DAYS} days. An offer to watchers or relisting can also help.`,
      ].join("\n"),
      fingerprint: `period:${Math.floor(days / OWN_PRICE_REVIEW_DAYS)}`,
    });
  }
  return env.store.todos.sync("nightly", { codes: ["own_price_review"], itemIds: live.map((l) => l.itemId) }, todos, now);
}

/** Claude's closing sentence for K, from a triage run's text. */
export function lastSentence(text: string): string {
  const t = text.trim().split(/\n+/).filter(Boolean).at(-1) ?? "";
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}
