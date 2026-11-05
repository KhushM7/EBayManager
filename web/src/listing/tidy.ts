// Background tidy-up for listing photos (docs/add-listing.md, decision 4): ordinary edits only, the kind anyone
// could make in a basic photo editor, and nothing generative. Done on the phone with plain arithmetic on the
// pixels; the original is kept and K chooses per photo.
//
// - White balance and exposure: one multiplier per colour channel, applied to the whole photo alike, so the
//   plain background reads as neutral and bright. Nothing on the item is changed locally.
// - Background to white: a "magic wand" from the edges, selecting only pixels close in colour to the plain
//   background and connected to the edge, so it stops at the item's outline. Pixels just outside the selection
//   are blended halfway for a soft edge.
// - Crop: to the item with a margin, if that leaves a large enough photo.
//
// It refuses (and changes nothing) when the background isn't plain and light, when the selection would cover
// almost the whole photo or reach into its middle (where the item is), or when there's too little background.
// Flaws, marks and colours on the item are never touched.

export interface Rgba {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface TidyResult {
  image: Rgba;
  edits: ("white_balance" | "exposure" | "background" | "crop")[];
}

export interface TidyRefusal {
  refused: string;
}

/** Colour distance from the background that still counts as background (0 to 441). */
export const TOLERANCE = 26;
/** Smallest long side a crop may leave. */
export const MIN_CROP_SIDE = 1200;

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/** The background colour: the median of a thin band around the edge. */
export function edgeColour(img: Rgba): [number, number, number] {
  const { data, w, h } = img;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    r.push(data[i]);
    g.push(data[i + 1]);
    b.push(data[i + 2]);
  };
  const step = Math.max(1, Math.round(Math.max(w, h) / 400));
  for (let x = 0; x < w; x += step) for (let y = 0; y < band; y++) (take(x, y), take(x, h - 1 - y));
  for (let y = 0; y < h; y += step) for (let x = 0; x < band; x++) (take(x, y), take(w - 1 - x, y));
  return [median(r), median(g), median(b)];
}

export function tidy(input: Rgba): TidyResult | TidyRefusal {
  const { w, h } = input;
  const data = new Uint8ClampedArray(input.data);
  const bg = edgeColour({ data, w, h });
  const bgLum = lum(...bg);
  if (bgLum < 120 || Math.max(...bg) - Math.min(...bg) > 50)
    return { refused: "The background isn't plain and light enough to tidy safely. A white or light grey sheet works best." };

  // How plain is the edge? Too varied means a cluttered background: leave it alone.
  const edits: TidyResult["edits"] = [];

  // White balance and exposure: one multiplier per channel for the whole photo.
  const grey = (bg[0] + bg[1] + bg[2]) / 3;
  const wb = bg.map((c) => (c > 0 ? grey / c : 1));
  const exposure = bgLum < 238 ? Math.min(1.3, 245 / Math.max(1, grey)) : 1;
  const gains = wb.map((g) => g * exposure);
  if (wb.some((g) => Math.abs(g - 1) > 0.03)) edits.push("white_balance");
  if (exposure > 1.02) edits.push("exposure");
  if (edits.length) for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = data[i + c] * gains[c];
  const bg2 = bg.map((c, i) => Math.min(255, c * gains[i]));

  // The selection: background-coloured pixels connected to the edge (4-neighbour flood fill).
  const n = w * h;
  const mask = new Uint8Array(n);
  const near = (p: number, tol: number) => {
    const i = p * 4;
    const dr = data[i] - bg2[0];
    const dg = data[i + 1] - bg2[1];
    const db = data[i + 2] - bg2[2];
    return dr * dr + dg * dg + db * db <= tol * tol;
  };
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seed = (p: number) => {
    if (!mask[p] && near(p, TOLERANCE)) {
      mask[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < w; x++) (seed(x), seed((h - 1) * w + x));
  for (let y = 0; y < h; y++) (seed(y * w), seed(y * w + w - 1));
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < n - w) seed(p + w);
  }

  const filled = tail / n;
  if (filled < 0.05) return { refused: "There's too little plain background around the item to tidy." };
  if (filled > 0.92) return { refused: "The item is too close in colour to the background: tidying could change the item, so it's left as it is." };
  // The middle of the photo is where the item is: the selection mustn't reach into it.
  let mid = 0;
  let midN = 0;
  for (let y = Math.floor(h * 0.4); y < Math.ceil(h * 0.6); y++)
    for (let x = Math.floor(w * 0.4); x < Math.ceil(w * 0.6); x++) {
      midN++;
      mid += mask[y * w + x];
    }
  if (mid / midN > 0.3) return { refused: "The selection would reach into the middle of the photo, where the item is, so it's left as it is." };

  // Background to white, with a soft edge just outside the selection.
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (mask[p]) {
      data[i] = data[i + 1] = data[i + 2] = 255;
    } else {
      const x = p % w;
      const edge = (x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || (p >= w && mask[p - w]) || (p < n - w && mask[p + w]);
      if (edge && near(p, TOLERANCE * 1.6)) for (let c = 0; c < 3; c++) data[i + c] = (data[i + c] + 255) / 2;
    }
  }
  edits.push("background");

  // Crop to the item (everything not selected) with a margin, if that leaves a big enough photo.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!mask[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const margin = Math.round(Math.max(w, h) * 0.06);
  const cx0 = Math.max(0, x0 - margin);
  const cy0 = Math.max(0, y0 - margin);
  const cx1 = Math.min(w - 1, x1 + margin);
  const cy1 = Math.min(h - 1, y1 + margin);
  const cw = cx1 - cx0 + 1;
  const ch = cy1 - cy0 + 1;
  if (x1 >= 0 && cw * ch < w * h * 0.85 && Math.max(cw, ch) >= Math.min(MIN_CROP_SIDE, Math.max(w, h))) {
    const out = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) out.set(data.subarray(((cy0 + y) * w + cx0) * 4, ((cy0 + y) * w + cx0 + cw) * 4), y * cw * 4);
    edits.push("crop");
    return { image: { data: out, w: cw, h: ch }, edits };
  }
  return { image: { data, w, h }, edits };
}
