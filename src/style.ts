import type { Env } from "./env";
import { completeOnce, MODELS, type MessagesApi } from "./claude";
import type { PastReply } from "./ebay/history";

// K's reply style guide (docs/listing-assistant.md, "Replies in K's voice"), learned once from K's past answers
// to buyers and editable by K. Every reply and offer draft follows it. It shapes wording only: the drafting
// rules (facts only from the listing, no price agreements, everything kept on eBay) come first, and the code
// still decides every offer answer and price.

export interface StyleGuide {
  tone: string;
  length: string;
  greeting: string;
  signOff: string;
  habits: string[];
  /** How K usually phrases common answers. Wording only: facts still come from the listing. */
  phrasings: { topic: string; example: string }[];
  avoid: string[];
  /** What it was learned from. */
  source: { replies: number; from: string | null; to: string | null; learned: boolean };
  at: number;
  editedBy: string | null;
  /** STYLE_VERSION when learned; an older unedited guide is relearned on the next audit. */
  version?: number;
}

/** 2: learns only from replies before a sale, never copies typos, no refund or price-stance phrasings. */
export const STYLE_VERSION = 2;

/** After-sale messages (delivery, refunds, damage, feedback) aren't the replies the drafts write. */
const AFTER_SALE = /refund|return|parcel|posted|dispatch|sent (it|out)|delivery|delivered|tracking|courier|arrived|damaged|broken|faulty|feedback|case opened|collected|paid|payment/i;

/** The replies a style guide learns from: answers to buyers before a sale, not after-sale messages. */
export function preSaleReplies(replies: PastReply[]): PastReply[] {
  return replies.filter((r) => !AFTER_SALE.test(r.reply) && !AFTER_SALE.test(r.question));
}

/** Used until there are past replies to learn from, and as the starting point K can edit. */
export const DEFAULT_STYLE: Omit<StyleGuide, "at" | "source" | "editedBy"> = {
  tone: "Friendly, plain and helpful",
  length: "Two to four short sentences",
  greeting: "Hi,",
  signOff: "Thanks",
  habits: ["Answers the question in the first sentence", "British English"],
  phrasings: [],
  avoid: ["Exclamation marks in every sentence", "Over-promising"],
};

const STYLE_KEY = "reply_style";
const MAX_TEXT = 2000;

