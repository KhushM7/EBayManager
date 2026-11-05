import { describe, expect, it } from "vitest";
import { BLUR_LIMIT, bitsToHex, dHash, hamming, hexToBits, laplacianVariance, meanLuminance, photoIssues, type Grey } from "../web/src/listing/checks";

// The phone's instant photo checks (docs/add-listing.md, step 1), on synthetic greyscale images.

const W = 128;
const H = 96;
/** A checkerboard of 8 px squares between two shades: sharp edges everywhere. */
const sharp = (lo = 60, hi = 200): Grey => ({ w: W, h: H, px: Array.from({ length: W * H }, (_, i) => (((i % W) >> 3) + ((Math.floor(i / W)) >> 3)) % 2 ? hi : lo) });
/** The same, heavily smoothed: what a shaky or out-of-focus shot looks like. */
function blurred(g: Grey, passes = 16): Grey {
  let px = [...g.px];
  for (let p = 0; p < passes; p++) {
    const next = [...px];
    for (let y = 1; y < g.h - 1; y++)
      for (let x = 1; x < g.w - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += px[(y + dy) * g.w + x + dx];
        next[y * g.w + x] = s / 9;
      }
    px = next;
  }
  return { ...g, px };
}
const flat = (v: number): Grey => ({ w: W, h: H, px: new Array(W * H).fill(v) });
const tiny = (f: (x: number, y: number) => number): Grey => ({ w: 9, h: 8, px: Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9))) });

describe("photo checks", () => {
  it("measures brightness", () => {
    expect(meanLuminance(flat(40))).toBe(40);
    expect(meanLuminance(sharp())).toBeCloseTo(130, 0);
  });

  it("tells sharp from blurry", () => {
    expect(laplacianVariance(sharp())).toBeGreaterThan(BLUR_LIMIT * 10);
    expect(laplacianVariance(blurred(sharp()))).toBeLessThan(BLUR_LIMIT);
  });

  it("spots the same shot twice, but not a different one", () => {
    const a = dHash(tiny((x, y) => x * 20 + y));
    const same = dHash(tiny((x, y) => x * 20 + y + 3));
    const other = dHash(tiny((x, y) => (x % 2 ? 200 : 10) + y));
    expect(hamming(a, same)).toBe(0);
    expect(hamming(a, other)).toBeGreaterThan(5);
    expect(hexToBits(bitsToHex(other))).toBe(other);
    expect(bitsToHex(a)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives advice for each problem, and nothing for a good photo", () => {
    const hash = dHash(tiny((x) => x * 20));
    const good = photoIssues({ width: 2400, height: 1800, grey: sharp(), hash, otherHashes: [] });
    expect(good).toEqual([]);
    const bad = photoIssues({ width: 1200, height: 900, grey: blurred(sharp(20, 60)), hash, otherHashes: [hash] });
    expect(bad.map((i) => i.code)).toEqual(["small", "dark", "blur", "duplicate"]);
    expect(bad.find((i) => i.code === "dark")!.advice).toMatch(/daylight/);
    expect(photoIssues({ width: 2400, height: 1800, grey: sharp(225, 255), hash, otherHashes: [] }).map((i) => i.code)).toEqual(["bright"]);
  });
});
