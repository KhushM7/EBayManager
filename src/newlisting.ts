import type { Env } from "./env";
import type { DraftFacts, DraftReview, DraftRow, DraftSpecific } from "./store";
import { completeOnce, MODELS, type MessagesApi } from "./claude";
import { categoryAspectDetails, categorySuggestions } from "./ebay/browse";
import { verifyNewListing } from "./ebay/write";
import { lookupSpecs } from "./specs";
import { priceItem } from "./pricing/engine";
import { proposeAndNotify } from "./proposals";
import { getStyle } from "./style";
import { parcelQuotes } from "./postage";

// Add Listing, steps L2 to L5 (docs/add-listing.md). From a draft's photos to a `create_listing` label:
// - review: Claude (Sonnet) looks at the photos (sent as image data; they never get a public address), says
//   what the item is, which shots are missing, what the photos show, and asks only what K alone knows;
//   eBay suggests categories; published specs are looked up only for an exactly identified product.
// - facts: K's own answers, condition always K's.
// - compose: the title, description and item specifics, written only from facts with a source. The code drops
//   any specific whose value isn't found in its stated source (a photo, K's facts, or a published-spec page).
// - price: the pricing engine on the draft; K picks one of its prices, or sets an own price when nothing
//   comparable has sold (the same rule as for live listings).
// - postage: Parcel2Go quotes for eBay's Simple Delivery carriers, or K's own figure; collection options.
// - submit: eBay's check (VerifyAddFixedPriceItem), then a create_listing proposal. Publishing happens only
//   when one of the three approves it, through the write gate, which uploads the photos and lists the item.

export const CONDITION_IDS = { new: 1000, used: 3000, parts: 7000 } as const;
const CONDITION_WORDS = { new: "New", used: "Used", parts: "For parts or not working" } as const;

const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

/** The photos as Claude sees them: the chosen version of each (tidied or original), in order, up to 12. */
async function photoData(env: Env, d: DraftRow): Promise<{ base64: string }[]> {
  if (!env.photos) throw new Error("Photo storage isn't set up here.");
  const out: { base64: string }[] = [];
  for (const p of d.photos.slice(0, 12)) {
    const bytes = await env.photos.get(p.use_edited && p.edited ? p.edited.key : p.key);
    if (bytes) out.push({ base64: Buffer.from(bytes).toString("base64") });
  }
  if (!out.length) throw new Error("Add some photos first.");
  return out;
}

// ---------------------------------------------------------------- L2: photo review

export const REVIEW_SYSTEM = `You help a UK eBay seller (K) list an item from photos. Look at every photo (numbered from 1 in the order given) and report, as JSON:

- product: exactly what it is, as precisely as the photos and K's words show. Never guess a model, size, capacity or variant that nothing shows.
- exact: true only if a brand AND a model (or a model number, or a barcode) are visible or stated, so the exact product is certain.
- brand, model: as seen ("" if not shown). group: a short category group, e.g. "vacuum cleaners".
- condition: new (sealed or tagged), used, parts (visibly broken or not working), or unknown. Only what the photos clearly show; K confirms it.
- visibleFacts: facts read from the photos, each with the photo number: text on labels and rating plates, model and serial numbers, colours, what's in shot (accessories, cables, box, manuals).
- flaws: every visible mark, scratch, dent, stain, crack or missing part, with the photo number. Don't soften them.
- missingShots: the shots a buyer of this kind of item expects that aren't here, each with why: e.g. the label or model plate, the back, the underside, each accessory, close-ups of the flaws, the box on all sides, the size tag for clothes. Skip ones already covered.
- photoNotes: problems with specific photos (cluttered background, too dark, cropped, glare), with the photo number.
- questions: only what K alone can know and the photos can't show. Always ask, if not already answered by K: does it fully work (and what was tested), anything missing, and anything not visible such as smells, smoke, pets, or faults that don't show. Ask which variant it is only when that changes the price and nothing shows it (say where the label usually is). Never ask what the photos show, what a published spec sheet would say (dimensions, weight), or about price. Each question has a short id like "works" or "variant".

Never invent facts. If unsure, put it in a question.`;

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["product", "exact", "brand", "model", "group", "condition", "visibleFacts", "flaws", "missingShots", "photoNotes", "questions"],
  properties: {
    product: { type: "string" },
    exact: { type: "boolean" },
    brand: { type: "string" },
    model: { type: "string" },
    group: { type: "string" },
    condition: { type: "string", enum: ["new", "used", "parts", "unknown"] },
    visibleFacts: { type: "array", items: { type: "object", additionalProperties: false, required: ["fact", "photo"], properties: { fact: { type: "string" }, photo: { type: "integer" } } } },
    flaws: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "photo"], properties: { text: { type: "string" }, photo: { type: "integer" } } } },
    missingShots: { type: "array", items: { type: "object", additionalProperties: false, required: ["shot", "why"], properties: { shot: { type: "string" }, why: { type: "string" } } } },
    photoNotes: { type: "array", items: { type: "object", additionalProperties: false, required: ["photo", "note"], properties: { photo: { type: "integer" }, note: { type: "string" } } } },
    questions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "question", "why"], properties: { id: { type: "string" }, question: { type: "string" }, why: { type: "string" } } } },
  },
} as const;

