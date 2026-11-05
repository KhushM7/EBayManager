import type { Doc, DocStore } from "./doc";

// New-listing drafts (docs/add-listing.md), in the listings container under their own partition. A draft is
// saved at every step and resumed later; its photos live in the photo store under `drafts/<draft id>/`.
// Later steps (facts, category, price, postage) add fields; the photo list is changed only through the
// methods below, with an etag so two quick uploads can't lose each other.

const C = "listings" as const;
const PK = "drafts";

export type DraftStatus = "open" | "submitted" | "published" | "abandoned";

export interface DraftPhoto {
  id: string;
  key: string;
  width: number;
  height: number;
  bytes: number;
  /** What the phone's checks found (too dark, blurry, small, a duplicate), and whether K kept it anyway. */
  issues: string[];
  /** The phone's 64-bit fingerprint of the shot (hex), to spot the same shot twice across sessions. */
  hash: string | null;
  added_at: number;
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
}

const strip = ({ pk, type, _etag, ttl, _rid, _self, _attachments, _ts, ...r }: any) => r as DraftRow;

export function draftsRepo(docs: DocStore) {
  /** Read-modify-write with the etag, retried: photo uploads can arrive close together. */
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
    /** K's own fields only; status and photos change through their own methods. */
    update: (id: string, fields: { title?: string | null }, now: number) =>
      change(id, (d) => (d.status !== "open" ? null : { ...d, ...fields, updated_at: now })),
    addPhoto: (id: string, photo: DraftPhoto, max: number, now: number) =>
      change(id, (d) => {
        if (d.status !== "open") throw new Error("This draft has been submitted and can't be changed.");
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
    setStatus: (id: string, status: DraftStatus, now: number) => change(id, (d) => ({ ...d, status, updated_at: now })),
    /** Open drafts nobody has touched since `before`: abandoned by the nightly cleanup. */
    stale: async (before: number): Promise<DraftRow[]> =>
      (await docs.query<any>(C, { pk: PK, where: [{ f: "status", op: "=", v: "open" }, { f: "updated_at", op: "<", v: before }] })).map(strip),
  };
}
