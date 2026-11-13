// The photo editor's crop and straighten (web/src/listing/editor.tsx): pure arithmetic, tested in
// test/editor-geometry.test.ts. Everything is in the pixels of the photo after its quarter turns (W × H). A crop
// is a free rectangle inside the photo; a locked ratio keeps its shape while it's resized. Straightening turns
// the photo by a small angle and scales it up just enough to cover the frame, so nothing empty ever shows.

import { centreOn, cropRect, MIN_LONG_SIDE } from "./frame";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export type AspectId = "free" | "original" | "square" | "4:3" | "16:9";

/** Smallest side a crop may have, in photo pixels (besides eBay's 500px on the long side). */
export const MIN_SIDE = 48;
/** Output is capped at this on the long side. */
export const MAX_OUTPUT = 2400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The width ÷ height an aspect choice locks to, or null for free. 4:3 and 16:9 follow the crop's orientation unless `portrait` says otherwise. */
export function lockRatio(id: AspectId, W: number, H: number, portrait: boolean): number | null {
  if (id === "free") return null;
  if (id === "original") return W / H;
  if (id === "square") return 1;
  const r = id === "4:3" ? 4 / 3 : 16 / 9;
  return portrait ? 1 / r : r;
}

/** eBay's minimum long side, unless the photo itself is smaller. */
export const minLong = (W: number, H: number) => Math.min(MIN_LONG_SIDE, Math.max(W, H));

/** The smallest crop of a ratio (or free) that keeps eBay's minimum. */
function minSize(W: number, H: number, ratio: number | null): { w: number; h: number } {
  const L = minLong(W, H);
  if (ratio == null) return { w: MIN_SIDE, h: MIN_SIDE };
  return ratio >= 1 ? { w: L, h: L / ratio } : { w: L * ratio, h: L };
}

export const fullRect = (W: number, H: number): Rect => ({ x: 0, y: 0, w: W, h: H });

/** The rect moved back inside the photo (its size kept, or shrunk if it's bigger than the photo). */
export function clampRect(r: Rect, W: number, H: number): Rect {
  const w = Math.min(r.w, W);
  const h = Math.min(r.h, H);
  return { x: clamp(r.x, 0, W - w), y: clamp(r.y, 0, H - h), w, h };
}

/** Moves the crop by a delta, staying inside the photo. */
export const moveRect = (r: Rect, dx: number, dy: number, W: number, H: number): Rect => clampRect({ ...r, x: r.x + dx, y: r.y + dy }, W, H);

