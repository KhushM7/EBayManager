// The same-shot check and the photo checklist (docs/add-listing.md, step 1). The light, focus, framing and
// size measures live in ../photocheck.ts, the app's one set of photo checks; this file keeps what that one
// doesn't do: a fingerprint of each photo, so the same shot twice is spotted (also against photos uploaded
// earlier, whose fingerprints the server keeps). Pure functions, tested without a browser.

export interface Grey {
  /** Luminance 0 to 255, row by row. */
  px: Uint8ClampedArray | number[];
  w: number;
  h: number;
}

/** Photos whose 64-bit difference hashes differ in this few bits count as the same shot. */
export const SAME_SHOT_BITS = 5;

/** A 64-bit difference hash of a 9×8 greyscale copy, as a string of 0s and 1s (to spot the same shot twice). */
export function dHash(g: Grey): string {
  if (g.w !== 9 || g.h !== 8) throw new Error("dHash needs a 9×8 copy");
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g.px[y * 9 + x] < g.px[y * 9 + x + 1] ? "1" : "0";
  return bits;
}

export const hamming = (a: string, b: string) => [...a].reduce((n, c, i) => n + (c === b[i] ? 0 : 1), 0);

/** Whether this fingerprint matches any of the others. */
export const sameShot = (hash: string, others: string[]) => others.some((h) => hamming(h, hash) <= SAME_SHOT_BITS);

/** The 64 bits as 16 hex digits (how the server stores them), and back. */
export const bitsToHex = (bits: string) => (bits.match(/.{4}/g) ?? []).map((n) => parseInt(n, 2).toString(16)).join("");
export const hexToBits = (hex: string) => [...hex].map((c) => parseInt(c, 16).toString(2).padStart(4, "0")).join("");

/** The checklist shown before the camera opens (docs/listing-assistant.md, "Taking the photos"). */
export const CHECKLIST = [
  { title: "Light", text: "Daylight from a window, or two lamps either side. No flash: it causes glare and hard shadows." },
  { title: "Background", text: "Plain and uncluttered, and the same one every time: a white or light grey sheet, card or wall." },
  { title: "Framing", text: "The item fills most of the photo, straight on, with nothing else in shot." },
  { title: "Shots", text: "Front, back, sides, top and bottom, the label or model number, every accessory, the box if there is one, and a close-up of every flaw." },
  { title: "Scale", text: "When size matters, include something everyone knows the size of." },
  { title: "Focus", text: "Hold steady and tap the item to focus. Blurry photos are flagged so you can retake them." },
];
