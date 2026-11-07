// Draws the installed app's icons from the same logo as the app's top-left mark (web/src/logo.tsx): the blue
// tile with the white parcel tag, its tick and eBay's four-colour stripe. Keep the drawing below in step with
// logo.tsx. Writes into web/public:
//   icon-192.png, icon-512.png    the logo as is (rounded tile)
//   icon-maskable-512.png         full-bleed blue, for Android's adaptive icon shapes (the tag sits inside the
//                                 central 80% "safe zone", so no shape crops it)
//   apple-touch-icon.png          180 px, full-bleed (iOS rounds the corners itself)
//   badge-96.png                  white tag silhouette with the tick cut out, for Android's status bar
// Run: node scripts/make-icons.mjs   (needs the dev dependency @resvg/resvg-js)
import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const GRADIENT = `<defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d97ff"/><stop offset="1" stop-color="#2f5bff"/></linearGradient></defs>`;
const TAG = `
  <path d="M17 10h12l7 7v17a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z" fill="#fff"/>
  <circle cx="29.5" cy="16.5" r="2" fill="#2f5bff"/>
  <path d="M18.5 24.5l4 4 7.5-7.5" fill="none" stroke="#2f5bff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="14" y="32" width="5.5" height="5" fill="#e53238"/>
  <rect x="19.5" y="32" width="5.5" height="5" fill="#0064d2"/>
  <rect x="25" y="32" width="5.5" height="5" fill="#f5af02"/>
  <rect x="30.5" y="32" width="5.5" height="5" fill="#86b817"/>`;

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${GRADIENT}${body}</svg>`;

// The logo exactly as in the app: a rounded tile with a fine light edge.
const logo = svg(`<rect width="48" height="48" rx="13" fill="url(#t)"/><rect x="0.5" y="0.5" width="47" height="47" rx="12.5" fill="none" stroke="rgba(255,255,255,.28)"/>${TAG}`);
// Full-bleed square: the platform cuts its own shape. The tag is drawn a little smaller, centred, to keep a margin.
const square = svg(`<rect width="48" height="48" fill="url(#t)"/><g transform="translate(24 23.5) scale(0.86) translate(-25 -23.5)">${TAG}</g>`);
// Status-bar badge: Android uses only its alpha, so a white tag with the tick and hole cut out.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <mask id="m"><rect width="48" height="48" fill="#fff"/><circle cx="29.5" cy="16.5" r="2.2" fill="#000"/>
    <path d="M18.5 24.5l4 4 7.5-7.5" fill="none" stroke="#000" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></mask>
  <path d="M17 8h12l8 8v19a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3z" fill="#fff" mask="url(#m)"/></svg>`;

const render = (src, size) => new Resvg(src, { fitTo: { mode: "width", value: size } }).render().asPng();

const out = [
  ["web/public/icon-192.png", logo, 192],
  ["web/public/icon-512.png", logo, 512],
  ["web/public/icon-maskable-512.png", square, 512],
  ["web/public/apple-touch-icon.png", square, 180],
  ["web/public/badge-96.png", badge, 96],
];
for (const [file, src, size] of out) writeFileSync(file, render(src, size));
console.log(`Wrote ${out.map(([f]) => f.split("/").pop()).join(", ")}`);
