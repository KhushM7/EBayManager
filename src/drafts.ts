import type { Env } from "./env";
import type { DraftPhoto, DraftRow } from "./store";
import { acceptPhoto, MAX_PHOTOS } from "./photos";
import { startJob } from "./background";
import { chooseCategory, choosePrice, editListing, missingSteps, quotePostage, reopenDraft, saveFacts, savePostage, submitDraft } from "./newlisting";

// New-listing drafts and their photos (docs/add-listing.md). Any of the three people can draft and approve
// (K's decision, 2026-11-05). Nothing here writes to eBay: submitting runs eBay's check and files a
// create_listing label, which reaches eBay only through the write gate after approval. Photos are stored
// privately and served only to a signed-in person; the nightly cleanup deletes an abandoned draft's photos
// after 30 days, and a published listing's 30 days after it went live (eBay keeps its own copies).

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
/** Open drafts at once: a guard against runaway uploads, far above what K needs. */
export const MAX_OPEN_DRAFTS = 50;
export const DRAFT_ABANDON_DAYS = 30;
export const PUBLISHED_PHOTO_DAYS = 30;
/** The ordinary edits a tidied copy may record (docs/add-listing.md, decision 4): nothing generative. */
export const ALLOWED_EDITS = ["crop", "straighten", "exposure", "contrast", "white_balance", "background"];

const photoKey = (draftId: string, photoId: string, suffix = "") => `drafts/${draftId}/${photoId}${suffix}.jpg`;

/** A draft for the app: photo addresses, and what's still needed before it can be submitted. */
const view = (d: DraftRow) => ({
  ...d,
  photos: d.photos.map((p) => ({ ...p, url: `/api/drafts/${d.id}/photos/${p.id}`, originalUrl: `/api/drafts/${d.id}/photos/${p.id}?original=1` })),
  missing: d.status === "open" ? missingSteps(d) : [],
});

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const fail = (e: unknown, status = 400) => json({ error: e instanceof Error ? e.message : String(e) }, status);

