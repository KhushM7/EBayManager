import { describe, expect, it } from "vitest";
import { centreRect, clampRect, coverScale, fitRatio, lockRatio, minLong, moveRect, outputFor, resizeRect, snapRect, turnRect, zoomRect, type Rect } from "../web/src/listing/geometry";

// The photo editor's crop and straighten (web/src/listing/geometry.ts).

const W = 2000;
const H = 1500;
const inside = (r: Rect) => r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6;
const full: Rect = { x: 0, y: 0, w: W, h: H };

describe("free crop", () => {
  it("drags an edge or corner with the opposite side staying put", () => {
    const r = resizeRect(full, "e", -400, 0, W, H, null);
    expect(r).toEqual({ x: 0, y: 0, w: 1600, h: 1500 });
    const c = resizeRect(full, "nw", 300, 200, W, H, null);
    expect(c).toEqual({ x: 300, y: 200, w: 1700, h: 1300 });
    // Non-uniform: only width changes on a side handle.
    expect(resizeRect({ x: 100, y: 100, w: 800, h: 600 }, "w", -50, 999, W, H, null)).toEqual({ x: 50, y: 100, w: 850, h: 600 });
  });

  it("never leaves the photo, nor goes under eBay's 500px long side", () => {
    const out = resizeRect(full, "se", 5000, 5000, W, H, null);
    expect(out).toEqual(full);
    const tiny = resizeRect({ x: 0, y: 0, w: 600, h: 600 }, "se", -580, -580, W, H, null);
    expect(Math.max(tiny.w, tiny.h)).toBeGreaterThanOrEqual(minLong(W, H) - 1e-6);
    expect(inside(tiny)).toBe(true);
  });

  it("moves inside the photo", () => {
    expect(moveRect({ x: 100, y: 100, w: 500, h: 500 }, -900, 9000, W, H)).toEqual({ x: 0, y: 1000, w: 500, h: 500 });
  });
});

describe("locked ratios", () => {
  it("keeps the shape from a corner, anchored at the opposite corner", () => {
    const r = resizeRect({ x: 200, y: 200, w: 1000, h: 1000 }, "se", -300, -100, W, H, 1);
    expect(r.w / r.h).toBeCloseTo(1);
    expect(r.x).toBe(200);
    expect(r.y).toBe(200);
    expect(r.w).toBeCloseTo(900); // the bigger of the two movements wins
  });

  it("keeps the shape from an edge, growing about the middle, inside the photo", () => {
    const r = resizeRect({ x: 500, y: 300, w: 800, h: 600 }, "e", 2000, 0, W, H, 4 / 3);
    expect(r.w / r.h).toBeCloseTo(4 / 3);
    expect(inside(r)).toBe(true);
    expect(r.x).toBe(500);
  });

  it("4:3 and 16:9 follow the orientation asked for", () => {
    expect(lockRatio("4:3", W, H, false)).toBeCloseTo(4 / 3);
    expect(lockRatio("4:3", W, H, true)).toBeCloseTo(3 / 4);
    expect(lockRatio("original", W, H, true)).toBeCloseTo(W / H);
    expect(lockRatio("free", W, H, false)).toBeNull();
  });

  it("fits the largest crop of a ratio inside the photo", () => {
    expect(fitRatio(full, 1, W, H)).toEqual({ x: 250, y: 0, w: 1500, h: 1500 });
    const wide = fitRatio(full, 16 / 9, W, H);
    expect(wide.w).toBe(W);
    expect(inside(wide)).toBe(true);
  });
});

describe("zoom, snap and turns", () => {
  it("zooms about the middle and stops at eBay's minimum and the photo's edges", () => {
    const r = zoomRect({ x: 500, y: 500, w: 1000, h: 750 }, 2, W, H);
    expect(r).toEqual({ x: 750, y: 687.5, w: 500, h: 375 });
    expect(Math.max(zoomRect(r, 100, W, H).w, 1)).toBeCloseTo(500);
    expect(zoomRect(r, 0.01, W, H)).toEqual(full);
  });

  it("snaps a free crop that's nearly square or 4:3, and leaves others alone", () => {
    const s = snapRect({ x: 100, y: 100, w: 1000, h: 980 }, W, H)!;
    expect(s.ratio).toBe(1);
    expect(s.rect.w).toBeCloseTo(s.rect.h);
    expect(snapRect({ x: 0, y: 0, w: 1000, h: 760 }, W, H)!.ratio).toBeCloseTo(4 / 3);
    expect(snapRect({ x: 0, y: 0, w: 1000, h: 500 }, W, H)).toBeNull();
    expect(snapRect({ x: 0, y: 0, w: 1000, h: 1000 }, W, H)).toBeNull(); // already exact
  });

  it("turns the crop with the photo, and back again", () => {
    const r: Rect = { x: 100, y: 200, w: 300, h: 400 };
    const t = turnRect(r, W, H, 1);
    expect(t).toEqual({ x: H - 600, y: 100, w: 400, h: 300 });
    expect(turnRect(t, H, W, -1)).toEqual(r);
  });

  it("scales a straightened photo just enough to cover the frame", () => {
    expect(coverScale(0, W, H)).toBe(1);
    const s = coverScale(10, W, H);
    const a = (10 * Math.PI) / 180;
    // The frame's corners, turned back, land inside the scaled photo.
    expect(W * Math.cos(a) + H * Math.sin(a)).toBeLessThanOrEqual(s * W + 1e-6);
    expect(W * Math.sin(a) + H * Math.cos(a)).toBeLessThanOrEqual(s * H + 1e-6);
    expect(coverScale(-10, W, H)).toBeCloseTo(s);
  });

  it("saves at the crop's own pixels, capped at 2400", () => {
    expect(outputFor({ x: 0, y: 0, w: 1136, h: 1136 })).toEqual({ w: 1136, h: 1136 });
    expect(outputFor({ x: 0, y: 0, w: 4000, h: 3000 })).toEqual({ w: 2400, h: 1800 });
  });

  it("centres on the item at the chosen shape", () => {
    const r = centreRect(W, H, 1, { x: 0.3, y: 0.5 }, { x: 0.2, y: 0.35, w: 0.2, h: 0.3 });
    expect(r.w).toBeCloseTo(r.h);
    expect(inside(r)).toBe(true);
    expect(clampRect(r, W, H)).toEqual(r);
  });
});
