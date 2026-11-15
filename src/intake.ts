import type { Env } from "./env";
import { acceptPhoto } from "./photos";

// Stock Room intake (docs/power-platform.md, Phase 3): the Power Apps "Stock Room" app logs things around the
// house someone wants to sell, and a Power Automate flow sends the ones marked "sell" here.
//
// - It makes drafts only. A draft is not a proposal: it changes nothing on eBay, and reaches eBay only if a
//   signed-in person takes it through the New listing wizard and a person approves the label. Nothing here
//   imports the proposal code or the write gate (test/readonly.test.ts follows the imports).
// - Its own key (INTAKE_API_KEY, sent as X-Api-Key), separate from the read-only key and from sign-ins. Unset
//   or shorter than 32 characters, the endpoint doesn't exist; a wrong key sees the blank 404.
// - What the family typed (room, owner, condition) goes in the draft's name, which only the drafts list shows.
//   It isn't given to Claude or eBay as a fact about the item: the wizard asks the person listing it.

export const INTAKE_KEY_HEADER = "X-Api-Key";
const MIN_KEY_LENGTH = 32;
const WRONG_KEYS_PER_HOUR = 20;
/** At most this many intake drafts a day, whatever the flow does. */
export const INTAKE_DRAFTS_PER_DAY = 30;
/** Open drafts allowed in all (the same limit as the app, src/drafts.ts). */
const MAX_OPEN_DRAFTS = 50;
/** A base64 photo of at most 6 MB (src/photos.ts) is about 8 MB of text. */
const MAX_BODY_BYTES = 9 * 1024 * 1024;

const blank = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

function sameKey(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** One line of plain text: no control characters, links or line breaks, cut to length. */
const line = (v: unknown, max: number) =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

export async function handleIntake(
  env: Env,
  request: Request,
  url: URL,
  attempts: { tooMany(key: string, limit: number, windowMs: number): Promise<boolean>; record(key: string): Promise<void> },
  ip: string,
): Promise<Response> {
  const key = env.INTAKE_API_KEY ?? "";
  if (key.length < MIN_KEY_LENGTH) return blank();
  if (await attempts.tooMany(`intake:${ip}`, WRONG_KEYS_PER_HOUR, 3_600_000)) return blank();
  if (!sameKey(request.headers.get(INTAKE_KEY_HEADER) ?? "", key)) {
    await attempts.record(`intake:${ip}`);
    return blank();
  }
  if (url.pathname !== "/api/intake/drafts") return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Too large. Send one photo of at most 6 MB." }, 413);
  let b: any;
  try {
    b = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "Send JSON" }, 400);
  }
  const title = line(b?.title, 80);
  if (!title) return json({ error: "Give the item a name (title)" }, 400);
  // The Stock Room row's id: sending the same row twice makes one draft.
  const sourceId = line(b?.sourceId, 80);
  if (!/^[\w-]{1,80}$/.test(sourceId)) return json({ error: "Give the Stock Room row's id (sourceId: letters, digits, - and _)" }, 400);
  const owner = line(b?.owner, 40);
  const location = line(b?.location, 60);
  const condition = line(b?.condition, 40);

  const now = Date.now();
  const seenKey = `intake:${sourceId}`;
  const seen = await env.store.kv.get(seenKey);
  if (seen) return json({ draftId: seen, created: false, status: "Already sent: the draft is in the app's drafts list." });

  // The photo is checked before anything is stored, so a bad one leaves no half-made draft.
  let photo: ReturnType<typeof acceptPhoto> | null = null;
  if (b.photoBase64 != null && b.photoBase64 !== "") {
    if (!env.photos) return json({ error: "Photo storage isn't set up here." }, 503);
    try {
      const text = String(b.photoBase64).replace(/^data:image\/jpeg;base64,/, "");
      photo = acceptPhoto(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
    } catch (e) {
      return json({ error: e instanceof Error && !/atob|decode|character/i.test(e.message) ? e.message : "The photo couldn't be read. Send a JPEG as base64." }, 400);
    }
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const countKey = `intake_count:${day}`;
  const count = Number((await env.store.kv.get(countKey)) ?? 0);
  if (count >= INTAKE_DRAFTS_PER_DAY) return json({ error: `At most ${INTAKE_DRAFTS_PER_DAY} items a day can be sent. Try again tomorrow.` }, 429);
  if ((await env.store.drafts.list("open")).length >= MAX_OPEN_DRAFTS) return json({ error: `There are already ${MAX_OPEN_DRAFTS} drafts open in the app. Finish or delete some first.` }, 409);

  const by = owner ? `${owner} (Stock Room)` : "Stock Room";
  const draft = await env.store.drafts.create(by, now);
  const name = [title, location && `in ${location}`, condition, owner && `from ${owner}`].filter(Boolean).join(" · ").slice(0, 120);
  await env.store.drafts.update(draft.id, { title, name }, now);
  let photoAdded = false;
  if (photo && env.photos) {
    const pid = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const photoKey = `drafts/${draft.id}/${pid}.jpg`; // the same layout as src/drafts.ts, so clean-up finds it
    await env.photos.put(photoKey, photo.bytes, "image/jpeg");
    try {
      await env.store.drafts.addPhoto(draft.id, { id: pid, key: photoKey, width: photo.width, height: photo.height, bytes: photo.bytes.length, issues: [], hash: null, added_at: now }, 24, now);
      photoAdded = true;
    } catch {
      await env.photos.delete(photoKey);
    }
  }
  await env.store.kv.set(seenKey, draft.id);
  await env.store.kv.set(countKey, String(count + 1));
  return json({ draftId: draft.id, created: true, photoAdded, status: "Saved as a draft. Someone finishes it in the app (New listing), and a person approves it before it goes on eBay." }, 201);
}
