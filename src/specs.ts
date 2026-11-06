import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { client, logUsage, MODELS, type MessagesApi } from "./claude";
import { categoryAspects } from "./ebay/browse";

// Published specifications for an exactly identified product (docs/listing-assistant.md, "never assume"):
// dimensions, weight, model number and other manufacturer facts, so K doesn't have to measure or look them
// up. Claude (Sonnet, with Anthropic's web search) identifies the product from the listing, searches, and
// records each spec with the page it came from. The code keeps a spec only if its source is a page that
// search actually returned in this call, and keeps none unless Claude is sure of the exact product. Condition,
// faults and what's included never come from the web: those are K's.

export interface PublishedSpec {
  /** eBay item specific name where one fits (Item Width, Item Weight, MPN), else a plain label. */
  name: string;
  value: string;
  source: string;
  sourceTitle: string;
}

export interface SpecLookup {
  itemId: string;
  title: string;
  at: number;
  /** The exact product, when Claude was sure of it. */
  product: string | null;
  exact: boolean;
  note: string;
  specs: PublishedSpec[];
  /** Specs Claude gave without a source page from its own searches, dropped by the code. */
  dropped: number;
  /** Other names sellers and shops use for this exact product (model codes, the manufacturer's model name), for pricing searches. */
  aliases?: string[];
  costUsd: number;
}

export const SPECS_SYSTEM = `You find the manufacturer's published specifications for one item listed on eBay UK, so the seller doesn't have to measure it.

1. Identify the exact product from the listing: brand and model (or model number). If the listing doesn't pin it down to one exact product (for example "designer ceiling lights", or a model sold in several sizes without saying which), don't search: call record_specs with exact false and say in note what K would need to say.
2. Search for the product's specifications. Prefer the manufacturer's own page or manual, then large retailers. Retailer item numbers (for example Lidl's or Argos's) are often all a box shows: search with them to find the manufacturer's model name or code, then search with that. You may open a page (web_fetch) to read a manual or spec sheet that a search found.
3. Call record_specs once with the specs you found, each with the URL of the page it came from (exactly as the search returned it, or the page you opened) and that page's title, and aliases: the other names this exact product is sold or listed under (model codes such as "SHFD 1400 C1", the manufacturer's model name, a retailer's name for it), so its market price can be searched. Only names your sources show for this exact product.

Rules:
- Only specs stated on a page you found for this exact model. If sources disagree, use the manufacturer's figure or leave it out.
- Measurements in metric with units as published (for example "45 cm", "6.2 kg"). Give width, height, depth/length and weight as separate specs when published.
- Use the eBay item specific name the seller asked for when a spec matches one. Also record the published features a buyer would want in the description (capacity, power, programs, settings, materials, what's in the box as standard), each as its own spec.
- Never record condition, faults, what's included, or anything about this particular item: only facts true of every unit of the product.`;

const RECORD_SPECS: Anthropic.Beta.BetaTool = {
  name: "record_specs",
  description: "Record the exact product and its published specifications, each with its source page from your searches.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["exact", "product", "note", "specs", "aliases"],
    properties: {
      exact: { type: "boolean", description: "True only if the listing identifies one exact product (brand and model)." },
      product: { type: "string", description: "Brand and model, or empty if not exact." },
      note: { type: "string", description: "One line: how the product was identified, or what K must say if it couldn't be." },
      aliases: { type: "array", items: { type: "string" }, description: "Other names this exact product is sold or listed under, from your sources: model codes, the manufacturer's model name." },
      specs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "value", "source", "sourceTitle"],
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            source: { type: "string", description: "URL of the search result or opened page this spec came from." },
            sourceTitle: { type: "string" },
          },
        },
      },
    },
  },
};

// With dynamic filtering (the _20260209 tools), searches made inside the filtering code count towards max_uses as
// well: 4 ran out before anything was read (2026-11-06, an air fryer known only by Lidl's item number).
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 10, user_location: { type: "approximate", country: "GB" } } as const;
// Web fetch only opens URLs already in the conversation, so it can read a manual or spec sheet a search found.
const WEB_FETCH = { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4, max_content_tokens: 20000 } as const;

