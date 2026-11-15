import type { Env } from "./env";
import { completeOnce, MODELS, type MessagesApi } from "./claude";

// K's standing rules for how listings are written (K, 2026-11-15): a suggestion box. K tells Claude, in the app,
// how a description should be better next time ("label the flaws section Problems"; "always say it's from a
// pet-free, smoke-free home"), and that becomes a rule every later listing follows, without a code change.
// Owner only (enforced in src/api.ts). Two kinds:
// - wording: how the text is written and laid out;
// - fact: something K states is true of every item K sells. It's K's fact (source "you"), so the rule that a
//   listing never states a fact that isn't in its inputs still holds.
// The rules shape wording only and sit below the fixed rules: sourced facts, the 80-character title, eBay's own
// rules. Contact details and links are refused in code, since eBay bans them in listings.

export interface ListingRule {
  id: string;
  kind: "wording" | "fact";
  text: string;
  at: number;
  by: string | null;
}

const KEY = "listing_rules";
export const MAX_RULES = 20;
export const MAX_RULE_TEXT = 300;

export async function getRules(env: Env): Promise<ListingRule[]> {
  return (await env.store.kv.getJson<ListingRule[]>(KEY).catch(() => null)) ?? [];
}

/** Why a rule can't be kept, or null. eBay bans contact details and links in listings, so a rule can't carry one. */
export function ruleProblem(text: string): string | null {
  const t = text.trim();
  if (t.length < 4) return "Say what should change.";
  if (t.length > MAX_RULE_TEXT) return `Keep it under ${MAX_RULE_TEXT} characters.`;
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return "A rule can't contain an email address: eBay doesn't allow contact details in listings.";
  if (/https?:\/\/|www\.|\.(com|co\.uk|net|org)\b/i.test(t)) return "A rule can't contain a web address: eBay doesn't allow links in listings.";
  if (/(?:\+?\d[\s-]?){9,}/.test(t)) return "A rule can't contain a phone number: eBay doesn't allow contact details in listings.";
  return null;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export interface RuleDraft {
  ok: boolean;
  kind: "wording" | "fact";
  text: string;
  /** The id of an existing rule this one replaces (it contradicts or restates it), or null. */
  replaces: string | null;
  /** Why it can't be a rule, or what to know about it. */
  note: string;
}

export const RULE_SYSTEM = `K, a UK eBay seller, is telling an app how its eBay listings (title and description) should be written from now on. Turn K's feedback into one short standing rule that a writer can follow for every future listing.

- text: one or two plain sentences, as an instruction ("Head the list of flaws 'Problems', not 'Flaws'."). Keep K's meaning exactly; don't add anything K didn't ask for.
- kind: "fact" when K states something true of every item K sells, to be said in the listing (for example that items come from a pet-free, smoke-free home). "wording" for anything about how the text is written, ordered, headed or laid out.
- replaces: if the feedback contradicts or restates one of the existing rules, that rule's id; otherwise null.
- ok: false when the feedback isn't a standing instruction about how listings are written: it's about one item only, about prices or postage, asks for contact details, links or selling outside eBay, or asks the listing to claim things that can't be known for every item (for example "always say fully working"). Then say why in note, in one plain sentence for K, and leave text empty.
- note: empty when ok, unless a rule is being replaced: then say which in a few words.`;

const RULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "kind", "text", "replaces", "note"],
  properties: {
    ok: { type: "boolean" },
    kind: { type: "string", enum: ["wording", "fact"] },
    text: { type: "string" },
    replaces: { type: ["string", "null"] },
    note: { type: "string" },
  },
} as const;

