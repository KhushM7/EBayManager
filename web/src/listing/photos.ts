import { gradePixels, SIZE, type PhotoGrade } from "../photocheck";
import { dHash, sameShot, type Grey } from "./checks";

// On the phone, before upload: the photo is turned the right way up, resized to at most 2400 px, and
// re-encoded as JPEG. Re-encoding through a canvas keeps no metadata, so the photo's location (EXIF GPS)
// never leaves the phone. Then it's graded (../photocheck.ts) on a small copy, and fingerprinted to spot the
// same shot twice.

export const MAX_SIDE = 2400;
const QUALITY = 0.88;

export interface Processed {
  blob: Blob;
  width: number;
  height: number;
  /** The camera's original size. */
  original: { width: number; height: number };
  hash: string;
  grade: PhotoGrade;
  /** A small preview (data URL: the app's security policy allows images from itself and data URLs only). */
  preview: string;
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function rgba(src: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
  const ctx = canvas(w, h).getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function grey(src: CanvasImageSource, w: number, h: number): Grey {
  const d = rgba(src, w, h);
  const px = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) px[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { px, w, h };
}

/** Findings worth asking about before upload: anything graded "bad" (dark, blurry, tiny, the same shot twice). */
export const blocking = (g: PhotoGrade) => g.findings.filter((f) => f.tone === "bad");
/** The codes the server keeps with the photo: every finding that isn't "good". */
export const issueCodes = (g: PhotoGrade) => g.findings.filter((f) => f.tone !== "good").map((f) => f.code);

export async function processPhoto(file: File, otherHashes: string[]): Promise<Processed> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const full = canvas(width, height);
    const ctx = full.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((ok, fail) => full.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't prepare that photo"))), "image/jpeg", QUALITY));

    const hash = dHash(grey(full, 9, 8));
    const s = SIZE / Math.max(width, height);
    const gw = Math.max(1, Math.round(width * s));
    const gh = Math.max(1, Math.round(height * s));
    const grade = gradePixels(rgba(full, gw, gh), gw, gh, bitmap.width, bitmap.height, { duplicate: sameShot(hash, otherHashes) });

    const p = 240 / Math.max(width, height);
    const thumb = canvas(Math.round(width * p), Math.round(height * p));
    thumb.getContext("2d")!.drawImage(full, 0, 0, thumb.width, thumb.height);
    return { blob, width, height, original: { width: bitmap.width, height: bitmap.height }, hash, grade, preview: thumb.toDataURL("image/jpeg", 0.8) };
  } finally {
    bitmap.close();
  }
}
