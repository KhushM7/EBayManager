import type { Doc, DocStore } from "./doc";

// New-listing drafts (docs/add-listing.md), in the listings container under their own partition. A draft is
// saved at every step and resumed later; its photos live in the photo store under `drafts/<draft id>/`.
// Every change is a read-modify-write with the etag, so two quick changes (say, two photo uploads) can't lose
// each other. Each step owns its own fields: the photo review, K's facts, the category, the listing text, the
// price, the postage and, once submitted, the label and the published item.

const C = "listings" as const;
const PK = "drafts";

export type DraftStatus = "open" | "submitted" | "published" | "abandoned";

export interface DraftPhoto {
  id: string;
  key: string;
  width: number;
  height: number;
  bytes: number;
  /** What the phone's checks found (too dark, blurry, small, a duplicate), kept by K anyway. */
  issues: string[];
  /** The phone's 64-bit fingerprint of the shot (hex), to spot the same shot twice across sessions. */
  hash: string | null;
  added_at: number;
  /** A tidied copy (ordinary edits only: crop, exposure, white balance, background to white); the original is kept. */
  edited?: { key: string; bytes: number; width: number; height: number; at: number; edits: string[] } | null;
  /** Which version goes on the listing. */
  use_edited?: boolean;
}

/** What Claude saw in the photos (step L2). Facts and flaws name the photo they were read from. */
export interface DraftReview {
  at: number;
  product: string;
  exact: boolean;
  brand: string;
  model: string;
  group: string;
  condition: "new" | "used" | "parts" | "unknown";
  visibleFacts: { fact: string; photo: number }[];
  flaws: { text: string; photo: number }[];
  missingShots: { shot: string; why: string }[];
  photoNotes: { photo: number; note: string }[];
  questions: { id: string; question: string; why: string }[];
}

/** K's own facts (always "from you"). Condition is always K's, never assumed. */
export interface DraftFacts {
  condition: "new" | "opened" | "used" | "parts" | null;
  works: string | null;
  marks: string | null;
  included: string | null;
  missing: string | null;
  other: string | null;
  /** Answers to Claude's questions, by question id. */
  answers: Record<string, string>;
}

export interface DraftSpecific {
  name: string;
  values: string[];
  /** Where the value came from: a photo (number), K, or a published-spec page. */
  source: "photo" | "you" | "spec";
  ref: string;
}

export interface DraftRow {
  id: string;
  status: DraftStatus;
  created_by: string;
  created_at: number;
  updated_at: number;
  /** K's own words for what it is, before anything is identified. */
  title: string | null;
  photos: DraftPhoto[];
  review?: DraftReview | null;
  facts?: DraftFacts | null;
  /** Published specifications for the exact product (src/specs.ts), each with its source page. */
  specs?: { product: string | null; exact: boolean; note: string; specs: { name: string; value: string; source: string; sourceTitle: string }[]; aliases?: string[] } | null;
  categories?: { id: string; name: string; path: string }[];
  category?: { id: string; name: string; path: string } | null;
  aspects?: { name: string; required: boolean; values: string[]; selectionOnly: boolean; multiple: boolean }[];
  /** The listing text: Claude's draft, then K's edits. */
  listing?: { title: string; description: string; specifics: DraftSpecific[]; dropped: string[]; at: number; editedByK: boolean } | null;
  /** The engine's result for the draft, and the price chosen from it (or K's own price when nothing has sold). */
  pricing?: { at: number; strategy: string; price: number | null; total: number | null; why: string; confidence: number; question?: string; reason?: string; options: { price: number; daysToSell: number }[] } | null;
  price?: { value: number; kind: "engine" | "own"; floor: number | null; bestOffer: boolean } | null;
  parcel?: { lengthCm: number; widthCm: number; heightCm: number; weightKg: number } | null;
  quotes?: { at: number; quotes: { carrier: string; service: string; price: number }[]; error?: string } | null;
  postage?: {
    cost: number;
    carrier: string | null;
    service: string | null;
    source: "parcel2go" | "you";
    collectionOffered: boolean;
    collectionOnly: boolean;
    postcode: string;
    /** Simple Delivery (K switches to it in Seller Hub, at size) or a courier at the cost above. */
    mode?: "simple_delivery" | "courier";
    /** The Simple Delivery size code (src/postage.ts, PARCEL_SIZES), and who chose it. */
    size?: string | null;
    sizeBy?: "app" | "you";
  } | null;
  /** How the packed parcel was worked out (src/newlisting.ts, planPostage). */
  parcelPlan?: {
    at: number;
    /** The item itself, where known, and where each figure came from. */
    item: { lengthCm: number | null; widthCm: number | null; heightCm: number | null; weightKg: number | null; source: "spec" | "estimate" | "unknown" };
    packaging: string;
    confidence: "high" | "medium" | "low";
    /** What only K can say, when the size can't be worked out reliably. */
    missing: string[];
    by: "claude" | "you";
  } | null;
  proposal_id?: string | null;
  submitted_at?: number | null;
  item_id?: string | null;
  published_at?: number | null;
  photos_deleted_at?: number | null;
}