/** Keeps a review within bounds: photo numbers that exist, short texts, safe question ids. */
export function cleanReview(out: any, photos: number, at: number): DraftReview {
  const photo = (n: unknown) => Math.min(photos, Math.max(1, Math.round(Number(n) || 1)));
  const seen = new Set<string>();
  return {
    at,
    product: clip(out.product, 160) || "Unidentified item",
    exact: out.exact === true && Boolean(clip(out.brand, 60)) && Boolean(clip(out.model, 80)),
    brand: clip(out.brand, 60),
    model: clip(out.model, 80),
    group: clip(out.group, 60) || "general",
    condition: ["new", "used", "parts"].includes(out.condition) ? out.condition : "unknown",
    visibleFacts: (out.visibleFacts ?? []).slice(0, 30).map((f: any) => ({ fact: clip(f.fact, 200), photo: photo(f.photo) })).filter((f: any) => f.fact),
    flaws: (out.flaws ?? []).slice(0, 20).map((f: any) => ({ text: clip(f.text, 200), photo: photo(f.photo) })).filter((f: any) => f.text),
    missingShots: (out.missingShots ?? []).slice(0, 12).map((s: any) => ({ shot: clip(s.shot, 120), why: clip(s.why, 200) })).filter((s: any) => s.shot),
    photoNotes: (out.photoNotes ?? []).slice(0, 24).map((n: any) => ({ photo: photo(n.photo), note: clip(n.note, 200) })).filter((n: any) => n.note),
    questions: (out.questions ?? [])
      .slice(0, 10)
      .map((q: any) => ({ id: clip(q.id, 30).toLowerCase().replace(/[^a-z0-9_]/g, "_") || "q", question: clip(q.question, 240), why: clip(q.why, 200) }))
      .filter((q: any) => q.question && !seen.has(q.id) && seen.add(q.id)),
  };
}

/** Step L2: what the photos show, the questions for K, eBay's categories, and published specs if exact. */
export async function reviewDraft(env: Env, id: string, api?: MessagesApi): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  if (!d || d.status !== "open") throw new Error("Draft not found, or already submitted.");
  const images = await photoData(env, d);
  const out = await completeOnce<any>(
    env,
    {
      job: `listing:review:${id}`,
      model: MODELS.audit,
      system: REVIEW_SYSTEM,
      prompt: `K's words for it: ${d.title ? `"${d.title}"` : "none yet"}.\nThere are ${images.length} photos above, numbered 1 to ${images.length} in order.`,
      schema: REVIEW_SCHEMA,
      images,
      effort: "medium",
      maxTokens: 8000,
    },
    api,
  );
  if (!out) throw new Error("Claude couldn't review the photos this time. Try again.");
  const review = cleanReview(out, images.length, Date.now());

  const q = [review.brand, review.model, review.product].filter(Boolean).join(" ").slice(0, 300) || d.title || "";
  const categories = q ? await categorySuggestions(env, q).catch(() => []) : [];
  const category = categories[0] ?? null;
  const aspects = category ? await categoryAspectDetails(env, category.id).catch(() => []) : [];
  // Published specs only for an exactly identified product, each kept only with a page search returned.
  let specs: DraftRow["specs"] = null;
  if (review.exact) {
    const found = await lookupSpecs(env, { ItemID: id, Title: review.product, Description: review.visibleFacts.map((f) => f.fact).join(". ") }, aspects.map((a) => a.name), api).catch(() => null);
    if (found) specs = { product: found.product, exact: found.exact, note: found.note, specs: found.specs };
  }
  return (await env.store.drafts.patch(id, { review, categories, category, aspects, specs }, Date.now()))!;
}

