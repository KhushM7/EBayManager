import type { Env } from "./env";
import type { DraftPhoto, DraftRow } from "./store";
import { acceptPhoto, MAX_PHOTOS } from "./photos";

// New-listing drafts and their photos (docs/add-listing.md, step L1). Any of the three people can draft
// (K's decision, 2026-11-05). Nothing here touches eBay. Photos are stored privately and served only to a
// signed-in person; an abandoned draft's photos are deleted after 30 days by the nightly cleanup.

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
/** Open drafts at once: a guard against runaway uploads, far above what K needs. */
export const MAX_OPEN_DRAFTS = 50;
export const DRAFT_ABANDON_DAYS = 30;

const photoKey = (draftId: string, photoId: string) => `drafts/${draftId}/${photoId}.jpg`;

/** What the app returns for a draft: its photos with the address they're served from. */
const view = (d: DraftRow) => ({ ...d, photos: d.photos.map((p) => ({ ...p, url: `/api/drafts/${d.id}/photos/${p.id}` })) });

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** The /api/drafts routes, or null if the path isn't one. Called after sign-in and the request checks. */
export async function handleDrafts(env: Env, request: Request, url: URL, path: string, user: { name: string }): Promise<Response | null> {
  if (!path.startsWith("/drafts")) return null;
  const method = request.method;
  const now = Date.now();

  if (path === "/drafts" && method === "GET") return json((await env.store.drafts.list("open")).map(view));
  if (path === "/drafts" && method === "POST") {
    if ((await env.store.drafts.list("open")).length >= MAX_OPEN_DRAFTS) return json({ error: `There are already ${MAX_OPEN_DRAFTS} drafts open. Finish or delete some first.` }, 400);
    return json(view(await env.store.drafts.create(user.name, now)));
  }

  const m = path.match(/^\/drafts\/(draft_[\w-]{1,64})(?:\/(photos)(?:\/([\w-]{1,40}))?|\/(delete|order))?$/);
  if (!m) return json({ error: "Not found" }, 404);
  const [, id, photos, photoId, action] = m;
  const draft = await env.store.drafts.get(id);
  if (!draft) return json({ error: "Not found" }, 404);

  // A photo, served to a signed-in person only, never cached by anything shared.
  if (photos && photoId && method === "GET") {
    const p = draft.photos.find((x) => x.id === photoId);
    const bytes = p && env.photos ? await env.photos.get(p.key) : null;
    if (!bytes) return json({ error: "Not found" }, 404);
    return new Response(bytes as unknown as BodyInit, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline" } });
  }

  if (!photos && !action && method === "GET") return json(view(draft));
  if (method !== "POST") return json({ error: "Not found" }, 404);

  // Upload one photo: the JPEG bytes as the body; what the phone's checks found and the shot's fingerprint in
  // the query (?issues=dark,blur&hash=<16 hex>).
  if (photos && !photoId) {
    if (!env.photos) return json({ error: "Photo storage isn't set up here." }, 503);
    if (draft.status !== "open") return json({ error: "This draft has been submitted and can't be changed." }, 409);
    if (draft.photos.length >= MAX_PHOTOS) return json({ error: `eBay allows ${MAX_PHOTOS} photos per listing.` }, 400);
    let photo: ReturnType<typeof acceptPhoto>;
    try {
      photo = acceptPhoto(new Uint8Array(await request.arrayBuffer()));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    const pid = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const key = photoKey(id, pid);
    const issues = (url.searchParams.get("issues") ?? "").split(",").filter((x) => /^[a-z_]{1,20}$/.test(x)).slice(0, 8);
    const hash = /^[0-9a-f]{16}$/.test(url.searchParams.get("hash") ?? "") ? url.searchParams.get("hash") : null;
    const meta: DraftPhoto = { id: pid, key, width: photo.width, height: photo.height, bytes: photo.bytes.length, issues, hash, added_at: now };
    await env.photos.put(key, photo.bytes, "image/jpeg");
    try {
      return json(view((await env.store.drafts.addPhoto(id, meta, MAX_PHOTOS, now))!));
    } catch (e) {
      await env.photos.delete(key); // not added to the draft: don't keep it
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  if (photos && photoId) {
    // POST /drafts/:id/photos/:pid removes the photo (the only POST on a single photo).
    const p = draft.photos.find((x) => x.id === photoId);
    if (!p) return json({ error: "Not found" }, 404);
    const d = await env.store.drafts.removePhoto(id, photoId, now);
    await env.photos?.delete(p.key);
    return json(view(d!));
  }

  if (action === "order") {
    const { order } = await readJson(request);
    if (!Array.isArray(order) || !order.every((x) => typeof x === "string")) return json({ error: "Send the photo order" }, 400);
    return json(view((await env.store.drafts.orderPhotos(id, order.slice(0, MAX_PHOTOS), now))!));
  }

  if (action === "delete") {
    // Deleting a draft deletes its photos at once.
    await env.store.drafts.setStatus(id, "abandoned", now);
    await env.photos?.deletePrefix(`drafts/${id}/`);
    return json({ ok: true });
  }

  // POST /drafts/:id: K's fields.
  const b = await readJson(request);
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 120) || null : undefined;
  const d = await env.store.drafts.update(id, title === undefined ? {} : { title }, now);
  return json(view(d!));
}

/** Nightly: drafts nobody has touched for 30 days are abandoned and their photos deleted. */
export async function cleanUpDrafts(env: Env, now: number): Promise<string> {
  const stale = await env.store.drafts.stale(now - DRAFT_ABANDON_DAYS * 86_400_000);
  let photos = 0;
  for (const d of stale) {
    await env.store.drafts.setStatus(d.id, "abandoned", now);
    photos += (await env.photos?.deletePrefix(`drafts/${d.id}/`)) ?? 0;
  }
  return `${stale.length} abandoned, ${photos} photos deleted`;
}
