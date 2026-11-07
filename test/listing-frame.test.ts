import { describe, expect, it } from "vitest";
import { baseSize, centreOn, clampFrame, cropRect, initialFrame, maxZoom, outputSize, turnBox, turnPoint } from "../web/src/listing/frame";
import { closestSlot, moveItem, slotFor } from "../web/src/listing/order";

// The Adjust tool's crop (web/src/listing/frame.ts) and the Arrange view's reorder (arrange.tsx).

const W = 1600;
const H = 1200;
const inside = (r: { x: number; y: number; w: number; h: number }) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= W + 1e-9 && r.y + r.h <= H + 1e-9;

describe("photo frame", () => {
  it("fits the largest frame of each shape inside the photo", () => {
    expect(baseSize(W, H, 1)).toEqual({ w: 1200, h: 1200 });
    expect(baseSize(W, H, 4 / 3)).toEqual({ w: 1600, h: 1200 });
    expect(baseSize(1200, 1600, 4 / 3)).toEqual({ w: 1200, h: 900 });
    expect(cropRect(W, H, initialFrame(W, H, 1))).toEqual({ x: 200, y: 0, w: 1200, h: 1200 });
  });

  it("never lets the frame leave the photo or zoom past eBay's 500px minimum", () => {
    const f = clampFrame(W, H, { aspect: 1, zoom: 50, cx: -500, cy: 99999 });
    expect(f.zoom).toBeCloseTo(maxZoom(W, H, 1));
    const r = cropRect(W, H, f);
    expect(inside(r)).toBe(true);
    expect(Math.max(r.w, r.h)).toBeGreaterThanOrEqual(500 - 1e-6);
    expect(clampFrame(W, H, { aspect: 1, zoom: 0.2, cx: 800, cy: 600 }).zoom).toBe(1);
  });

  it("zooms a small item in the middle until it fills about two thirds of the frame", () => {
    const box = { x: 0.43, y: 0.35, w: 0.14, h: 0.3 }; // 224×360 px in a 1600×1200 photo
    const r = cropRect(W, H, centreOn(W, H, 1, { x: 0.5, y: 0.5 }, box));
    expect(inside(r)).toBe(true);
    expect((box.h * H) / r.h).toBeCloseTo(0.65, 2); // its taller side fills 65%
    expect(r.x + r.w / 2).toBeCloseTo(800, 0);
  });

  it("centres an off-centre item and keeps the whole item in", () => {
    // An item in the left third: centre (0.25, 0.5), a box 20% wide and 30% tall.
    const box = { x: 0.15, y: 0.35, w: 0.2, h: 0.3 };
    const f = centreOn(W, H, 1, { x: 0.25, y: 0.5 }, box);
    const r = cropRect(W, H, f);
    expect(inside(r)).toBe(true);
    expect(r.x + r.w / 2).toBeCloseTo(0.25 * W, 0); // the item is now in the middle
    expect(r.y + r.h / 2).toBeCloseTo(0.5 * H, 0);
    // The whole item still shows.
    expect(r.x).toBeLessThanOrEqual(box.x * W);
    expect(r.x + r.w).toBeGreaterThanOrEqual((box.x + box.w) * W);
    expect(r.y).toBeLessThanOrEqual(box.y * H);
    expect(r.y + r.h).toBeGreaterThanOrEqual((box.y + box.h) * H);
  });

  it("doesn't zoom so far that a big item is cut off, even if it can't then be perfectly centred", () => {
    const box = { x: 0.05, y: 0.1, w: 0.7, h: 0.8 };
    const r = cropRect(W, H, centreOn(W, H, 1, { x: 0.4, y: 0.5 }, box));
    expect(inside(r)).toBe(true);
    expect(r.w).toBeGreaterThanOrEqual(box.h * H * 0.99); // the item's height still fits
  });

  it("keeps the crop's own pixels, capped at 2400 on the long side", () => {
    expect(outputSize({ x: 0, y: 0, w: 1200, h: 900 })).toEqual({ w: 1200, h: 900 });
    expect(outputSize({ x: 0, y: 0, w: 4000, h: 3000 })).toEqual({ w: 2400, h: 1800 });
  });
});

describe("rotating a photo", () => {
  it("follows the item round a quarter turn at a time", () => {
    // The item near the top-left corner; a clockwise turn takes the top-left to the top-right.
    const near = (p: { x: number; y: number }, x: number, y: number) => (expect(p.x).toBeCloseTo(x), expect(p.y).toBeCloseTo(y));
    near(turnPoint({ x: 0.2, y: 0.1 }, 1), 0.9, 0.2);
    near(turnPoint({ x: 0.2, y: 0.1 }, 2), 0.8, 0.9);
    near(turnPoint({ x: 0.2, y: 0.1 }, 3), 0.1, 0.8);
    near(turnPoint({ x: 0.2, y: 0.1 }, 4), 0.2, 0.1);
    near(turnPoint({ x: 0.2, y: 0.1 }, -1), 0.1, 0.8);
  });

  it("turns the item's outline with it, keeping its size", () => {
    const b = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const t = turnBox(b, 1);
    expect(t.w).toBeCloseTo(0.4);
    expect(t.h).toBeCloseTo(0.3);
    expect(t.x).toBeCloseTo(0.4); // 1 - (0.2 + 0.4)
    expect(t.y).toBeCloseTo(0.1);
    // Its centre lands where the turned centre does.
    const c = turnPoint({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, 1);
    expect(t.x + t.w / 2).toBeCloseTo(c.x);
    expect(t.y + t.h / 2).toBeCloseTo(c.y);
    const back = turnBox(turnBox(b, 1), 3);
    for (const k of ["x", "y", "w", "h"] as const) expect(back[k]).toBeCloseTo(b[k]);
  });
});

describe("arranging photos", () => {
  it("while dragging, shows the held photo in its new slot and slides the ones between towards the gap", () => {
    // Five photos; the one at 3 held over slot 1: 0 stays, 1 and 2 slide right, 4 stays.
    expect([0, 1, 2, 3, 4].map((i) => slotFor(i, 3, 1))).toEqual([0, 2, 3, 1, 4]);
    // The one at 0 held over slot 3: 1 to 3 slide left.
    expect([0, 1, 2, 3, 4].map((i) => slotFor(i, 0, 3))).toEqual([3, 0, 1, 2, 4]);
    // Every slot is used exactly once, which is what the drop then commits.
    for (const [from, over] of [[2, 4], [4, 0], [1, 1]]) {
      const shown = [0, 1, 2, 3, 4].map((i) => slotFor(i, from, over));
      expect([...shown].sort()).toEqual([0, 1, 2, 3, 4]);
      const committed = moveItem(["a", "b", "c", "d", "e"], from, over);
      shown.forEach((slot, i) => expect(committed[slot]).toBe(["a", "b", "c", "d", "e"][i]));
    }
  });

  it("picks the nearest slot by centre", () => {
    const centres = [0, 1, 2, 3].map((i) => ({ x: (i % 2) * 100 + 50, y: Math.floor(i / 2) * 100 + 50 }));
    expect(closestSlot(centres, { x: 60, y: 40 })).toBe(0);
    expect(closestSlot(centres, { x: 140, y: 170 })).toBe(3);
  });

  it("moves one photo and keeps the rest in order", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
});