// ---------------------------------------------------------------- L2: K's facts

export function cleanFacts(b: any, review: DraftReview | null | undefined): DraftFacts {
  const t = (v: unknown) => clip(v, 600) || null;
  const answers: Record<string, string> = {};
  for (const q of review?.questions ?? []) {
    const a = clip(b?.answers?.[q.id], 600);
    if (a) answers[q.id] = a;
  }
  return {
    condition: ["new", "used", "parts"].includes(b?.condition) ? b.condition : null,
    works: t(b?.works),
    marks: t(b?.marks),
    included: t(b?.included),
    missing: t(b?.missing),
    other: t(b?.other),
    answers,
  };
}

/** K's facts as text, every line "from you". */
export function factsText(f: DraftFacts | null | undefined, review: DraftReview | null | undefined): string {
  if (!f) return "";
  const lines = [
    f.condition && `Condition: ${CONDITION_WORDS[f.condition]}`,
    f.works && `Working: ${f.works}`,
    f.marks && `Marks and wear: ${f.marks}`,
    f.included && `Included: ${f.included}`,
    f.missing && `Missing: ${f.missing}`,
    f.other && `Other: ${f.other}`,
    ...(review?.questions ?? []).filter((q) => f.answers[q.id]).map((q) => `${q.question} ${f.answers[q.id]}`),
  ];
  return lines.filter(Boolean).join("\n");
}

export async function saveFacts(env: Env, id: string, b: any): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  if (!d) throw new Error("Draft not found");
  return (await env.store.drafts.patch(id, { facts: cleanFacts(b, d.review) }, Date.now()))!;
}

/** K picks one of eBay's suggested categories; its item specifics are read for it. */
export async function chooseCategory(env: Env, id: string, categoryId: string): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  const category = d?.categories?.find((c) => c.id === categoryId);
  if (!d || !category) throw new Error("Pick one of the suggested categories.");
  const aspects = await categoryAspectDetails(env, category.id).catch(() => []);
  return (await env.store.drafts.patch(id, { category, aspects, listing: d.listing ? { ...d.listing, specifics: [] } : null }, Date.now()))!;
}

// ---------------------------------------------------------------- L3: the listing text

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
/** Whether a value appears in a source text, ignoring case, punctuation and spacing ("44.1 cm" in "Height: 44.1cm"). */
const squash = (s: string) => norm(s).replace(/ /g, "");
const contains = (hay: string, needle: string) => squash(needle).length > 0 && squash(hay).includes(squash(needle));

/**
 * Keeps only item specifics whose every value is found in the source they name (docs/add-listing.md,
 * "never assume"): a photo's facts, K's facts, or the published-spec page given. Names must be the category's
 * specifics; selection-only ones must use eBay's values. Returns what was kept, and why the rest was dropped.
 */
