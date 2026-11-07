// Crop and position for a listing photo (the Adjust tool): pure arithmetic, tested in test/listing-frame.test.ts.
// A frame is a window onto the photo with a fixed shape (square, 4:3 or the photo's own), a zoom of 1 or more
// and a centre in the photo's pixels. It always stays inside the photo, so nothing is ever added: it's an
// ordinary crop, the kind any basic photo editor makes.

export interface Frame {
  /** Width ÷ height of the frame. */
  aspect: number;
  /** 1 = the largest frame of this shape that fits in the photo; higher zooms in. */
  zoom: number;
  /** The frame's centre, in the photo's pixels. */
  cx: number;
  cy: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** eBay's minimum: the crop must keep at least this many pixels on its long side. */
export const MIN_LONG_SIDE = 500;
const MAX_ZOOM = 6;

/** The largest frame of this shape that fits in the photo (zoom 1). */
export function baseSize(imgW: number, imgH: number, aspect: number): { w: number; h: number } {
  return imgW / imgH > aspect ? { w: imgH * aspect, h: imgH } : { w: imgW, h: imgW / aspect };
}

/** How far it can zoom in and still leave eBay's minimum size. */
export function maxZoom(imgW: number, imgH: number, aspect: number): number {
  const b = baseSize(imgW, imgH, aspect);
  return Math.max(1, Math.min(MAX_ZOOM, Math.max(b.w, b.h) / MIN_LONG_SIDE));
}

/** The same frame with its zoom in range and its window moved back inside the photo. */
export function clampFrame(imgW: number, imgH: number, f: Frame): Frame {
  const zoom = Math.min(maxZoom(imgW, imgH, f.aspect), Math.max(1, f.zoom));
  const b = baseSize(imgW, imgH, f.aspect);
  const w = b.w / zoom;
  const h = b.h / zoom;
  return { aspect: f.aspect, zoom, cx: Math.min(imgW - w / 2, Math.max(w / 2, f.cx)), cy: Math.min(imgH - h / 2, Math.max(h / 2, f.cy)) };
}

/** The part of the photo the frame shows, in the photo's pixels. */
export function cropRect(imgW: number, imgH: number, f: Frame): Rect {
  const c = clampFrame(imgW, imgH, f);
  const b = baseSize(imgW, imgH, c.aspect);
  const w = b.w / c.zoom;
  const h = b.h / c.zoom;
  return { x: c.cx - w / 2, y: c.cy - h / 2, w, h };
}

/** The whole photo in a frame of this shape, centred. */
export const initialFrame = (imgW: number, imgH: number, aspect: number): Frame => clampFrame(imgW, imgH, { aspect, zoom: 1, cx: imgW / 2, cy: imgH / 2 });

/** How much of the frame the item fills after "Centre on item": room around it, as a buyer expects. */
export const ITEM_FILL = 0.65;

/**
 * A frame centred on the item, zoomed so the item fills about two thirds of it. `point` is the item's centre and
 * `box` its rough outline, both as fractions of the photo (from the photo check). It never zooms so far that the
 * outline would be cut off, nor past eBay's minimum size; near an edge the frame stops at the edge, so the item
 * is as close to the middle as the photo allows.
 */
export function centreOn(imgW: number, imgH: number, aspect: number, point: { x: number; y: number }, box?: Rect): Frame {
  const b = baseSize(imgW, imgH, aspect);
  const px = Math.min(imgW - 1, Math.max(1, point.x * imgW));
  const py = Math.min(imgH - 1, Math.max(1, point.y * imgH));
  const zoom = box && box.w > 0 && box.h > 0 ? Math.min(b.w / ((box.w * imgW) / ITEM_FILL), b.h / ((box.h * imgH) / ITEM_FILL)) : 1;
  return clampFrame(imgW, imgH, { aspect, zoom: Math.max(1, zoom), cx: px, cy: py });
}

/** The output size for a crop: its own pixels, capped at 2400 on the long side. */
export function outputSize(r: Rect): { w: number; h: number } {
  const scale = Math.min(1, 2400 / Math.max(r.w, r.h));
  return { w: Math.round(r.w * scale), h: Math.round(r.h * scale) };
}

/** A point (fractions of the photo) after turning the photo clockwise by a number of quarter turns. */
export function turnPoint(p: { x: number; y: number }, turns: number): { x: number; y: number } {
  let q = { ...p };
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) q = { x: 1 - q.y, y: q.x };
  return q;
}

/** A box (fractions of the photo) after turning the photo clockwise by a number of quarter turns. */
export function turnBox(b: Rect, turns: number): Rect {
  let q = { ...b };
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) q = { x: 1 - (q.y + q.h), y: q.x, w: q.h, h: q.w };
  return q;
}
