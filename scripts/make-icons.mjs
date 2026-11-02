// Draws the PWA icons (a white tick on the accent teal) and the monochrome notification badge as PNGs.
// Run: node scripts/make-icons.mjs  (writes into web/public)
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const TEAL = [0x0d, 0x74, 0x80];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x + 0.5, y + 0.5), y * (size * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Distance from a point to a segment, for an anti-aliased stroke.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coverage of a tick, drawn in a box of the given scale (fraction of the icon) centred in it. */
function tick(size, scale) {
  const s = size * scale, o = (size - s) / 2, w = s * 0.11;
  const a = [o + s * 0.18, o + s * 0.53], b = [o + s * 0.42, o + s * 0.76], c = [o + s * 0.84, o + s * 0.27];
  return (x, y) => {
    const d = Math.min(segDist(x, y, ...a, ...b), segDist(x, y, ...b, ...c));
    return Math.max(0, Math.min(1, w - d + 0.5));
  };
}

const icon = (size, scale) => {
  const t = tick(size, scale);
  return png(size, (x, y) => {
    const k = t(x, y);
    return [...TEAL.map((v) => Math.round(v + (255 - v) * k)), 255];
  });
};

const badge = (size) => {
  const t = tick(size, 0.9);
  return png(size, (x, y) => [255, 255, 255, Math.round(255 * t(x, y))]);
};

writeFileSync("web/public/icon-192.png", icon(192, 0.72));
writeFileSync("web/public/icon-512.png", icon(512, 0.72));
writeFileSync("web/public/icon-maskable-512.png", icon(512, 0.5));
writeFileSync("web/public/badge-96.png", badge(96));
console.log("icons written");