export function sourcedSpecifics(
  proposed: { name: string; values: string[]; source: string; ref: string }[],
  ctx: {
    aspects: NonNullable<DraftRow["aspects"]>;
    visibleFacts: DraftReview["visibleFacts"];
    flaws: DraftReview["flaws"];
    fromK: string;
    specs: { name: string; value: string; source: string }[];
  },
): { kept: DraftSpecific[]; dropped: string[] } {
  const kept: DraftSpecific[] = [];
  const dropped: string[] = [];
  const byName = new Map(ctx.aspects.map((a) => [a.name.toLowerCase(), a]));
  for (const s of proposed) {
    const aspect = byName.get(String(s.name).toLowerCase());
    const values = (s.values ?? []).map((v) => clip(v, 65)).filter(Boolean).slice(0, aspect?.multiple ? 10 : 1);
    const why = (reason: string) => dropped.push(`${s.name}: ${reason}`);
    if (!aspect) {
      why("not an item specific for this category");
      continue;
    }
    if (!values.length) continue;
    let finalValues = values;
    if (aspect.selectionOnly) {
      const allowed = new Map(aspect.values.map((v) => [v.toLowerCase(), v]));
      if (!values.every((v) => allowed.has(v.toLowerCase()))) {
        why("not one of eBay's values for it");
        continue;
      }
      finalValues = values.map((v) => allowed.get(v.toLowerCase())!);
    }
    let ok = false;
    let ref = clip(s.ref, 300);
    if (s.source === "spec") {
      const spec = ctx.specs.filter((p) => p.source === ref);
      ok = spec.length > 0 && values.every((v) => spec.some((p) => contains(p.value, v) || contains(`${p.name} ${p.value}`, v)));
    } else if (s.source === "photo") {
      const n = Number(ref);
      const facts = [...ctx.visibleFacts.filter((f) => f.photo === n).map((f) => f.fact), ...ctx.flaws.filter((f) => f.photo === n).map((f) => f.text)];
      ok = facts.length > 0 && values.every((v) => facts.some((f) => contains(f, v)));
      ref = String(n);
    } else if (s.source === "you") {
      ok = values.every((v) => contains(ctx.fromK, v));
      ref = "you";
    }
    if (!ok) {
      why(`the value isn't in its source (${s.source}${s.source === "you" ? "" : ` ${ref}`})`);
      continue;
    }
    kept.push({ name: aspect.name, values: finalValues, source: s.source as DraftSpecific["source"], ref });
  }
  return { kept, dropped };
}

export const COMPOSE_SYSTEM = `You write an eBay UK listing for K from facts only. You're given what the photos show (each fact with its photo number), K's own facts, published specifications (each with its source page), the item specifics eBay wants for the category (with eBay's values), and K's tone.

- title: at most 80 characters. Brand, model, the key spec buyers search (size, capacity, colour where it matters), and the condition words that matter (e.g. "Spares or Repair", "Boxed"). No capitals for shouting, no "L@@K", no punctuation clutter.
- description: plain text, short paragraphs separated by a blank line. Start with the condition in K's words, then what it is, what's included, measurements or specs (from the published specs only), and every flaw plainly. If collection is offered, say collection is welcome. No greeting, no sign-off, no price talk, no promises not in the facts (no "fully tested" unless K said so).
- specifics: only names from the list given. Each value must come from one source, named: "photo" with the photo number as ref, "you" (K's facts) with ref "you", or "spec" with the source page URL as ref. Use eBay's values where given. Leave out anything without a source: the code removes unsourced values anyway.

Never add a fact that isn't in the inputs.`;

const COMPOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "specifics"],
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    specifics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "values", "source", "ref"],
        properties: { name: { type: "string" }, values: { type: "array", items: { type: "string" } }, source: { type: "string", enum: ["photo", "you", "spec"] }, ref: { type: "string" } },
      },
    },
  },
} as const;

