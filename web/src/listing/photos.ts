import { dHash, photoIssues, type Grey, type Issue } from "./checks";

// On the phone, before upload: the photo is turned the right way up, resized to at most 2400 px, and
// re-encoded as JPEG. Re-encoding through a canvas keeps no metadata, so the photo's location (EXIF GPS)
// never leaves the phone. The checks run on a small greyscale copy.

export const MAX_SIDE = 2400;
const QUALITY = 0.88;

export interface Processed {
  blob: Blob;
  width: number;
  height: number;
  /** The camera's original size (for the resolution check). */
  original: { width: number; height: number };
  hash: string;
  issues: Issue[];
  /** A small preview (data URL: the app's security policy allows images from itself and data URLs only). */
  preview: string;
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function grey(src: CanvasImageSource, w: number, h: number): Grey {
  const c = canvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const px = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) px[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { px, w, h };
}

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

    const s = 512 / Math.max(width, height);
    const g = grey(full, Math.max(9, Math.round(width * s)), Math.max(8, Math.round(height * s)));
    const hash = dHash(grey(full, 9, 8));
    const issues = photoIssues({ width: bitmap.width, height: bitmap.height, grey: g, hash, otherHashes });

    const p = 240 / Math.max(width, height);
    const thumb = canvas(Math.round(width * p), Math.round(height * p));
    thumb.getContext("2d")!.drawImage(full, 0, 0, thumb.width, thumb.height);
    return { blob, width, height, original: { width: bitmap.width, height: bitmap.height }, hash, issues, preview: thumb.toDataURL("image/jpeg", 0.8) };
  } finally {
    bitmap.close();
  }
}
