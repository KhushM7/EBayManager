// Listing photos (docs/add-listing.md): private storage, and the server's own checks on what's uploaded.
// The phone resizes and re-encodes each photo (which drops its metadata) before upload; the server checks it's
// a real JPEG of sensible size and strips metadata again, so a photo's location never reaches our storage,
// Claude or eBay even if a client skipped that step. Photos are never public: the app serves them only to a
// signed-in person, and later sends them to Claude as image data and to eBay as uploaded bytes.

export interface PhotoStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Deletes every photo under a prefix (a draft's folder); returns how many. */
  deletePrefix(prefix: string): Promise<number>;
}

/** In memory, for tests and local runs. */
export function memoryPhotoStore(): PhotoStore & { keys(): string[] } {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, b),
    get: async (k) => m.get(k) ?? null,
    delete: async (k) => void m.delete(k),
    deletePrefix: async (p) => {
      let n = 0;
      for (const k of [...m.keys()]) if (k.startsWith(p)) (m.delete(k), n++);
      return n;
    },
    keys: () => [...m.keys()],
  };
}

/** Upload limits: eBay allows 24 photos; a phone photo resized to 2400 px is well under 3 MB. */
export const MAX_PHOTOS = 24;
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
export const MIN_LONG_SIDE = 500;
export const MAX_LONG_SIDE = 4000;

export const isJpeg = (b: Uint8Array) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Width and height from a JPEG's frame header, or null if it can't be read. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(b)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    // Start-of-frame markers (baseline, progressive, ...), excluding DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    if (marker === 0xda) return null; // image data started without a frame header
    i += 2 + len;
  }
  return null;
}

/**
 * The JPEG without metadata segments: EXIF and XMP (APP1, where a phone writes the location), IPTC (APP13),
 * other application segments and comments. Kept: JFIF (APP0), the colour profile (APP2) and Adobe's colour
 * transform (APP14), which change how the photo looks, and everything from the image data on.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  if (!isJpeg(b)) throw new Error("Not a JPEG");
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("Damaged JPEG");
    const marker = b[i + 1];
    if (marker === 0xda) {
      keep.push(b.subarray(i)); // start of scan: the rest is image data
      break;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw new Error("Damaged JPEG");
    const app = marker >= 0xe0 && marker <= 0xef;
    const drop = (app && ![0xe0, 0xe2, 0xee].includes(marker)) || marker === 0xfe;
    if (!drop) keep.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  const out = new Uint8Array(keep.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of keep) (out.set(p, o), (o += p.length));
  return out;
}

/** Checks an upload and returns it ready to store, or throws with a reason K can act on. */
export function acceptPhoto(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error("That photo is too large (over 6 MB). The app normally shrinks photos first: try again.");
  if (!isJpeg(bytes)) throw new Error("Only JPEG photos can be uploaded.");
  const size = jpegSize(bytes);
  if (!size) throw new Error("That photo couldn't be read.");
  const long = Math.max(size.width, size.height);
  if (long < MIN_LONG_SIDE) throw new Error(`That photo is too small (${size.width}×${size.height}). eBay needs at least 500 pixels; aim for 1600.`);
  if (long > MAX_LONG_SIDE) throw new Error(`That photo is too large (${size.width}×${size.height}). The app normally shrinks photos first: try again.`);
  return { bytes: stripJpegMetadata(bytes), ...size };
}
