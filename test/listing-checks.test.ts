import { describe, expect, it } from "vitest";
import { bitsToHex, dHash, hamming, hexToBits, sameShot, type Grey } from "../web/src/listing/checks";
import { BLUR_BAD, gradePixels } from "../web/src/photocheck";

// The phone's instant photo checks (docs/add-listing.md, step 1; the app's one set, web/src/photocheck.ts), on
// synthetic images, so the thresholds are checked without a browser or a real photo.

const W = 320;
const H = 240;
type Px = (x: number, y: number) => number;
/** An RGBA copy where every pixel is grey at f(x, y). */
const rgba = (f: Px) => {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = f(x, y);
      d.set([v, v, v, 255], (y * W + x) * 4);
    }
  return d;
};
/** A detailed item (8 px checks of lo and hi) in the middle half of a plain light background. */
const item =
  (lo = 60, hi = 200, bg = 215, box = { x0: 80, x1: 240, y0: 60, y1: 180 }): Px =>
  (x, y) =>
    x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1 ? ((x >> 3) + (y >> 3)) % 2 ? hi : lo : bg;
/** The same, heavily smoothed: what a shaky or out-of-focus shot looks like. */
function blurred(f: Px, r = 6): Px {
  const src = rgba(f);
  return (x, y) => {
    let s = 0;
    let n = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx));
        const yy = Math.min(H - 1, Math.max(0, y + dy));
        s += src[(yy * W + xx) * 4];
        n++;
      }
    return s / n;
  };
}
const grade = (f: Px, size = { width: 2400, height: 1800 }, duplicate = false) => gradePixels(rgba(f), W, H, size.width, size.height, { duplicate });
const codes = (f: Px, size?: { width: number; height: number }, duplicate?: boolean) => grade(f, size, duplicate).findings.map((x) => x.code);
const tiny = (f: (x: number, y: number) => number): Grey => ({ w: 9, h: 8, px: Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9))) });

describe("photo checks", () => {
  it("passes a sharp, well-lit, centred item on a plain background", () => {
    const g = grade(item());
    expect(g.findings.map((x) => x.code)).toEqual(["ok"]);
    expect(g.score).toBe(100);
    expect(g.box.x).toBeCloseTo(0.25, 1);
    expect(g.box.w).toBeCloseTo(0.5, 1);
  });

  it("flags a dark photo, with advice", () => {
    const g = grade(item(10, 60, 50));
    expect(g.findings[0]).toMatchObject({ code: "dark", tone: "bad" });
    expect(g.findings[0].text).toMatch(/window|lamp/);
  });

  it("tells sharp from blurry", () => {
    expect(grade(item()).sharpness).toBeGreaterThan(BLUR_BAD * 10);
    expect(codes(blurred(item()))).toContain("blur");
  });

  it("flags a small or off-centre item, and a busy background", () => {
    expect(codes(item(60, 200, 215, { x0: 140, x1: 180, y0: 100, y1: 140 }))).toContain("small");
    expect(codes(item(60, 200, 215, { x0: 200, x1: 300, y0: 140, y1: 230 }))).toContain("offcentre");
    const busy: Px = (x, y) => (x < 40 || x >= 280 || y < 30 || y >= 210 ? (((x >> 2) + (y >> 2)) % 2 ? 30 : 240) : item()(x, y));
    expect(codes(busy)).toContain("busy");
  });

  it("checks the size eBay needs, and the shape of the photo", () => {
    expect(codes(item(), { width: 400, height: 300 })).toContain("tiny");
    expect(codes(item(), { width: 1200, height: 900 })).toContain("lowres");
    expect(codes(item(), { width: 3000, height: 1000 })).toContain("crop");
  });

  it("marks the same shot twice as one to retake", () => {
    expect(grade(item(), undefined, true).findings).toEqual([expect.objectContaining({ code: "duplicate", tone: "bad" })]);
  });

  it("spots the same shot twice by its fingerprint, but not a different one", () => {
    const a = dHash(tiny((x, y) => x * 20 + y));
    const same = dHash(tiny((x, y) => x * 20 + y + 3));
    const other = dHash(tiny((x, y) => (x % 2 ? 200 : 10) + y));
    expect(hamming(a, same)).toBe(0);
    expect(hamming(a, other)).toBeGreaterThan(5);
    expect(sameShot(same, [other, a])).toBe(true);
    expect(sameShot(other, [a])).toBe(false);
    expect(hexToBits(bitsToHex(other))).toBe(other);
    expect(bitsToHex(a)).toMatch(/^[0-9a-f]{16}$/);
  });
});
