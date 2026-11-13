import type { Env } from "./env";
import { isJpeg, jpegSize, stripJpegMetadata } from "./photos";
import { watched } from "./services";

// The photo AI tools (docs/imageai.md, K's decision 2026-11-13): background removal, spot removal of clutter
// and upscale, run by K's own container (imageai/) on Azure Container Apps, scaled to zero so it costs nothing
// unless one of these is used. The app checks the photo, strips its metadata (no location) and forwards it with
// the shared key; only the photo goes, never anything about K or a buyer. Nothing is stored there.
//
// POST /api/photo-ai/{op}, multipart: image (JPEG or PNG, long side <= 2400) and, for erase, mask (PNG, same
// size, white = remove). 200: the edited photo (PNG with alpha for remove_background, else JPEG) with X-Edit.

export const OPS = { remove_background: "ai_background", erase: "ai_erase", upscale: "ai_upscale" } as const;
export type Op = keyof typeof OPS;

export const MAX_BYTES = 12 * 1024 * 1024;
export const MAX_SIDE = 2400;
/** The first call after the container has scaled to zero waits for it to start (30–90 s), then the model runs. */
export const TIMEOUT_MS = 180_000;

const isPng = (b: Uint8Array) => b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52;

/** A PNG's size, from its header chunk (IHDR, always first). */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isPng(b)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const err = (status: number, error: string, code?: string) =>
  Response.json(code ? { error, code } : { error }, { status, headers: { "Cache-Control": "no-store" } });

class Bad extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads one uploaded file and checks it's a real JPEG or PNG within the limits. */
async function readPart(form: FormData, name: string, what: string, kinds: ("jpeg" | "png")[]) {
  const f = form.get(name);
  if (!f || typeof f === "string") throw new Bad(400, `No ${what} was sent.`);
  if (f.size > MAX_BYTES) throw new Bad(413, `The ${what} is over 12 MB.`);
  let bytes: Uint8Array = new Uint8Array(await f.arrayBuffer());
  const jpeg = kinds.includes("jpeg") && isJpeg(bytes);
  const size = jpeg ? jpegSize(bytes) : kinds.includes("png") ? pngSize(bytes) : null;
  if (!size || !size.width || !size.height) throw new Bad(415, `The ${what} must be a ${kinds.map((k) => k.toUpperCase()).join(" or ")}.`);
  if (Math.max(size.width, size.height) > MAX_SIDE) throw new Bad(413, `The ${what} is larger than ${MAX_SIDE}px on its long side.`);
  // Location and camera details never leave the app.
  if (jpeg) bytes = stripJpegMetadata(bytes);
  return { bytes, size, type: jpeg ? "image/jpeg" : "image/png" };
}

export async function handlePhotoAi(env: Env, request: Request, op: string): Promise<Response> {
  if (!(op in OPS)) return err(404, "Not found");
  if (request.method !== "POST") return err(405, "Use POST");
  if (!env.IMAGEAI_URL || !env.IMAGEAI_KEY) return err(503, "The photo AI tools aren't set up yet (docs/imageai.md).", "not_set_up");
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > 2 * MAX_BYTES + 64 * 1024) return err(413, "The upload is too large.");

  let out: FormData;
  try {
    const form = await request.formData().catch(() => {
      throw new Bad(400, "Send the photo as a form upload.");
    });
    const image = await readPart(form, "image", "photo", ["jpeg", "png"]);
    out = new FormData();
    out.append("image", new Blob([image.bytes as BlobPart], { type: image.type }), image.type === "image/png" ? "image.png" : "image.jpg");
    if (op === "erase") {
      const mask = await readPart(form, "mask", "mask", ["png"]);
      if (mask.size.width !== image.size.width || mask.size.height !== image.size.height) throw new Bad(400, "The mask must be the same size as the photo.");
      out.append("mask", new Blob([mask.bytes as BlobPart], { type: "image/png" }), "mask.png");
    }
    if (op === "upscale") {
      // A full-size photo is enhanced at its own size (detail, blur, noise), not refused: quality is the point.
      const d = Number(form.get("denoise"));
      if (Number.isFinite(d) && form.get("denoise") != null) out.append("denoise", String(Math.min(1, Math.max(0, d))));
    }
  } catch (e) {
    if (e instanceof Bad) return err(e.status, e.message);
    throw e;
  }

  let res: Response;
  try {
    res = await watched(env, "imageai", () =>
      fetch(`${env.IMAGEAI_URL!.replace(/\/+$/, "")}/v1/${op}`, {
        method: "POST",
        headers: { "X-ImageAI-Key": env.IMAGEAI_KEY! },
        body: out,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError") return err(504, "The photo AI took too long. It may still be starting up: try again in a minute.", "timeout");
    return err(502, "The photo AI couldn't be reached. Try again in a minute.", "unreachable");
  }

  if (res.ok) {
    const type = res.headers.get("Content-Type") ?? "";
    if (!/^image\/(png|jpeg)\b/.test(type)) return err(502, "The photo AI sent back something that isn't a photo.", "bad_reply");
    return new Response(await res.arrayBuffer(), { status: 200, headers: { "Content-Type": type, "X-Edit": OPS[op as Op], "Cache-Control": "no-store" } });
  }
  // The container's own words for a photo it can't use (too large, nothing to erase); anything else stays vague.
  if (res.status === 400 || res.status === 413 || res.status === 415) {
    const b = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    return err(res.status, typeof b?.error === "string" ? b.error.slice(0, 300) : "The photo AI couldn't use that photo.", typeof b?.code === "string" ? b.code : undefined);
  }
  if (res.status === 401 || res.status === 403) return err(502, "The photo AI refused the app's key (docs/imageai.md).", "key_rejected");
  return err(502, `The photo AI failed (${res.status}). Try again in a minute.`, "failed");
}
