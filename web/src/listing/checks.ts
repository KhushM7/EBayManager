// The phone's instant photo checks (docs/add-listing.md, step 1): free, no upload needed. Pure functions over
// a small greyscale copy of the photo, so they're tested without a browser.

export interface Grey {
  /** Luminance 0 to 255, row by row. */
  px: Uint8ClampedArray | number[];
  w: number;
  h: number;
}

export type IssueCode = "small" | "dark" | "bright" | "blur" | "duplicate";

export interface Issue {
  code: IssueCode;
  /** What's wrong and what to do, in one line. */
  advice: string;
}

/** eBay needs 500 px on the long side; 1600 or more lets buyers zoom in. */
export const GOOD_LONG_SIDE = 1600;
/** Average brightness bounds (0 to 255) of a well-lit photo on a light background. */
export const TOO_DARK = 75;
export const TOO_BRIGHT = 235;
/**
 * Below this, the edges are too soft (variance of the Laplacian on a 512 px copy). A starting value, to be tuned
 * on K's real photos in the Sandbox walk-through; a wrong flag never blocks a photo ("Keep anyway").
 */
export const BLUR_LIMIT = 60;
/** Photos whose 64-bit difference hashes differ in this few bits count as the same shot. */
export const SAME_SHOT_BITS = 5;

export function meanLuminance(g: Grey): number {
  let sum = 0;
  for (let i = 0; i < g.px.length; i++) sum += g.px[i];
  return g.px.length ? sum / g.px.length : 0;
}

/** Sharpness: the variance of the Laplacian (a standard focus measure). Low means blurry. */
export function laplacianVariance(g: Grey): number {
  const { px, w, h } = g;
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = px[i - w] + px[i + w] + px[i - 1] + px[i + 1] - 4 * px[i];
      sum += l;
      sq += l * l;
      n++;
    }
  if (!n) return 0;
  const mean = sum / n;
  return sq / n - mean * mean;
}

/** A 64-bit difference hash of a 9×8 greyscale copy, as a string of 0s and 1s (to spot the same shot twice). */
export function dHash(g: Grey): string {
  if (g.w !== 9 || g.h !== 8) throw new Error("dHash needs a 9×8 copy");
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g.px[y * 9 + x] < g.px[y * 9 + x + 1] ? "1" : "0";
  return bits;
}

export const hamming = (a: string, b: string) => [...a].reduce((n, c, i) => n + (c === b[i] ? 0 : 1), 0);

/** The 64 bits as 16 hex digits (how the server stores them), and back. */
export const bitsToHex = (bits: string) => (bits.match(/.{4}/g) ?? []).map((n) => parseInt(n, 2).toString(16)).join("");
export const hexToBits = (hex: string) => [...hex].map((c) => parseInt(c, 16).toString(2).padStart(4, "0")).join("");

/** Everything the phone found about one photo, with advice; an empty list means it's good. */
export function photoIssues(input: { width: number; height: number; grey: Grey; hash: string; otherHashes: string[] }): Issue[] {
  const issues: Issue[] = [];
  const long = Math.max(input.width, input.height);
  if (long < GOOD_LONG_SIDE)
    issues.push({ code: "small", advice: `Only ${input.width}×${input.height}. Use the phone's main camera (not a screenshot) so buyers can zoom in.` });
  const light = meanLuminance(input.grey);
  if (light < TOO_DARK) issues.push({ code: "dark", advice: "Too dark. Try daylight from a window, or two lamps either side. No flash." });
  else if (light > TOO_BRIGHT) issues.push({ code: "bright", advice: "Too bright: details are washed out. Move out of direct sun or away from the lamp." });
  if (laplacianVariance(input.grey) < BLUR_LIMIT)
    issues.push({ code: "blur", advice: "Looks blurry. Hold the phone steady, tap the item to focus, and retake." });
  if (input.otherHashes.some((h) => hamming(h, input.hash) <= SAME_SHOT_BITS))
    issues.push({ code: "duplicate", advice: "Looks the same as another photo. Try a different side, the label, or a close-up of any wear." });
  return issues;
}

/** The checklist shown before the camera opens (docs/listing-assistant.md, "Taking the photos"). */
export const CHECKLIST = [
  { title: "Light", text: "Daylight from a window, or two lamps either side. No flash: it causes glare and hard shadows." },
  { title: "Background", text: "Plain and uncluttered, and the same one every time: a white or light grey sheet, card or wall." },
  { title: "Framing", text: "The item fills most of the photo, straight on, with nothing else in shot." },
  { title: "Shots", text: "Front, back, sides, top and bottom, the label or model number, every accessory, the box if there is one, and a close-up of every flaw." },
  { title: "Scale", text: "When size matters, include something everyone knows the size of." },
  { title: "Focus", text: "Hold steady and tap the item to focus. Blurry photos are flagged so you can retake them." },
];