export const STYLE_SYSTEM = `You study a UK eBay seller's (K's) past replies to buyers and write a short style guide, so drafts of future replies sound like K.

The drafts this guide shapes are only answers to buyers' questions before a sale, and the short message sent with K's answer to an offer. Ignore anything about after-sale matters (delivery, delays, refunds, returns, damage).

Describe how K writes, not what K said about particular items:
- tone: a few words (for example "warm and brief", "formal and precise");
- length: typical length in sentences;
- greeting and signOff: K's usual opening and closing exactly as K writes them (for example "Hi," or "Hello there," and "Thanks, K" or "Many thanks"), or "none" if K doesn't use one;
- habits: up to 6 short points (spelling such as British English, use of emoji or exclamation marks, how K answers "is it still available", how K handles price questions);
- phrasings: up to 6 examples of how K words common answers (postage, condition, availability, returns, offers), each one short and with any item detail, name, number or address replaced by [brackets];
- avoid: up to 4 things K never does.

Never copy buyer names, usernames, addresses, phone numbers, emails or order numbers into the guide. Don't record spelling mistakes, typos or missing apostrophes as habits: drafts are written correctly. Don't record a stance on price or offers (such as refusing lower offers) or offers of refunds: the app decides those, not the guide. If there are few replies, keep the guide short and say only what the replies show.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tone", "length", "greeting", "signOff", "habits", "phrasings", "avoid"],
  properties: {
    tone: { type: "string" },
    length: { type: "string" },
    greeting: { type: "string" },
    signOff: { type: "string" },
    habits: { type: "array", items: { type: "string" } },
    phrasings: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["topic", "example"], properties: { topic: { type: "string" }, example: { type: "string" } } },
    },
    avoid: { type: "array", items: { type: "string" } },
  },
};

/** Contact details never belong in a guide, even if Claude copied one. */
export function scrub(s: string): string {
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/(\+44|0)\s?\d[\d\s]{8,12}\d/g, "[phone]")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/\b\d{2}-\d{5}-\d{5}\b/g, "[order]")
    .slice(0, 300);
}

/** Cleans a guide from Claude or from K's edit: trims, caps the lists, removes contact details. */
export function cleanGuide(g: Partial<StyleGuide>, source: StyleGuide["source"], editedBy: string | null = null): StyleGuide {
  const strs = (xs: unknown, n: number) => (Array.isArray(xs) ? xs : []).map((x) => scrub(String(x)).trim()).filter(Boolean).slice(0, n);
  return {
    tone: scrub(g.tone ?? DEFAULT_STYLE.tone).trim() || DEFAULT_STYLE.tone,
    length: scrub(g.length ?? DEFAULT_STYLE.length).trim() || DEFAULT_STYLE.length,
    greeting: scrub(g.greeting ?? DEFAULT_STYLE.greeting).trim(),
    signOff: scrub(g.signOff ?? DEFAULT_STYLE.signOff).trim(),
    habits: strs(g.habits, 8),
    phrasings: (Array.isArray(g.phrasings) ? g.phrasings : [])
      .map((p: any) => ({ topic: scrub(p?.topic ?? "").trim(), example: scrub(p?.example ?? "").trim() }))
      .filter((p) => p.topic && p.example)
      .slice(0, 8),
    avoid: strs(g.avoid, 6),
    source,
    at: Date.now(),
    editedBy,
    version: STYLE_VERSION,
  };
}

/** Builds the guide from K's past replies with Claude (Sonnet, once), or the default when there are none. */
export async function learnStyle(env: Env, replies: PastReply[], api?: MessagesApi): Promise<StyleGuide> {
  const seen = new Set<string>();
  const usable = preSaleReplies(replies)
    .filter((r) => r.reply.trim().length > 1 && !seen.has(r.reply) && seen.add(r.reply))
    .slice(0, 60);
  const dates = usable.map((r) => r.at).filter((x): x is string => Boolean(x)).sort();
  const source = { replies: usable.length, from: dates[0]?.slice(0, 10) ?? null, to: dates.at(-1)?.slice(0, 10) ?? null, learned: false };
  if (!usable.length || (!env.ANTHROPIC_API_KEY && !api)) return cleanGuide(DEFAULT_STYLE, source);
  const text = usable
    .map((r, i) => `#${i + 1}${r.question ? `\nBuyer asked: ${r.question.slice(0, 400)}` : ""}\nK replied: ${r.reply.slice(0, 800)}`)
    .join("\n\n");
  const g = await completeOnce<Partial<StyleGuide>>(
    env,
    { job: "style:learn", model: MODELS.audit, system: STYLE_SYSTEM, prompt: `K's past replies (${usable.length}):\n\n${text}`, schema: SCHEMA, effort: "medium" },
    api,
  );
  if (!g) return cleanGuide(DEFAULT_STYLE, source);
  return cleanGuide(g, { ...source, learned: true });
}

export async function getStyle(env: Env): Promise<StyleGuide | null> {
  return env.store.kv.getJson<StyleGuide>(STYLE_KEY);
}

export async function saveStyle(env: Env, g: StyleGuide): Promise<void> {
  await env.store.kv.setJson(STYLE_KEY, g);
}

/** K's edit: any field K sends replaces the stored one. */
export async function editStyle(env: Env, changes: Partial<StyleGuide>, editedBy: string): Promise<StyleGuide> {
  const current = (await getStyle(env)) ?? cleanGuide(DEFAULT_STYLE, { replies: 0, from: null, to: null, learned: false });
  const merged = cleanGuide({ ...current, ...changes }, current.source, editedBy);
  await saveStyle(env, merged);
  return merged;
}

/** The guide as text for a drafting prompt; empty when there's none. Capped, and always below the rules. */
export function styleText(g: StyleGuide | null): string {
  if (!g) return "";
  const lines = [
    `Tone: ${g.tone}. Length: ${g.length}.`,
    `Greeting: ${g.greeting || "none"}. Sign-off: ${g.signOff || "none"}.`,
    ...g.habits.map((h) => `- ${h}`),
    ...g.phrasings.map((p) => `- ${p.topic}: "${p.example}"`),
    ...g.avoid.map((a) => `- Avoid: ${a}`),
  ];
  return lines.join("\n").slice(0, MAX_TEXT);
}

/**
 * A drafting system prompt with K's style guide added after the rules. The guide changes wording only;
 * where it conflicts with a rule above it (greeting lines included), the rule wins.
 */
export async function withStyle(env: Env, system: string): Promise<string> {
  const text = styleText(await getStyle(env).catch(() => null));
  if (!text) return system;
  return `${system}\n\nK's style guide, learned from K's past replies. Follow it for wording, greeting, sign-off and length. The rules above always win over it, and [bracketed] parts are placeholders, never facts:\n${text}`;
}
