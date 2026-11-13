// The photo editor's light and detail adjustments (web/src/listing/editor.tsx): pure arithmetic on RGBA pixels,
// tested in test/editor-pixels.test.ts. The same maths runs on the live preview and on the saved photo, so what
// you see is what's saved. Each adjustment applies to the whole photo alike.

export interface Adjust {
  /** -100..100: a gamma curve, so black and white stay put. */
  brightness: number;
  /** -100..100: about mid-grey. */
  contrast: number;
  /** -100..100: cooler (blue) to warmer (amber). */
  warmth: number;
  /** 0..100: an unsharp mask. */
  sharpness: number;
}
export type AdjustKey = keyof Adjust;

export const NO_ADJUST: Adjust = { brightness: 0, contrast: 0, warmth: 0, sharpness: 0 };
export const ADJUST_RANGE: Record<AdjustKey, [number, number]> = { brightness: [-100, 100], contrast: [-100, 100], warmth: [-100, 100], sharpness: [0, 100] };

export const isNeutral = (a: Adjust) => a.brightness === 0 && a.contrast === 0 && a.warmth === 0 && a.sharpness === 0;

/** The edit names an adjustment records (src/drafts.ts, ALLOWED_EDITS). */
export function adjustEdits(a: Adjust): string[] {
  return [...(a.brightness ? ["exposure"] : []), ...(a.contrast ? ["contrast"] : []), ...(a.warmth ? ["white_balance"] : []), ...(a.sharpness ? ["sharpen"] : [])];
}

/** One lookup table per channel: brightness, then contrast, then warmth. */
export function luts(a: Adjust): [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] {
  const gamma = Math.pow(2, (-a.brightness / 100) * 1.2);
  const f = 1 + (a.contrast / 100) * (a.contrast < 0 ? 0.6 : 0.8);
  const gains = [1 + (a.warmth / 100) * 0.12, 1 + (a.warmth / 100) * 0.02, 1 - (a.warmth / 100) * 0.12];
  const out = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)] as [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray];
  for (let v = 0; v < 256; v++) {
    const b = 255 * Math.pow(v / 255, gamma);
    const c = (b - 128) * f + 128;
    for (let ch = 0; ch < 3; ch++) out[ch][v] = c * gains[ch];
  }
  return out;
}

/**
 * Applies an adjustment to RGBA pixels in place. `scale` is the preview's size relative to the saved photo, so the
 * sharpening looks the same on both (a smaller preview gets a gentler mask).
 */
export function applyAdjust(data: Uint8ClampedArray, w: number, h: number, a: Adjust, scale = 1): void {
  if (a.brightness || a.contrast || a.warmth) {
    const [r, g, b] = luts(a);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r[data[i]];
      data[i + 1] = g[data[i + 1]];
      data[i + 2] = b[data[i + 2]];
    }
  }
  if (a.sharpness > 0 && w > 2 && h > 2) sharpen(data, w, h, (a.sharpness / 100) * 1.5 * Math.min(1, Math.max(0.35, scale)));
}

/** Unsharp mask with a 3×3 box blur: each pixel moves away from its neighbourhood's average by `amount`. */
export function sharpen(data: Uint8ClampedArray, w: number, h: number, amount: number): void {
  const src = new Uint8ClampedArray(data);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const j = i + c;
        const sum =
          src[j - row - 4] + src[j - row] + src[j - row + 4] +
          src[j - 4] + src[j] + src[j + 4] +
          src[j + row - 4] + src[j + row] + src[j + row + 4];
        const v = src[j];
        data[j] = v + amount * (v - sum / 9);
      }
    }
}

const r0 = (v: number) => Math.round(v);
const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * "Auto": values from the photo's own histogram. The median brightness is brought towards mid-grey (gamma), a
 * narrow spread between the darkest and brightest 2% gets more contrast, the brightest pixels (usually the plain
 * background) are made neutral (warmth), and a little sharpening.
 */
export function autoAdjust(data: ArrayLike<number>, w: number, h: number): Adjust {
  const n = w * h;
  if (!n) return { ...NO_ADJUST };
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(n / 200_000));
  let count = 0;
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    hist[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
    count++;
  }
  const pct = (q: number) => {
    let s = 0;
    for (let v = 0; v < 256; v++) if ((s += hist[v]) >= q * count) return v / 255;
    return 1;
  };
  const median = Math.max(0.02, Math.min(0.98, pct(0.5)));
  // Only ever brightens: a product on a light background has a bright median (the background), and darkening
  // it would grey the background buyers expect to be white. A dark photo is lifted towards a little above mid-grey.
  const target = 0.55;
  const gamma = Math.log(target) / Math.log(median);
  const brightness = median < target ? clampTo(r0((-Math.log2(gamma) / 1.2) * 100), 0, 60) : 0;
  const spread = Math.max(0.05, pct(0.98) - pct(0.02));
  const contrast = spread < 0.7 ? clampTo(r0(((0.8 / spread - 1) / 0.8) * 100), 0, 30) : 0;

  // Grey-world on the brightest tenth of the photo.
  const bright = pct(0.9) * 255;
  let rs = 0;
  let bs = 0;
  let k = 0;
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= bright) {
      rs += data[i];
      bs += data[i + 2];
      k++;
    }
  }
  let warmth = 0;
  if (k && rs + bs > 0) {
    // r(1+x) = b(1-x) at x = (b-r)/(b+r); warmth is x / 0.12 on the -100..100 scale.
    warmth = clampTo(r0(((bs - rs) / (bs + rs) / 0.12) * 100), -40, 40);
    if (Math.abs(warmth) < 3) warmth = 0;
  }
  return { brightness: Math.abs(brightness) < 3 ? 0 : brightness, contrast, warmth, sharpness: 20 };
}