/** Step L3: the title, description and sourced item specifics, from the review, K's facts and the specs. */
export async function composeDraft(env: Env, id: string, api?: MessagesApi): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  if (!d || d.status !== "open") throw new Error("Draft not found, or already submitted.");
  if (!d.review) throw new Error("Check the photos first.");
  if (!d.facts?.condition) throw new Error("Say what condition it's in first.");
  if (!d.category) throw new Error("Pick a category first.");
  const fromK = factsText(d.facts, d.review);
  const specs = d.specs?.specs ?? [];
  const style = await getStyle(env).catch(() => null);
  const prompt = [
    `Category: ${d.category.path ? `${d.category.path} > ` : ""}${d.category.name}`,
    `What the photos show:\n${d.review.visibleFacts.map((f) => `- ${f.fact} (photo ${f.photo})`).join("\n") || "- nothing readable"}`,
    `Flaws seen:\n${d.review.flaws.map((f) => `- ${f.text} (photo ${f.photo})`).join("\n") || "- none seen"}`,
    `K's facts (source "you"):\n${fromK}`,
    `Published specifications${d.specs?.product ? ` for the ${d.specs.product}` : ""}:\n${specs.map((s) => `- ${s.name}: ${s.value} (${s.source})`).join("\n") || "- none"}`,
    `Item specifics eBay wants:\n${(d.aspects ?? []).map((a) => `- ${a.name}${a.required ? " (required)" : ""}${a.values.length ? `: ${a.selectionOnly ? "only" : "e.g."} ${a.values.slice(0, 15).join(", ")}` : ""}`).join("\n") || "- none listed"}`,
    d.postage?.collectionOffered || d.postage?.collectionOnly ? `Collection: ${d.postage.collectionOnly ? "collection only" : "collection offered as well as postage"}.` : "",
    style ? `K's tone: ${style.tone}. Habits: ${style.habits.join("; ")}. Avoid: ${style.avoid.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await completeOnce<{ title: string; description: string; specifics: any[] }>(
    env,
    { job: `listing:compose:${id}`, model: MODELS.audit, system: COMPOSE_SYSTEM, prompt, schema: COMPOSE_SCHEMA, effort: "medium", maxTokens: 8000 },
    api,
  );
  if (!out) throw new Error("Claude couldn't write the listing this time. Try again.");
  const { kept, dropped } = sourcedSpecifics(out.specifics ?? [], { aspects: d.aspects ?? [], visibleFacts: d.review.visibleFacts, flaws: d.review.flaws, fromK, specs });
  const listing = { title: clip(out.title, 80), description: clip(out.description, 6000), specifics: kept, dropped, at: Date.now(), editedByK: false };
  return (await env.store.drafts.patch(id, { listing }, Date.now()))!;
}

/** K's edits to the listing text: title, description, removing a specific, or adding one (from K). */
export async function editListing(env: Env, id: string, b: any): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  if (!d?.listing) throw new Error("Write the listing first.");
  const l = { ...d.listing, editedByK: true };
  if (typeof b.title === "string") l.title = clip(b.title, 80);
  if (typeof b.description === "string") l.description = clip(b.description, 6000);
  if (typeof b.removeSpecific === "string") l.specifics = l.specifics.filter((s) => s.name !== b.removeSpecific);
  if (b.addSpecific && typeof b.addSpecific.name === "string") {
    const aspect = (d.aspects ?? []).find((a) => a.name.toLowerCase() === String(b.addSpecific.name).toLowerCase());
    const value = clip(b.addSpecific.value, 65);
    if (!aspect || !value) throw new Error("Pick one of the category's item specifics and give a value.");
    if (aspect.selectionOnly && !aspect.values.some((v) => v.toLowerCase() === value.toLowerCase())) throw new Error(`${aspect.name} must be one of eBay's values.`);
    l.specifics = [...l.specifics.filter((s) => s.name !== aspect.name), { name: aspect.name, values: [value], source: "you", ref: "you" }];
  }
  if (!l.title) throw new Error("The title can't be empty.");
  return (await env.store.drafts.patch(id, { listing: l }, Date.now()))!;
}

/** The description as eBay HTML: escaped, paragraphs and line breaks kept. */
export function descriptionHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

// ---------------------------------------------------------------- L4: price

/** Step L4: the pricing engine on the draft. Nothing is chosen until K picks one of its prices. */
export async function priceDraft(env: Env, id: string, api?: MessagesApi): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  if (!d || d.status !== "open") throw new Error("Draft not found, or already submitted.");
  if (!d.review || !d.facts?.condition) throw new Error("Check the photos and give the condition first.");
  const specifics = Object.fromEntries((d.listing?.specifics ?? []).map((s) => [s.name, s.values.join(", ")]));
  const r = await priceItem(
    env,
    {
      title: d.listing?.title || d.review.product,
      condition: CONDITION_WORDS[d.facts.condition],
      specifics,
      description: d.listing?.description ?? null,
      postage: d.postage?.collectionOnly ? null : (d.postage?.cost ?? null),
      floor: d.price?.floor ?? null,
      factsFromK: factsText(d.facts, d.review),
      excludeItemIds: [],
    },
    api,
  );
  const x = r.decision;
  const pricing = {
    at: r.at,
    strategy: x.strategy,
    price: x.price,
    total: x.total,
    why: x.why,
    confidence: x.confidence,
    question: x.question,
    reason: x.reason,
    options: x.options.map((o) => ({ price: o.price, daysToSell: o.daysToSell })),
  };
  return (await env.store.drafts.patch(id, { pricing }, Date.now()))!;
}

/**
 * K's choice of price: one of the engine's (within 1%), or K's own price only when nothing comparable has
 * sold, as for live listings. Never below K's floor.
 */
