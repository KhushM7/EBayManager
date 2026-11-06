import { describe, expect, it } from "vitest";
import { tidy, type Rgba } from "../web/src/listing/tidy";

// Background tidy-up (docs/add-listing.md, decision 4): ordinary edits only, never touching the item locally.

/** A w×h photo: a background colour with an item (a rectangle of another colour, with a "scratch") in the middle. */
function photo(w: number, h: number, bg: [number, number, number], item: [number, number, number], itemFrac = 0.4): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  const ix0 = Math.round(w * (0.5 - itemFrac / 2));
  const ix1 = Math.round(w * (0.5 + itemFrac / 2));
  const iy0 = Math.round(h * (0.5 - itemFrac / 2));
  const iy1 = Math.round(h * (0.5 + itemFrac / 2));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inItem = x >= ix0 && x < ix1 && y >= iy0 && y < iy1;
      const scratch = inItem && y === Math.round(h / 2) && x > ix0 + 5 && x < ix0 + 40;
      const c = scratch ? [240, 240, 240] : inItem ? item : bg;
      data.set([c[0], c[1], c[2], 255], i);
    }
  return { data, w, h };
}
const px = (img: Rgba, x: number, y: number) => [...img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 3)];

describe("background tidy-up", () => {
  it("whitens a plain greyish background, balances and brightens the whole photo, and crops to the item", () => {
    const img = photo(1600, 1200, [196, 200, 208], [40, 60, 120], 0.65);
    const r = tidy(img);
    if ("refused" in r) throw new Error(r.refused);
    expect(r.edits).toEqual(["white_balance", "exposure", "background", "crop"]);
    expect(px(r.image, 2, 2)).toEqual([255, 255, 255]);
    // The item is changed only by the same global multipliers as everything else: still dark blue, not white.
    const c = px(r.image, Math.round(r.image.w / 2), Math.round(r.image.h / 2) + 20);
    expect(c[2]).toBeGreaterThan(c[0]);
    expect(Math.max(...c)).toBeLessThan(200);
    expect(r.image.w).toBeLessThan(img.w);
  });

  it("keeps the item's flaws: a pale scratch inside the item isn't whitened (it isn't connected to the edge)", () => {
    const img = photo(1600, 1200, [235, 235, 235], [40, 40, 40]);
    const r = tidy(img);
    if ("refused" in r) throw new Error(r.refused);
    // Find the scratch row in the cropped photo: it stays 240-ish grey (exposure only), and the item around it stays dark.
    const row = Math.round(r.image.h / 2);
    const values = Array.from({ length: r.image.w }, (_, x) => px(r.image, x, row)[0]);
    expect(values.some((v) => v < 100)).toBe(true);
  });

  it("refuses a dark or cluttered background, and an item the same colour as the background", () => {
    expect(tidy(photo(800, 600, [60, 60, 60], [200, 200, 200]))).toEqual({ refused: expect.stringMatching(/isn't plain and light/) });
    expect(tidy(photo(800, 600, [230, 180, 120], [20, 20, 20]))).toEqual({ refused: expect.stringMatching(/isn't plain and light/) });
    expect(tidy(photo(800, 600, [230, 230, 230], [232, 230, 229]))).toEqual({ refused: expect.stringMatching(/too close in colour|reach into the middle/) });
  });

  it("refuses when the item fills the photo, leaving almost no background", () => {
    expect(tidy(photo(800, 600, [230, 230, 230], [30, 30, 30], 0.98))).toEqual({ refused: expect.stringMatching(/too little plain background/) });
  });
});
