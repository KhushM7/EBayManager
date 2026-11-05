import type { Env } from "../env";
import { completeOnce, MODELS, type MessagesApi } from "../claude";
import { isJunk, wordsFromTitle } from "../solddata";

// Steps 1 and 3 of the pricing engine (docs/pricing-engine.md): Claude Haiku identifies what a listing is from
// its title, item specifics, description and photos (images and text together beat either alone), writes the
// searches, then grades each found sale or listing as an exact or close match, with a value adjustment for
// close ones (as valuers adjust each comparable, not the subject). Without an Anthropic key, word rules stand in.

export interface Component {
  /** Short name for K, such as "Fire TV remote". */
  name: string;
  /** Search words for sold and active listings: brand, model, variant, model numbers kept. */
  query: string;
  /** True if this part carries resale value on its own (not a manual, cable or box). */
  valued: boolean;
}

export interface Identity {
  /** What it is, exactly, as far as the listing says or shows. */
  product: string;
  /** Category group for learning, such as "headphones", "phone accessories", "lighting". */
  group: string;
  /** "unknown" when the listing doesn't say; never guessed. */
  condition: "new" | "used" | "parts" | "unknown";
  /**
   * For parts (spares or repair) only: "minor" when the sources name one fault with a simple, inexpensive fix
   * and say the rest works; "major" for a serious or several faults; "unknown" when they don't say. Null otherwise.
   */
  fault?: "minor" | "major" | "unknown" | null;
  /** Set when Claude couldn't be asked (or failed) and word rules stood in: shown on the label, confidence lowered. */
  fallback?: string;
  /** Facts that change the price, as found (model number, size, capacity, what's included, flaws). */
  keyFacts: string[];
  /** One for a single item; several for a bundle. */
  components: Component[];
  /** False when even the photos and description don't say what it is. */
  priceable: boolean;
  /** What to ask K when it isn't priceable (brand, model, size...). */
  question: string | null;
  /** "claude" or "rules" (no API key, or Claude declined). */
  by: "claude" | "rules";
}

export interface ListingFacts {
  title: string;
  condition?: string | null;
  specifics?: Record<string, string>;
  description?: string | null;
  /** Listing photo URLs; the first few are shown to Claude. */
  photos?: string[];
  /** What K has told the app about this item (Inbox answers, facts on the Listings screen): true, and a source. */
  factsFromK?: string | null;
}

/** Bump when identification changes, so cached identities are redone. */
export const IDENTITY_VERSION = 4;

const IDENTIFY_SYSTEM = `You identify an item for sale on eBay UK, so its market price can be found from real sold listings. Use every source: the title, the item specifics, the description, the photos (labels, model numbers on the item or box, what's included, visible wear or damage) and any facts from the seller, which are true and count as a source ("(from K)").

Return:
- product: exactly what it is. Never guess a model, size, capacity or variant that no source shows.
- group: a short category group, e.g. "headphones", "phone accessories", "lighting", "kitchen appliances", "toys".
- condition: new, used, or parts (not working), only if a source says or the photos clearly show it (e.g. sealed box = new). Otherwise unknown.
- fault: only for parts. "minor" when a source names exactly one fault with a simple, inexpensive fix (a split hose, a missing charger, a broken clip) AND says the rest works; "major" for a serious fault (motor, board, screen) or several; "unknown" when no source says what's wrong or whether the rest works. "none" when condition isn't parts.
- keyFacts: up to 8 short facts that change the price, each with its source, e.g. "model SSG-4100GB (title)", "45 litres (specifics)", "remote is BN59-01199F (photo)", "box missing (description)".
- components: one entry for a single item. For a bundle of different things (e.g. "keyboard + remote"), one entry per part a buyer would value, each identified as precisely as the sources allow, plus valued=false for throwaway extras (manuals, cables, boxes). Several of the same item ("Lot of 2 pairs") is ONE component whose name says the quantity. Accessories that come with the product as standard (in its own box, e.g. a blaster's clip and bipod, a phone's charger) are part of that product, not separate components: use several components only for separately sold products the seller has put together.
- query for each: 2 to 6 search words: brand, model, variant and model numbers exactly as written, single digits kept ("Galaxy Buds 2 Pro" keeps "2"). Use a model number from the description or photos when the title lacks it. No condition words; no colours unless they change the price.
- priceable: false only if no source says what the product is precisely enough to find the same thing. Then question is one short question for the seller naming what's missing.`;

const IDENTIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["product", "group", "condition", "fault", "keyFacts", "components", "priceable", "question"],
  properties: {
    product: { type: "string" },
    group: { type: "string" },
    condition: { type: "string", enum: ["new", "used", "parts", "unknown"] },
    fault: { type: "string", enum: ["minor", "major", "unknown", "none"] },
    keyFacts: { type: "array", items: { type: "string" } },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "query", "valued"],
        properties: { name: { type: "string" }, query: { type: "string" }, valued: { type: "boolean" } },
      },
    },
    priceable: { type: "boolean" },
    question: { type: ["string", "null"] },
  },
} as const;

export function identifyByRules(title: string): Identity {
  const query = wordsFromTitle(title);
  const enough = query.split(" ").length >= 2;
  return {
    product: title,
    group: "general",
    condition: /\b(spares|repair|faulty|for parts|not working)\b/i.test(title)
      ? "parts"
      : /\b(new|sealed|bnib)\b/i.test(title) && !/like new/i.test(title)
        ? "new"
        : /\bused|pre-?owned\b/i.test(title)
          ? "used"
          : "unknown",
    keyFacts: [],
    fault: null,
    components: [{ name: title, query, valued: true }],
    priceable: enough,
    question: enough ? null : "Which brand and model is it?",
    by: "rules",
  };
}

const plain = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export async function identify(env: Env, listing: ListingFacts, api?: MessagesApi): Promise<Identity> {
  if (!env.ANTHROPIC_API_KEY && !api) return identifyByRules(listing.title);
  const photos = (listing.photos ?? []).slice(0, 3);
  const prompt = [
    `Title: ${listing.title}`,
    listing.condition ? `Condition (seller's setting): ${listing.condition}` : "",
    listing.specifics && Object.keys(listing.specifics).length
      ? `Item specifics:\n${Object.entries(listing.specifics).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
      : "",
    listing.description ? `Description:\n${plain(listing.description).slice(0, 4000)}` : "No description available.",
    photos.length ? `The ${photos.length} photos above are the seller's listing photos.` : "No photos available.",
    listing.factsFromK ? `Facts from the seller (K), true:\n${listing.factsFromK.slice(0, 2000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  // A failure is never silent (2026-11-05: a schema Claude rejected sent every item to word rules unnoticed):
  // it's logged, and the rules identity carries why, which the engine shows on the label.
  let failure = "";
  const out = await completeOnce<Omit<Identity, "by" | "fault"> & { fault?: string }>(
    env,
    { job: "pricing:identify", model: MODELS.triage, system: IDENTIFY_SYSTEM, prompt, schema: IDENTIFY_SCHEMA, images: photos },
    api,
  ).catch((e) => {
    failure = e instanceof Error ? e.message : String(e);
    console.error(`pricing:identify failed for "${listing.title.slice(0, 80)}": ${failure.slice(0, 500)}`);
    return null;
  });
  if (!out || !out.components?.length)
    return { ...identifyByRules(listing.title), fallback: failure ? `Claude couldn't identify it (${failure.slice(0, 160)})` : "Claude gave no usable identification" };
  return {
    ...out,
    keyFacts: (out.keyFacts ?? []).slice(0, 8),
    fault: out.condition === "parts" && (out.fault === "minor" || out.fault === "major") ? out.fault : out.condition === "parts" ? "unknown" : null,
    components: out.components.slice(0, 6).map((c) => ({ ...c, query: c.query.slice(0, 100) })),
    by: "claude",
  };
}

export interface Grade {
  /** Index into the titles given. */
  i: number;
  grade: "exact" | "close";
  /** For close matches: what the comparable is worth relative to K's item (0.8 = K's is worth 80% of it). */
  factor: number;
}

const MATCH_SYSTEM = `You grade eBay UK listings as comparables for an item being priced, like a valuer choosing comparable sales.

- exact: the same product, model and variant, the same quantity, the same main contents, the same condition group. factor 1.
- close: the same product line with a difference you can value, e.g. a different capacity or size, a missing or extra accessory, a different colour that affects price, a lot of 2 vs 1, new vs used. Give factor = the price of the seller's item divided by the price of this comparable (e.g. comparable is a pair, seller's is one item: about 0.5; comparable is new, seller's is used: about 0.7). Only between 0.3 and 2.
- anything else (accessories for it, cases, parts, replacements, other products, other models of very different value): leave it out.

When the seller's item is only roughly known, grade generously as close rather than exact. Return the numbers of exact matches in "exact", and close ones with their factor in "close"; leave everything else out.`;

const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["exact", "close"],
  properties: {
    exact: { type: "array", items: { type: "integer" } },
    close: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "factor"],
        properties: { n: { type: "integer" }, factor: { type: "number" } },
      },
    },
  },
} as const;