export async function choosePrice(env: Env, id: string, b: any): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  const p = d?.pricing;
  if (!d || !p) throw new Error("Price it first.");
  const value = Math.round(Number(b.value) * 100) / 100;
  const floor = b.floor == null || b.floor === "" ? null : Math.round(Number(b.floor) * 100) / 100;
  if (!(value > 0 && value < 100_000)) throw new Error("Give a price in pounds.");
  if (floor != null && !(floor > 0 && floor <= value)) throw new Error("The floor must be a price at or below the listing price.");
  const enginePrices = [p.price, ...p.options.map((o) => o.price)].filter((x): x is number => x != null);
  const ownAllowed = p.strategy === "ask" && p.reason === "no_sales";
  let kind: "engine" | "own";
  if (enginePrices.some((e) => Math.abs(value - e) <= e * 0.01)) kind = "engine";
  else if (ownAllowed) kind = "own";
  else throw new Error(`Prices come from the engine: pick £${enginePrices.map((e) => e.toFixed(2)).join(", £")}${p.strategy === "ask" ? " or answer its question" : ""}.`);
  return (await env.store.drafts.patch(id, { price: { value, kind, floor, bestOffer: b.bestOffer !== false } }, Date.now()))!;
}

// ---------------------------------------------------------------- L4: postage

const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i;

/** K's postage choice: a quote, or K's own figure; collection offered or collection only; the item's postcode. */
export async function savePostage(env: Env, id: string, b: any): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  if (!d) throw new Error("Draft not found");
  const postcode = clip(b.postcode, 10).toUpperCase();
  if (!POSTCODE.test(postcode)) throw new Error("Give the UK postcode the item is sent from (it shows buyers the area, not the address).");
  const collectionOnly = b.collectionOnly === true;
  const cost = collectionOnly ? 0 : Math.round(Number(b.cost) * 100) / 100;
  if (!collectionOnly && !(cost >= 0 && cost < 1000)) throw new Error("Give the postage in pounds.");
  const parcel =
    b.parcel && [b.parcel.lengthCm, b.parcel.widthCm, b.parcel.heightCm, b.parcel.weightKg].every((v: unknown) => Number(v) > 0)
      ? { lengthCm: Number(b.parcel.lengthCm), widthCm: Number(b.parcel.widthCm), heightCm: Number(b.parcel.heightCm), weightKg: Number(b.parcel.weightKg) }
      : (d.parcel ?? null);
  await env.store.kv.set("seller_postcode", postcode);
  const postage = {
    cost,
    carrier: clip(b.carrier, 40) || null,
    service: clip(b.service, 80) || null,
    source: b.source === "parcel2go" ? ("parcel2go" as const) : ("you" as const),
    collectionOffered: collectionOnly || b.collectionOffered === true,
    collectionOnly,
    postcode,
  };
  return (await env.store.drafts.patch(id, { postage, parcel }, Date.now()))!;
}

/** Live quotes for the parcel from Parcel2Go, eBay's Simple Delivery carriers only, cheapest first. */
export async function quotePostage(env: Env, id: string, b: any): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  if (!d) throw new Error("Draft not found");
  const parcel = { lengthCm: Number(b.lengthCm), widthCm: Number(b.widthCm), heightCm: Number(b.heightCm), weightKg: Number(b.weightKg) };
  if (!Object.values(parcel).every((v) => v > 0 && v < 1000)) throw new Error("Give the parcel's length, width and height in cm and its weight in kg.");
  let quotes: NonNullable<DraftRow["quotes"]>;
  try {
    quotes = { at: Date.now(), quotes: await parcelQuotes(env, parcel, d.price?.value ?? d.pricing?.price ?? 20) };
  } catch (e) {
    quotes = { at: Date.now(), quotes: [], error: e instanceof Error ? e.message : String(e) };
  }
  return (await env.store.drafts.patch(id, { parcel, quotes }, Date.now()))!;
}

// ---------------------------------------------------------------- L5: submit