const list = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const strip = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** A URL as compared: scheme, host and path, without query, fragment or trailing slash. */
export function sameSource(a: string): string | null {
  try {
    const u = new URL(a);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Keeps only specs whose source is a page search returned, cleaned; none at all unless the product is exact. */
export function verifySpecs(
  recorded: { exact: boolean; product: string; note: string; specs: { name: string; value: string; source: string; sourceTitle: string }[]; aliases?: string[] },
  searched: string[],
): { exact: boolean; product: string | null; note: string; specs: PublishedSpec[]; dropped: number; aliases: string[] } {
  const found = new Set(searched.map(sameSource).filter(Boolean));
  if (!recorded.exact || !recorded.product.trim())
    return { exact: false, product: null, note: recorded.note.slice(0, 300), specs: [], dropped: recorded.specs.length, aliases: [] };
  const seen = new Set<string>();
  const specs: PublishedSpec[] = [];
  for (const s of recorded.specs) {
    const key = sameSource(s.source);
    const name = s.name.trim().slice(0, 60);
    const value = s.value.trim().slice(0, 100);
    if (!key || !found.has(key) || !name || !value || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    specs.push({ name, value, source: s.source, sourceTitle: s.sourceTitle.slice(0, 120) });
  }
  // Aliases are only kept when some spec came from a real page, so they rest on the same sources.
  const aliases = specs.length ? [...new Set((recorded.aliases ?? []).map((a) => String(a).trim().slice(0, 60)).filter((a) => a.length >= 3))].slice(0, 4) : [];
  return { exact: true, product: recorded.product.trim().slice(0, 120), note: recorded.note.slice(0, 300), specs, dropped: recorded.specs.length - specs.length, aliases };
}

/** Item specifics worth looking up: the category's required and recommended ones the listing lacks. */
export async function wantedSpecs(env: Env, item: any): Promise<string[]> {
  const have = new Set(list<any>(item?.ItemSpecifics?.NameValueList).map((nv) => String(nv.Name).toLowerCase()));
  const cat = String(item?.PrimaryCategory?.CategoryID ?? "");
  const aspects = cat ? await categoryAspects(env, cat).catch(() => []) : [];
  return aspects.map((a) => a.name).filter((n) => !have.has(n.toLowerCase()));
}

/** Searches the web for one listing's product specs. Read-only on eBay; one Sonnet run with up to 4 searches. */
export async function lookupSpecs(env: Env, item: any, wanted: string[], api?: MessagesApi): Promise<SpecLookup> {
  const messagesApi = await client(env, api);
  const itemId = String(item?.ItemID ?? "");
  const title = String(item?.Title ?? "");
  const specifics = list<any>(item?.ItemSpecifics?.NameValueList)
    .map((nv) => `${nv.Name}: ${list(nv.Value).join(", ")}`)
    .join("; ");
  const prompt = [
    `Title: ${title}`,
    specifics && `Item specifics: ${specifics}`,
    `Description: ${strip(String(item?.Description ?? "")).slice(0, 1500) || "none"}`,
    `Item specifics the seller is missing: ${wanted.length ? wanted.join(", ") : "none listed"}. Also find the product's dimensions and weight.`,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  const searched: string[] = [];
  const errors: string[] = [];
  let cost = 0;
  let recorded: Parameters<typeof verifySpecs>[0] | null = null;
  for (let turn = 0; turn < 6 && !recorded; turn++) {
    const response = await messagesApi.create({
      model: MODELS.audit,
      max_tokens: 16000,
      system: [{ type: "text", text: SPECS_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [WEB_SEARCH, WEB_FETCH, RECORD_SPECS],
      messages,
      output_config: { effort: "low" },
    });
    cost += await logUsage(env, `specs:${itemId}`, MODELS.audit, response);
    const callInput = new Map<string, string>();
    for (const block of response.content) if (block.type === "server_tool_use") callInput.set(block.id, `${block.name} ${JSON.stringify(block.input).slice(0, 120)}`);
    for (const block of response.content) {
      if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === "web_search_result") searched.push(r.url);
        } else errors.push(`${String((block.content as any)?.error_code ?? "error")} [${callInput.get(block.tool_use_id) ?? "?"}]`);
      }
      if (block.type === "web_fetch_tool_result") {
        const c = block.content as any;
        if (c?.type === "web_fetch_result" && typeof c.url === "string") searched.push(c.url);
        else errors.push(`${String(c?.error_code ?? "fetch error")} [${callInput.get(block.tool_use_id) ?? "?"}]`);
      }
      if (block.type === "tool_use" && block.name === "record_specs") recorded = block.input as typeof recorded;
    }
    if (recorded || response.stop_reason === "end_turn" || response.stop_reason === "refusal" || response.stop_reason === "max_tokens") break;
    // A long server-side search turn pauses; sending it back lets the server carry on.
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "tool_use") {
      // Only record_specs is a client tool, and it ends the run above; anything else is answered as unavailable.
      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      messages.push({ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, is_error: true, content: "Not available." })) });
    }
  }
  const v = recorded ? verifySpecs(recorded, searched) : { exact: false, product: null, note: "No specifications were recorded.", specs: [], dropped: 0, aliases: [] };
  // The search's own error codes (they arrive inside the reply, not as exceptions), so a failure says why.
  if (errors.length && !v.specs.length) v.note = `${v.note} (search errors: ${[...new Set(errors)].slice(0, 3).join(", ")})`.slice(0, 700);
  return { itemId, title, at: Date.now(), ...v, costUsd: cost };
}

/** The stored lookup for a listing, if it was made for its current title. */
export async function storedSpecs(env: Env, itemId: string, title: string): Promise<SpecLookup | null> {
  const lookup = await env.store.listings.getSpecs(itemId, title);
  return lookup ? JSON.parse(lookup) : null;
}

/** The stored lookup, or a new one (when a Claude key is set). Never throws: no specs is a valid answer. */
export async function specsFor(env: Env, item: any, api?: MessagesApi): Promise<SpecLookup | null> {
  const itemId = String(item?.ItemID ?? "");
  const title = String(item?.Title ?? "");
  const stored = await storedSpecs(env, itemId, title).catch(() => null);
  if (stored) return stored;
  if (!env.ANTHROPIC_API_KEY && !api) return null;
  try {
    const found = await lookupSpecs(env, item, await wantedSpecs(env, item), api);
    await env.store.listings.putSpecs(itemId, title, found.at, JSON.stringify(found));
    return found;
  } catch {
    return null;
  }
}