/** Titles per Claude call: small enough that the graded reply always fits. */
const MATCH_BATCH = 60;

/**
 * Grades `titles` as comparables for `component`, by index. Claude sees titles in batches of 60; a batch
 * that fails is retried in halves, then left out (never replaced by looser word rules). Without Claude,
 * junk-word and required-word rules decide (all "exact").
 */
export async function matchTitles(
  env: Env,
  identity: Identity,
  component: Component,
  titles: string[],
  ownTitle: string,
  api?: MessagesApi,
): Promise<{ matches: Grade[]; by: "claude" | "rules" }> {
  const rules = (): Grade[] => {
    const words = component.query.toLowerCase().split(/\s+/).filter((w) => w.length > 1 || /\d/.test(w));
    return titles
      .map((t, i) => ({ t: t.toLowerCase(), i }))
      .filter(({ t }) => !isJunk(t, ownTitle) && words.filter((w) => t.includes(w)).length >= Math.ceil(words.length * 0.75))
      .map(({ i }) => ({ i, grade: "exact" as const, factor: 1 }));
  };
  if (!titles.length) return { matches: [], by: identity.by };
  if (identity.by === "rules" || (!env.ANTHROPIC_API_KEY && !api)) return { matches: rules(), by: "rules" };

  const out: Grade[] = [];
  let answered = 0;
  const grade = async (start: number, batch: string[]): Promise<boolean> => {
    const prompt = [
      `Item being priced: ${component.name}${identity.components.length > 1 ? ` (part of: ${identity.product})` : ""}`,
      `Condition: ${identity.condition}`,
      identity.keyFacts?.length ? `Known facts: ${identity.keyFacts.join("; ")}` : "",
      `Seller's title: ${ownTitle}`,
      "",
      "Listings:",
      ...batch.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, " ").slice(0, 160)}`),
    ]
      .join("\n");
    const res = await completeOnce<{ exact: number[]; close: { n: number; factor: number }[] }>(
      env,
      { job: "pricing:match", model: MODELS.triage, system: MATCH_SYSTEM, prompt, schema: MATCH_SCHEMA, maxTokens: 8000 },
      api,
    ).catch((e) => (console.error(`pricing:match failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`), null));
    if (!res) return false;
    const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= batch.length;
    for (const n of res.exact ?? []) if (ok(n)) out.push({ i: start + n - 1, grade: "exact", factor: 1 });
    for (const c of res.close ?? []) if (ok(c.n)) out.push({ i: start + c.n - 1, grade: "close", factor: Math.min(2, Math.max(0.3, Number(c.factor) || 1)) });
    return true;
  };
  for (let start = 0; start < titles.length; start += MATCH_BATCH) {
    const batch = titles.slice(start, start + MATCH_BATCH);
    if (await grade(start, batch)) answered++;
    else {
      const half = Math.ceil(batch.length / 2);
      if (await grade(start, batch.slice(0, half))) answered++;
      if (await grade(start + half, batch.slice(half))) answered++;
    }
  }
  // Only if Claude answered nothing at all (outage, budget used up) do the word rules stand in.
  if (!answered) return { matches: rules(), by: "rules" };
  const seen = new Set<number>();
  return { matches: out.filter((g) => !seen.has(g.i) && seen.add(g.i)).sort((a, b) => a.i - b.i), by: "claude" };
}
