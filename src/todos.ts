import type { Env } from "./env";
import type { AuditReport, Finding } from "./firstday";
import type { Flag } from "./health";
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
    kind: "you",
    title: "Check the price",
    detail: (f) => `${f.title}. ${f.detail} The engine isn't confident enough to propose a change.`,
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
  return env.store.todos.sync("audit", { codes: AUDIT_TODO_CODES }, auditTodos(withCodes(report)), now);
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
  return env.store.todos.sync("nightly", { codes: ["engine_question", "own_price"], itemIds: priced }, todos, now);
}

/** A price in K's words ("£65", "65.50", "about 60 quid"): the first amount, or null. */
export function parsePrice(text: string): number | null {
  const m = text.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n < 100_000 ? Math.round(n * 100) / 100 : null;
}

const FLAG_ACTION: Record<string, string> = {
  stale: "Freshen this listing",
  watched_not_selling: "Nudge the watchers",
  low_views: "Help buyers find this listing",
  low_click_through: "Make this listing stand out in search",
};

/**
 * The nightly health flags that didn't end in an approval label: a to-do with the flags and what Claude's
 * triage said. Listings with a label waiting already have their item in the Inbox.
 */
export async function fileHealthTodos(
  env: Env,
  live: { itemId: string; title: string }[],
  flagged: { itemId: string; flags: Flag[] }[],
  notes: Map<string, string>,
  hasLabel: (itemId: string) => boolean,
  now: number,
) {
  const titles = new Map(live.map((l) => [l.itemId, l.title]));
  const todos: TodoInput[] = flagged
    .filter((f) => !hasLabel(f.itemId))
    .map((f) => {
      const note = notes.get(f.itemId);
      return {
        code: "health",
        kind: "you",
        itemId: f.itemId,
        itemTitle: titles.get(f.itemId) ?? null,
        title: FLAG_ACTION[f.flags[0].flag] ?? "Look at this listing",
        detail: [...f.flags.map((x) => x.detail), note ? `Claude: ${note}` : ""].filter(Boolean).join("\n"),
        fingerprint: f.flags.map((x) => x.flag).sort().join(","),
      };
    });
  const r = await env.store.todos.sync("nightly", { codes: ["health"], itemIds: live.map((l) => l.itemId) }, todos, now);
  const ended = await env.store.todos.resolveForEnded(live.map((l) => l.itemId), now);
  return { ...r, resolved: r.resolved + ended };
}

/** Claude's closing sentence for K, from a triage run's text. */
export function lastSentence(text: string): string {
  const t = text.trim().split(/\n+/).filter(Boolean).at(-1) ?? "";
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}