/** The /api/drafts routes, or null if the path isn't one. Called after sign-in and the request checks. */
export async function handleDrafts(env: Env, request: Request, url: URL, path: string, user: { name: string }): Promise<Response | null> {
  if (!path.startsWith("/drafts")) return null;
  const method = request.method;
  const now = Date.now();

  if (path === "/drafts" && method === "GET") return json((await env.store.drafts.list("open")).map(view));
  if (path === "/drafts/submitted" && method === "GET")
    return json([...(await env.store.drafts.list("submitted")), ...(await env.store.drafts.list("published"))].slice(0, 30).map(view));
  if (path === "/drafts/defaults" && method === "GET") return json({ postcode: await env.store.kv.get("seller_postcode") });
  if (path === "/drafts" && method === "POST") {
    if ((await env.store.drafts.list("open")).length >= MAX_OPEN_DRAFTS) return json({ error: `There are already ${MAX_OPEN_DRAFTS} drafts open. Finish or delete some first.` }, 400);
    return json(view(await env.store.drafts.create(user.name, now)));
  }

  const m = path.match(/^\/drafts\/(draft_[\w-]{1,64})(?:\/photos(?:\/([\w-]{1,40})(?:\/(remove|edited|use))?)?|\/([a-z-]{1,20}))?$/);
  if (!m) return json({ error: "Not found" }, 404);
  const [, id, photoId, photoAction, action] = m;
  const isPhotos = path.includes("/photos");
  const draft = await env.store.drafts.get(id);
  if (!draft) return json({ error: "Not found" }, 404);

  // A photo (the version chosen for the listing, or ?original=1), served to a signed-in person only.
  if (isPhotos && photoId && !photoAction && method === "GET") {
    const p = draft.photos.find((x) => x.id === photoId);
    const key = p ? (url.searchParams.get("original") !== "1" && p.use_edited && p.edited ? p.edited.key : p.key) : null;
    const bytes = key && env.photos ? await env.photos.get(key) : null;
    if (!bytes) return json({ error: "Not found" }, 404);
    return new Response(bytes as unknown as BodyInit, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline" } });
  }
  if (!isPhotos && !action && method === "GET") return json(view(draft));
  if (method !== "POST") return json({ error: "Not found" }, 404);

  // Upload one photo: the JPEG bytes as the body; what the phone's checks found and the shot's fingerprint in
  // the query (?issues=dark,blur&hash=<16 hex>).
  if (isPhotos && !photoId) {
    if (!env.photos) return json({ error: "Photo storage isn't set up here." }, 503);
    if (draft.status !== "open") return json({ error: "This draft has been submitted and can't be changed." }, 409);
    if (draft.photos.length >= MAX_PHOTOS) return json({ error: `eBay allows ${MAX_PHOTOS} photos per listing.` }, 400);
    let photo: ReturnType<typeof acceptPhoto>;
    try {
      photo = acceptPhoto(new Uint8Array(await request.arrayBuffer()));
    } catch (e) {
      return fail(e);
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
      return fail(e);
    }
  }

  if (isPhotos && photoId) {
    const p = draft.photos.find((x) => x.id === photoId);
    if (!p) return json({ error: "Not found" }, 404);
    try {
      if (photoAction === "remove") {
        const d = await env.store.drafts.removePhoto(id, photoId, now);
        await env.photos?.delete(p.key);
        if (p.edited) await env.photos?.delete(p.edited.key);
        return json(view(d!));
      }
      if (photoAction === "edited") {
        // A tidied copy made on the phone with ordinary edits only; the original is kept and stays selectable.
        if (!env.photos) return json({ error: "Photo storage isn't set up here." }, 503);
        const edits = (url.searchParams.get("edits") ?? "").split(",").filter((x) => ALLOWED_EDITS.includes(x));
        if (!edits.length) return json({ error: "Say which edits were made." }, 400);
        const photo = acceptPhoto(new Uint8Array(await request.arrayBuffer()));
        const key = photoKey(id, photoId, "-tidy");
        await env.photos.put(key, photo.bytes, "image/jpeg");
        return json(view((await env.store.drafts.setEdited(id, photoId, { key, bytes: photo.bytes.length, width: photo.width, height: photo.height, at: now, edits }, true, now))!));
      }
      if (photoAction === "use") {
        const b = await readJson(request);
        return json(view((await env.store.drafts.setEdited(id, photoId, undefined, b.edited === true, now))!));
      }
    } catch (e) {
      return fail(e);
    }
    return json({ error: "Not found" }, 404);
  }

  const b = await readJson(request);
  const job = async (kind: "draft_review" | "draft_compose" | "draft_price") => {
    if (draft.status !== "open") return json({ error: "This draft has been submitted and can't be changed." }, 409);
    const j = await startJob(env, kind, { draftId: id }, user.name);
    return json(j.status === "queued" ? j : view(j.result as DraftRow));
  };

  try {
    switch (action) {
      case undefined: {
        const title = typeof b.title === "string" ? b.title.trim().slice(0, 120) || null : undefined;
        return json(view((await env.store.drafts.update(id, title === undefined ? {} : { title }, now))!));
      }
      case "order":
        if (!Array.isArray(b.order) || !b.order.every((x: unknown) => typeof x === "string")) return json({ error: "Send the photo order" }, 400);
        return json(view((await env.store.drafts.orderPhotos(id, b.order.slice(0, MAX_PHOTOS), now))!));
      case "delete":
        // Deleting a draft deletes its photos at once.
        if (draft.status === "submitted") return json({ error: "Its label is waiting in the Inbox: reject it, then delete the draft." }, 409);
        await env.store.drafts.setStatus(id, "abandoned", now);
        await env.photos?.deletePrefix(`drafts/${id}/`);
        return json({ ok: true });
      case "review":
        return await job("draft_review");
      case "facts":
        return json(view(await saveFacts(env, id, b)));
      case "category":
        return json(view(await chooseCategory(env, id, String(b.categoryId ?? ""))));
      case "compose":
        return await job("draft_compose");
      case "listing":
        return json(view(await editListing(env, id, b)));
      case "price-check":
        return await job("draft_price");
      case "price":
        return json(view(await choosePrice(env, id, b)));
      case "postage":
        return json(view(await savePostage(env, id, b)));
      case "quotes":
        return json(view(await quotePostage(env, id, b)));
      case "submit": {
        const out = await submitDraft(env, id);
        return json({ ...view(out.draft), note: out.note });
      }
      case "reopen":
        return json(view(await reopenDraft(env, id)));
    }
  } catch (e) {
    return fail(e);
  }
  return json({ error: "Not found" }, 404);
}

/**
 * Nightly: drafts nobody has touched for 30 days are abandoned and their photos deleted; a published
 * listing's photos are deleted 30 days after it went live (eBay keeps its own copies).
 */
export async function cleanUpDrafts(env: Env, now: number): Promise<string> {
  const stale = await env.store.drafts.stale(now - DRAFT_ABANDON_DAYS * 86_400_000);
  let photos = 0;
  for (const d of stale) {
    await env.store.drafts.setStatus(d.id, "abandoned", now);
    photos += (await env.photos?.deletePrefix(`drafts/${d.id}/`)) ?? 0;
  }
  const published = await env.store.drafts.publishedBefore(now - PUBLISHED_PHOTO_DAYS * 86_400_000);
  for (const d of published) {
    photos += (await env.photos?.deletePrefix(`drafts/${d.id}/`)) ?? 0;
    await env.store.drafts.setStatus(d.id, "published", now, { photos_deleted_at: now });
  }
  return `${stale.length} abandoned, ${published.length} published cleared, ${photos} photos deleted`;
}