/**
 * The crop resized by dragging a handle a total of (dx, dy) photo pixels from where the drag started (`r` is the
 * crop at the start). The opposite side or corner stays put; with a ratio, the shape is kept (edges grow the
 * other way about the middle). Always inside the photo, and never under eBay's minimum.
 */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, W: number, H: number, ratio: number | null): Rect {
  const min = minSize(W, H, ratio);
  const L = minLong(W, H);
  const hasW = handle.includes("w");
  const hasE = handle.includes("e");
  const hasN = handle.includes("n");
  const hasS = handle.includes("s");

  if (ratio == null) {
    let x0 = r.x;
    let y0 = r.y;
    let x1 = r.x + r.w;
    let y1 = r.y + r.h;
    if (hasW) x0 = clamp(x0 + dx, 0, x1 - min.w);
    if (hasE) x1 = clamp(x1 + dx, x0 + min.w, W);
    if (hasN) y0 = clamp(y0 + dy, 0, y1 - min.h);
    if (hasS) y1 = clamp(y1 + dy, y0 + min.h, H);
    // eBay's minimum long side: grow back the side being dragged (the longer one, for a corner).
    if (Math.max(x1 - x0, y1 - y0) < L) {
      const horizontal = (hasW || hasE) && (!(hasN || hasS) || x1 - x0 >= y1 - y0);
      if (horizontal) {
        if (hasW) x0 = Math.max(0, x1 - L);
        else x1 = Math.min(W, x0 + L);
      } else {
        if (hasN) y0 = Math.max(0, y1 - L);
        else y1 = Math.min(H, y0 + L);
      }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if ((hasW || hasE) && (hasN || hasS)) {
    // A corner: the opposite corner is the anchor; the bigger of the two movements sets the size.
    const ax = hasW ? r.x + r.w : r.x;
    const ay = hasN ? r.y + r.h : r.y;
    const pw = Math.abs((hasW ? r.x + dx : r.x + r.w + dx) - ax);
    const ph = Math.abs((hasN ? r.y + dy : r.y + r.h + dy) - ay);
    const maxW = Math.min(hasW ? ax : W - ax, (hasN ? ay : H - ay) * ratio);
    const w = clamp(Math.max(pw, ph * ratio), Math.min(min.w, maxW), maxW);
    const h = w / ratio;
    return { x: hasW ? ax - w : ax, y: hasN ? ay - h : ay, w, h };
  }
  if (hasW || hasE) {
    const ax = hasW ? r.x + r.w : r.x;
    const maxW = Math.min(hasW ? ax : W - ax, H * ratio);
    const w = clamp(hasW ? r.w - dx : r.w + dx, Math.min(min.w, maxW), maxW);
    const h = w / ratio;
    return { x: hasW ? ax - w : ax, y: clamp(cy - h / 2, 0, H - h), w, h };
  }
  const ay = hasN ? r.y + r.h : r.y;
  const maxH = Math.min(hasN ? ay : H - ay, W / ratio);
  const h = clamp(hasN ? r.h - dy : r.h + dy, Math.min(min.h, maxH), maxH);
  const w = h * ratio;
  return { x: clamp(cx - w / 2, 0, W - w), y: hasN ? ay - h : ay, w, h };
}

/** Zooms the crop about its middle: factor > 1 zooms in (a smaller crop). Keeps its shape and eBay's minimum. */
export function zoomRect(r: Rect, factor: number, W: number, H: number): Rect {
  const L = minLong(W, H);
  const long = Math.max(r.w, r.h);
  const s = clamp(1 / factor, L / long, Math.min(W / r.w, H / r.h));
  const w = r.w * s;
  const h = r.h * s;
  return clampRect({ x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }, W, H);
}

/** The largest crop of a ratio inside the photo, centred where the crop was. */
export function fitRatio(r: Rect, ratio: number, W: number, H: number): Rect {
  const w = W / H > ratio ? H * ratio : W;
  const h = w / ratio;
  return clampRect({ x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }, W, H);
}

/** Ratios a free crop snaps to when it's released close to one. */
export const SNAPS = [1, 4 / 3, 3 / 4];
export const SNAP_TOLERANCE = 0.04;

/** A free crop released within 4% of square or 4:3 snaps to it (about its middle); null when it isn't close. */
export function snapRect(r: Rect, W: number, H: number): { rect: Rect; ratio: number } | null {
  const now = r.w / r.h;
  const t = SNAPS.find((s) => Math.abs(now / s - 1) < SNAP_TOLERANCE && Math.abs(now / s - 1) > 1e-4);
  if (t == null) return null;
  // Keep the long side; if that won't fit, keep the short side.
  let w = r.w;
  let h = w / t;
  if (h > H) (h = H), (w = h * t);
  if (w > W) (w = W), (h = w / t);
  return { rect: clampRect({ x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }, W, H), ratio: t };
}

/** The scale that makes a W×H photo, turned by `deg`, still cover the whole W×H frame. */
export function coverScale(deg: number, W: number, H: number): number {
  const a = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.max((W * c + H * s) / W, (W * s + H * c) / H);
}

/** The crop after a quarter turn of the photo (1 clockwise, -1 anticlockwise); W×H is the size before turning. */
export function turnRect(r: Rect, W: number, H: number, by: 1 | -1): Rect {
  return by === 1 ? { x: H - (r.y + r.h), y: r.x, w: r.h, h: r.w } : { x: r.y, y: W - (r.x + r.w), w: r.h, h: r.w };
}

/** The saved size of a crop: its own pixels, capped at 2400 on the long side. */
export function outputFor(r: Rect): { w: number; h: number } {
  const scale = Math.min(1, MAX_OUTPUT / Math.max(r.w, r.h));
  return { w: Math.max(1, Math.round(r.w * scale)), h: Math.max(1, Math.round(r.h * scale)) };
}

/** A crop of a ratio centred on the item (fractions of the photo, from the photo check). */
export function centreRect(W: number, H: number, ratio: number, point: { x: number; y: number }, box?: Rect): Rect {
  return cropRect(W, H, centreOn(W, H, ratio, point, box));
}

/** Whether two crops are the same to within half a pixel. */
export const sameRect = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