/** K's feedback turned into a rule for K to confirm. Nothing is saved here. */
export async function draftRule(env: Env, feedback: string, api?: MessagesApi): Promise<RuleDraft> {
  const said = clean(feedback).slice(0, 600);
  const problem = ruleProblem(said.slice(0, MAX_RULE_TEXT));
  if (said.length < 4 || (problem && !/under/.test(problem))) return { ok: false, kind: "wording", text: "", replaces: null, note: problem ?? "Say what should change." };
  const rules = await getRules(env);
  const asIs: RuleDraft = { ok: true, kind: "wording", text: said.slice(0, MAX_RULE_TEXT), replaces: null, note: "" };
  if (!env.ANTHROPIC_API_KEY && !api) return asIs;
  const out = await completeOnce<RuleDraft>(
    env,
    {
      job: "listing:rule",
      model: MODELS.triage,
      system: RULE_SYSTEM,
      prompt: `Existing rules:\n${rules.map((r) => `- [${r.id}] (${r.kind}) ${r.text}`).join("\n") || "- none"}\n\nK's feedback:\n${said}`,
      schema: RULE_SCHEMA,
      maxTokens: 600,
    },
    api,
  ).catch(() => null);
  // Claude unavailable: K's own words stand as the rule, for K to confirm.
  if (!out) return asIs;
  if (!out.ok) return { ok: false, kind: "wording", text: "", replaces: null, note: clean(out.note) || "That isn't something every listing can follow." };
  const text = clean(out.text).slice(0, MAX_RULE_TEXT);
  const bad = ruleProblem(text);
  if (bad) return { ok: false, kind: "wording", text: "", replaces: null, note: bad };
  return { ok: true, kind: out.kind === "fact" ? "fact" : "wording", text, replaces: rules.some((r) => r.id === out.replaces) ? out.replaces : null, note: clean(out.note).slice(0, 200) };
}

/** Saves a rule K confirmed (replacing one, if it says so). Throws with a plain reason when it can't be kept. */
export async function addRule(env: Env, b: { kind?: unknown; text?: unknown; replaces?: unknown }, by: string | null, now = Date.now()): Promise<ListingRule[]> {
  const text = clean(b.text);
  const problem = ruleProblem(text);
  if (problem) throw new Error(problem);
  const rules = (await getRules(env)).filter((r) => r.id !== b.replaces);
  if (rules.some((r) => r.text.toLowerCase() === text.toLowerCase())) throw new Error("That rule is already there.");
  if (rules.length >= MAX_RULES) throw new Error(`There are already ${MAX_RULES} rules. Remove one first: a short list is followed better.`);
  const next = [...rules, { id: now.toString(36) + Math.random().toString(36).slice(2, 6), kind: b.kind === "fact" ? ("fact" as const) : ("wording" as const), text, at: now, by }];
  await env.store.kv.setJson(KEY, next);
  return next;
}

export async function removeRule(env: Env, id: string): Promise<ListingRule[]> {
  const next = (await getRules(env)).filter((r) => r.id !== id);
  await env.store.kv.setJson(KEY, next);
  return next;
}

/** K's standing facts, as lines for a prompt's "K's facts" (source "you"). */
export const standingFacts = (rules: ListingRule[]) => rules.filter((r) => r.kind === "fact").map((r) => r.text);

/**
 * A listing-writing system prompt with K's rules added after the fixed ones. They change wording and layout
 * only; where one conflicts with a rule above it, the rule above wins.
 */
export function withListingRules(system: string, rules: ListingRule[]): string {
  if (!rules.length) return system;
  const wording = rules.filter((r) => r.kind === "wording");
  const facts = standingFacts(rules);
  return (
    system +
    "\n\nK's standing instructions for every listing, written by K in the app. Follow them for wording, headings and layout. The rules above always win over them: never a fact that isn't in the inputs, the title limit, sourced item specifics, no contact details or links." +
    (wording.length ? `\n${wording.map((r) => `- ${r.text}`).join("\n")}` : "") +
    (facts.length ? `\nTrue of every item K sells (K's own facts, source "you"); say them in the description where they fit:\n${facts.map((f) => `- ${f}`).join("\n")}` : "")
  );
}