const strip = ({ pk, type, _etag, ttl, _rid, _self, _attachments, _ts, ...r }: any) => r as DraftRow;

/** Fields a step may set through patch(); status, photos and identity change only through their own methods. */
export type DraftPatch = Partial<Omit<DraftRow, "id" | "status" | "created_by" | "created_at" | "updated_at" | "photos">>;

export function draftsRepo(docs: DocStore) {
  async function change(id: string, fn: (d: DraftRow) => DraftRow | null): Promise<DraftRow | null> {
    for (let i = 0; i < 6; i++) {
      const cur = await docs.get<Doc>(C, id, PK);
      if (!cur) return null;
      const next = fn(strip(cur));
      if (!next) return strip(cur);
      if (await docs.replace(C, { ...next, id, pk: PK, type: "draft" }, cur._etag)) return next;
    }
    throw new Error("Too many changes to this draft at once. Try again.");
  }
  const open = (d: DraftRow) => {
    if (d.status !== "open") throw new Error("This draft has been submitted and can't be changed.");
  };
  return {
    async create(by: string, now: number): Promise<DraftRow> {
      const d: DraftRow = { id: `draft_${crypto.randomUUID()}`, status: "open", created_by: by, created_at: now, updated_at: now, title: null, photos: [] };
      await docs.create(C, { ...d, pk: PK, type: "draft" });
      return d;
    },
    get: async (id: string): Promise<DraftRow | null> => {
      if (!/^draft_[\w-]{1,64}$/.test(id)) return null;
      const d = await docs.get(C, id, PK);
      return d ? strip(d) : null;
    },
    list: async (status: DraftStatus): Promise<DraftRow[]> =>
      (await docs.query<any>(C, { pk: PK, where: [{ f: "status", op: "=", v: status }] })).map(strip).sort((a, b) => b.updated_at - a.updated_at),
    update: (id: string, fields: { title?: string | null }, now: number) =>
      change(id, (d) => (d.status !== "open" ? null : { ...d, ...fields, updated_at: now })),
    /** A step's results (open drafts only). */
    patch: (id: string, fields: DraftPatch, now: number) => change(id, (d) => (open(d), { ...d, ...fields, updated_at: now })),
    addPhoto: (id: string, photo: DraftPhoto, max: number, now: number) =>
      change(id, (d) => {
        open(d);
        if (d.photos.length >= max) throw new Error(`eBay allows ${max} photos per listing.`);
        return { ...d, photos: [...d.photos, photo], updated_at: now };
      }),
    removePhoto: (id: string, photoId: string, now: number) =>
      change(id, (d) => (d.status !== "open" ? null : { ...d, photos: d.photos.filter((p) => p.id !== photoId), updated_at: now })),
    /** New photo order (the first is the main photo); ids not in the draft are ignored, missing ones kept last. */
    orderPhotos: (id: string, order: string[], now: number) =>
      change(id, (d) => {
        if (d.status !== "open") return null;
        const rank = new Map(order.map((p, i) => [p, i]));
        const photos = [...d.photos].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
        return { ...d, photos, updated_at: now };
      }),
    /** Records a tidied copy of a photo, or which version to use. */
    setEdited: (id: string, photoId: string, edited: DraftPhoto["edited"], useEdited: boolean, now: number) =>
      change(id, (d) => {
        open(d);
        if (!d.photos.some((p) => p.id === photoId)) throw new Error("No such photo");
        return { ...d, photos: d.photos.map((p) => (p.id !== photoId ? p : { ...p, ...(edited !== undefined ? { edited } : {}), use_edited: useEdited && Boolean(edited ?? p.edited) })), updated_at: now };
      }),
    setStatus: (id: string, status: DraftStatus, now: number, fields: DraftPatch = {}) => change(id, (d) => ({ ...d, ...fields, status, updated_at: now })),
    /** Open drafts nobody has touched since `before`: abandoned by the nightly cleanup. */
    stale: async (before: number): Promise<DraftRow[]> =>
      (await docs.query<any>(C, { pk: PK, where: [{ f: "status", op: "=", v: "open" }, { f: "updated_at", op: "<", v: before }] })).map(strip),
    /** Published drafts whose photos are due for deletion (eBay keeps its own copies). */
    publishedBefore: async (before: number): Promise<DraftRow[]> =>
      (await docs.query<any>(C, { pk: PK, where: [{ f: "status", op: "=", v: "published" }, { f: "published_at", op: "<", v: before }] }))
        .map(strip)
        .filter((d) => !d.photos_deleted_at),
  };
}
