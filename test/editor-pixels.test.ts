import { describe, expect, it } from "vitest";
import { adjustEdits, applyAdjust, autoAdjust, luts, NO_ADJUST } from "../web/src/listing/pixels";

// The photo editor's light and detail adjustments (web/src/listing/pixels.ts).

const solid = (w: number, h: number, rgb: [number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) d.set([...rgb, 255], i);
  return d;
};

describe("adjustments", () => {
  it("changes nothing at zero", () => {
    const d = solid(4, 4, [10, 120, 240]);
    const before = new Uint8ClampedArray(d);
    applyAdjust(d, 4, 4, NO_ADJUST);
    expect(d).toEqual(before);
  });

  it("brightness lifts the mid-tones but keeps black and white", () => {
    const [r] = luts({ ...NO_ADJUST, brightness: 50 });
    expect(r[0]).toBe(0);
    expect(r[255]).toBe(255);
    expect(r[128]).toBeGreaterThan(150);
    expect(luts({ ...NO_ADJUST, brightness: -50 })[0][128]).toBeLessThan(110);
  });

  it("contrast spreads tones about mid-grey; warmth moves red against blue", () => {
    const [c] = luts({ ...NO_ADJUST, contrast: 50 });
    expect(c[128]).toBe(128);
    expect(c[200]).toBeGreaterThan(200);
    expect(c[50]).toBeLessThan(50);
    const [wr, , wb] = luts({ ...NO_ADJUST, warmth: 50 });
    expect(wr[200]).toBeGreaterThan(200);
    expect(wb[200]).toBeLessThan(200);
  });

  it("sharpening raises an edge's contrast and leaves flat areas alone", () => {
    const w = 8;
    const h = 3;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(x < 4 ? [100, 100, 100, 255] : [160, 160, 160, 255], (y * w + x) * 4);
    applyAdjust(d, w, h, { ...NO_ADJUST, sharpness: 100 });
    const at = (x: number) => d[(1 * w + x) * 4];
    expect(at(1)).toBe(100); // flat
    expect(at(3)).toBeLessThan(100); // dark side of the edge gets darker
    expect(at(4)).toBeGreaterThan(160); // light side lighter
  });

  it("records the edit names the server accepts", () => {
    expect(adjustEdits({ brightness: 5, contrast: 0, warmth: -3, sharpness: 10 })).toEqual(["exposure", "white_balance", "sharpen"]);
    expect(adjustEdits(NO_ADJUST)).toEqual([]);
  });
});

describe("auto-enhance", () => {
  it("brightens a dark, flat photo and adds contrast", () => {
    const w = 40;
    const h = 40;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const v = 50 + (p % 40); // 50..89: dark and narrow
      d.set([v, v, v, 255], p * 4);
    }
    const a = autoAdjust(d, w, h);
    expect(a.brightness).toBeGreaterThan(20);
    expect(a.contrast).toBeGreaterThan(0);
    expect(a.warmth).toBe(0);
  });

  it("never darkens a product on a light background", () => {
    const w = 40;
    const h = 40;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const item = p % w > 12 && p % w < 26 && Math.floor(p / w) > 12 && Math.floor(p / w) < 26;
      d.set(item ? [40, 30, 25, 255] : [215, 212, 205, 255], p * 4);
    }
    const a = autoAdjust(d, w, h);
    expect(a.brightness).toBe(0);
    expect(a.contrast).toBe(0);
  });

  it("warms a photo whose bright background looks blue", () => {
    const d = solid(20, 20, [200, 210, 240]);
    expect(autoAdjust(d, 20, 20).warmth).toBeGreaterThan(0);
  });
});

describe("tidy options (the editor's on-device tidy)", () => {
  it("can whiten the background without changing the light or cropping", async () => {
    const { tidy } = await import("../web/src/listing/tidy");
    const w = 200;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data.set(x > 60 && x < 140 && y > 60 && y < 140 ? [40, 60, 90, 255] : [205, 200, 195, 255], (y * w + x) * 4);
    const r = tidy({ data, w, h }, { balance: false, crop: false });
    if ("refused" in r) throw new Error(r.refused);
    expect(r.edits).toEqual(["background"]);
    expect([r.image.w, r.image.h]).toEqual([w, h]);
    expect(r.image.data[(100 * w + 100) * 4]).toBe(40); // the item is untouched
    expect(r.image.data[0]).toBe(255); // the background is white
  });
});
