// Tries the three operations against a running image AI container (docs/imageai.md):
//   docker build -t ebaymanager-imageai:local imageai
//   docker run --rm -p 8080:8080 -e IMAGEAI_KEY=local-test-key ebaymanager-imageai:local
//   node imageai/test-local.mjs [photo.jpg] [http://localhost:8080] [key]
// Writes the results next to this script's output folder (imageai/out/, gitignored) and prints timings.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const photo = process.argv[2] ?? "test/fixtures-photos/front.jpg";
const base = process.argv[3] ?? "http://localhost:8080";
const key = process.argv[4] ?? "local-test-key";
const out = "imageai/out";
mkdirSync(out, { recursive: true });

const jpeg = readFileSync(photo);
const size = (() => {
  for (let i = 2; i < jpeg.length; ) {
    const m = jpeg[i + 1];
    const len = jpeg.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: jpeg.readUInt16BE(i + 5), w: jpeg.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("not a JPEG");
})();

/** A greyscale PNG mask: white in a box in the lower-right quarter (the "clutter"), black elsewhere. */
function mask(w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = x > w * 0.75 && x < w * 0.9 && y > h * 0.75 && y < h * 0.9 ? 255 : 0;
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function call(op, extra = {}) {
  const form = new FormData();
  form.append("image", new Blob([jpeg], { type: "image/jpeg" }), "image.jpg");
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const t = Date.now();
  const res = await fetch(`${base}/v1/${op}`, { method: "POST", headers: { "X-ImageAI-Key": key }, body: form });
  const ms = Date.now() - t;
  const type = res.headers.get("Content-Type") ?? "";
  if (!res.ok) return console.log(`${op}: HTTP ${res.status} ${await res.text()} (${ms} ms)`);
  const file = `${out}/${op}.${type.includes("png") ? "png" : "jpg"}`;
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`${op}: ${res.status} ${type} X-Edit=${res.headers.get("X-Edit")} -> ${file} (${ms} ms)`);
}

console.log(`Photo ${photo}: ${size.w}x${size.h}`);
console.log("health:", await (await fetch(`${base}/health`)).text());
const wrong = await fetch(`${base}/v1/upscale`, { method: "POST", headers: { "X-ImageAI-Key": "wrong" }, body: new FormData() });
console.log(`wrong key: HTTP ${wrong.status} (expect 401)`);
await call("remove_background");
await call("erase", { mask: new Blob([mask(size.w, size.h)], { type: "image/png" }) });
await call("upscale", { denoise: "0.5" });
