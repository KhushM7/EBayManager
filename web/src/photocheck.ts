// Grades a real photo in the browser, against the photo rules in docs/listing-assistant.md: light, glare,
// even lighting, focus, framing, a plain background and size. Nothing is generated or altered: the photo is
// only measured (on a 320px copy), and each finding says exactly what to retake and why.

export type Tone = "good" | "warn" | "bad";
export interface Finding {
  code: string;
  tone: Tone;
  text: string;
}
export interface PhotoGrade {
  width: number;
  height: number;
  brightness: number; // mean luma, 0-1
  contrast: number; // luma standard deviation, 0-1
  sharpness: number; // variance of the Laplacian on the 320px copy
  glare: number; // share of blown-out pixels
  coverage: number; // share of the frame the item's edges span
  offset: number; // distance of the item's centre from the frame's centre, 0-1
  clutter: number; // edge density at the border relative to the middle
  score: number; // 0-100
  findings: Finding[];
  /** The item's estimated bounding box, as fractions of the frame, for the overlay. */
  box: { x: number; y: number; w: number; h: number };
}

const SIZE = 320;

async function pixels(file: Blob): Promise<{ data: Uint8ClampedArray; w: number; h: number; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const scale = SIZE / Math.max(bmp.width, bmp.height);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0, w, h);
  const out = { data: ctx.getImageData(0, 0, w, h).data, w, h, width: bmp.width, height: bmp.height };
  bmp.close();
  return out;
}

export async function gradePhoto(file: Blob): Promise<PhotoGrade> {
  const { data, w, h, width, height } = await pixels(file);
  const n = w * h;
  const luma = new Float32Array(n);
  let sum = 0;
  let blown = 0;
  for (let i = 0; i < n; i++) {
    const y = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    luma[i] = y;
    sum += y;
    if (y > 250) blown++;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (luma[i] - mean) ** 2;
  const contrast = Math.sqrt(varSum / n) / 255;

  // Laplacian (focus) and gradient magnitude (where the item's edges are)
  const grad = new Float32Array(n);
  let lapSum = 0;
  let lapSq = 0;
  let lapN = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = luma[i - 1] + luma[i + 1] + luma[i - w] + luma[i + w] - 4 * luma[i];
      lapSum += lap;
      lapSq += lap * lap;
      lapN++;
      const gx = luma[i + 1] - luma[i - 1];
      const gy = luma[i + w] - luma[i - w];
      grad[i] = Math.hypot(gx, gy);
    }
  const sharpness = lapSq / lapN - (lapSum / lapN) ** 2;

  // Strong edges: the top 12% of gradient magnitudes
  const sorted = Array.from(grad).sort((a, b) => a - b);
  const cut = Math.max(12, sorted[Math.floor(sorted.length * 0.88)]);
  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0,
    cx = 0,
    cy = 0,
    wsum = 0,
    border = 0,
    borderN = 0,
    middle = 0,
    middleN = 0;
  const bx = Math.round(w * 0.12);
  const by = Math.round(h * 0.12);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const g = grad[y * w + x];
      const strong = g >= cut;
      const isBorder = x < bx || x >= w - bx || y < by || y >= h - by;
      if (isBorder) (border += strong ? 1 : 0), borderN++;
      else (middle += strong ? 1 : 0), middleN++;
      if (!strong) continue;
      cx += x * g;
      cy += y * g;
      wsum += g;
      // The box ignores the border band, where a busy background would stretch it.
      if (!isBorder) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  const box = maxX > minX ? { x: minX / w, y: minY / h, w: (maxX - minX) / w, h: (maxY - minY) / h } : { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const coverage = box.w * box.h;
  const offset = wsum ? Math.hypot(cx / wsum / w - 0.5, cy / wsum / h - 0.5) / 0.7071 : 0;
  const clutter = middleN && borderN ? border / borderN / Math.max(1e-6, middle / middleN) : 0;

  // Even light: the four corners against the middle
  const region = (x0: number, y0: number, x1: number, y1: number) => {
    let s = 0,
      c = 0;
    for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++)
      for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) (s += luma[y * w + x]), c++;
    return c ? s / c : 0;
  };
  const centre = region(0.35, 0.35, 0.65, 0.65);
  const corners = [region(0, 0, 0.2, 0.2), region(0.8, 0, 1, 0.2), region(0, 0.8, 0.2, 1), region(0.8, 0.8, 1, 1)];
  const darkCorner = Math.min(...corners) / Math.max(1, centre);

  const brightness = mean / 255;
  const glare = blown / n;
  const long = Math.max(width, height);
  const ratio = Math.max(width, height) / Math.min(width, height);
  const findings: Finding[] = [];
  const add = (code: string, tone: Tone, text: string) => findings.push({ code, tone, text });

  if (brightness < 0.28) add("dark", "bad", "Lighting is too dark. Move next to a window or add a lamp either side.");
  else if (brightness < 0.38) add("dim", "warn", "Lighting is a bit dark. A little more daylight will show the true colours.");
  if (brightness > 0.86 && glare > 0.15) add("bright", "warn", "The photo is washed out. Step back from direct light.");
  else if (glare > 0.08) add("glare", "warn", "There's glare. Turn the flash off and angle the item away from the light.");
  if (darkCorner < 0.55 && brightness >= 0.28) add("uneven", "warn", "Uneven light: the corners are much darker than the middle.");
  if (sharpness < 40) add("blur", "bad", "It's blurry. Hold still, tap the item to focus and retake.");
  else if (sharpness < 90) add("soft", "warn", "Focus is a little soft. Tap the item to focus before you shoot.");
  if (contrast < 0.07) add("flat", "warn", "Very low contrast: the item may be blending into the background.");
  if (coverage < 0.18) add("small", "warn", "The item is small in the frame. Move closer so it fills most of the photo.");
  if (offset > 0.22) add("offcentre", "warn", "The item is off-centre. Line it up with the middle of the grid.");
  if (clutter > 0.85) add("busy", "warn", "Busy background. A plain white or light grey sheet makes the item stand out.");
  if (long < 500) add("tiny", "bad", `Only ${long}px on the long side: eBay needs at least 500px, and 1600px looks best.`);
  else if (long < 1600) add("lowres", "warn", `${long}px on the long side. 1600px or more lets buyers zoom in.`);
  if (ratio > 1.4) add("crop", "warn", "Very wide or tall. Square or 4:3 photos fit eBay's gallery best.");

  const penalty = findings.reduce((s, f) => s + (f.tone === "bad" ? 30 : 12), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  if (!findings.length) add("ok", "good", "Great shot: well lit, sharp and well framed.");
  return { width, height, brightness, contrast, sharpness, glare, coverage, offset, clutter, score, findings, box };
}

export const gradeWord = (score: number) => (score >= 85 ? "Great" : score >= 65 ? "Good" : score >= 40 ? "Retake suggested" : "Retake");