/** What's still needed before a draft can go to eBay's check, in order. Empty means ready. */
export function missingSteps(d: DraftRow): string[] {
  const m: string[] = [];
  if (!d.photos.length) m.push("Add photos.");
  if (!d.review) m.push("Check the photos.");
  if (!d.facts?.condition) m.push("Give the condition.");
  if (!d.category) m.push("Pick a category.");
  if (!d.listing?.title) m.push("Write the listing.");
  for (const a of d.aspects ?? []) if (a.required && !d.listing?.specifics.some((s) => s.name === a.name)) m.push(`Add the required item specific "${a.name}".`);
  if (!d.price) m.push("Choose a price.");
  if (!d.postage) m.push("Set postage or collection.");
  return m;
}

/** The create_listing payload for the write gate (src/ebay/write.ts builds the eBay listing call from it). */
export function listingPayload(d: DraftRow) {
  return {
    title: d.listing!.title,
    description: descriptionHtml(d.listing!.description),
    categoryId: d.category!.id,
    price: d.price!.value,
    conditionId: String(CONDITION_IDS[d.facts!.condition!]),
    quantity: 1,
    postcode: d.postage!.postcode,
    shippingCost: d.postage!.collectionOnly ? 0 : d.postage!.cost,
    collectionOnly: d.postage!.collectionOnly,
    collectionOffered: d.postage!.collectionOffered,
    pictureUrls: [] as string[],
    itemSpecifics: Object.fromEntries(d.listing!.specifics.map((s) => [s.name, s.values])),
    bestOffer: d.price!.bestOffer,
  };
}

/**
 * Step L5: eBay checks the listing, then it becomes a create_listing label for one of the three to approve.
 * The photos are uploaded to eBay only when it's approved (by the write gate), so eBay's check here sees no
 * photos: a complaint only about photos is noted, not a failure.
 */
export async function submitDraft(env: Env, id: string): Promise<{ draft: DraftRow; note: string }> {
  const d = await env.store.drafts.get(id);
  if (!d || d.status !== "open") throw new Error("Draft not found, or already submitted.");
  const missing = missingSteps(d);
  if (missing.length) throw new Error(`Not ready yet: ${missing.join(" ")}`);
  const payload = listingPayload(d);
  let fees: number | null = null;
  let note = "";
  try {
    fees = (await verifyNewListing(env, payload)).fees;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const errors = msg.replace(/^VerifyAddFixedPriceItem failed: /, "").split("; ");
    if (!errors.every((x) => /\b(picture|photo|image)s?\b/i.test(x))) throw new Error(`eBay's check found a problem: ${errors.join(" ")}`);
    note = "eBay noted the listing has no photos yet: they're uploaded when it's approved. ";
  }
  const photoKeys = d.photos.map((p) => (p.use_edited && p.edited ? p.edited.key : p.key));
  const reason = [
    `New listing from a draft by ${d.created_by}: ${d.category!.name}, ${d.facts!.condition}, ${d.photos.length} photos.`,
    `Price £${payload.price.toFixed(2)} (${d.price!.kind === "own" ? "your own price: nothing comparable has sold" : "the engine's"}). ${d.postage!.collectionOnly ? "Collection only." : `Postage £${payload.shippingCost.toFixed(2)}${d.postage!.collectionOffered ? ", collection offered" : ""}.`}`,
    fees != null ? `eBay's listing fees: £${fees.toFixed(2)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const out = await proposeAndNotify(env, { kind: "create_listing", payload: { ...payload, verifiedFees: fees, draftId: id, photoKeys }, reason }, `New listing: ${payload.title} at £${payload.price.toFixed(2)}`, reason);
  const draft = (await env.store.drafts.setStatus(id, "submitted", Date.now(), { proposal_id: out.proposalId, submitted_at: Date.now() }))!;
  return { draft, note: `${note}Sent for approval: the label is in the Inbox.` };
}

/** A submitted draft whose label was rejected, expired, or only recorded as a dry run goes back to editing. */
export async function reopenDraft(env: Env, id: string): Promise<DraftRow> {
  const d = await env.store.drafts.get(id);
  if (!d || d.status !== "submitted") throw new Error("Only a submitted draft can be reopened.");
  const p = d.proposal_id ? await env.store.proposals.get(d.proposal_id) : null;
  if (p && !["rejected", "expired", "agreed", "failed"].includes(p.status)) throw new Error("Its label is still waiting for a decision: reject it first to edit the draft.");
  return (await env.store.drafts.setStatus(id, "open", Date.now(), { proposal_id: null, submitted_at: null }))!;
}
