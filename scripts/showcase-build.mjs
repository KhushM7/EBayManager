// Builds the shareable showcase files from docs/showcase/ (index.html, slides.html, img/):
//   EBayManager-showcase.html  one file, images inlined, to upload or email
//   EBayManager-slides.pdf     the slides as a 1920x1080 PDF (a LinkedIn document carousel)
//   EBayManager-tour.mp4       the slides as a short 1080p video with crossfades
// Needs Google Chrome and ffmpeg. Run from the repository:  node scripts/showcase-build.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const dir = resolve("docs/showcase");
const chromePath = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SECONDS = 3.2;
const FADE = 0.6;

// 1. One self-contained HTML file.
const inline = (html) =>
  html.replace(/src="(img\/[^"]+)"/g, (_, p) => {
    const type = p.endsWith(".png") ? "image/png" : "image/jpeg";
    return `src="data:${type};base64,${readFileSync(join(dir, p)).toString("base64")}"`;
  });
writeFileSync(join(dir, "EBayManager-showcase.html"), inline(readFileSync(join(dir, "index.html"), "utf8")));
console.log("EBayManager-showcase.html");

// 2. The slides through headless Chrome (DevTools Protocol): a PDF and one PNG per slide.
const port = 9334;
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), "ebm-showcase-profile")}`, "--allow-file-access-from-files", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
if (!target) throw new Error("Chrome did not start.");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: pathToFileURL(join(dir, "slides.html")).href });
await sleep(2500);
const pdf = await send("Page.printToPDF", { paperWidth: 20, paperHeight: 11.25, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, printBackground: true, preferCSSPageSize: true });
writeFileSync(join(dir, "EBayManager-slides.pdf"), Buffer.from(pdf.result.data, "base64"));
console.log("EBayManager-slides.pdf");

const frames = join(tmpdir(), "ebm-showcase-frames");
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const count = (await send("Runtime.evaluate", { expression: "document.querySelectorAll('.slide').length", returnByValue: true })).result.result.value;
for (let i = 0; i < count; i++) {
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: i * 1080, width: 1920, height: 1080, scale: 1 }, captureBeyondViewport: true });
  writeFileSync(join(frames, `s${String(i).padStart(2, "0")}.png`), Buffer.from(shot.result.data, "base64"));
}
ws.close();
chrome.kill();

// 3. The video: each slide SECONDS long, crossfading into the next.
const files = readdirSync(frames).sort().map((f) => join(frames, f));
const args = ["-y", "-loglevel", "error"];
for (const f of files) args.push("-loop", "1", "-t", String(SECONDS + FADE), "-i", f);
let chain = "";
let last = "[0:v]";
files.slice(1).forEach((_, k) => {
  const out = `[v${k + 1}]`;
  chain += `${last}[${k + 1}:v]xfade=transition=fade:duration=${FADE}:offset=${((k + 1) * SECONDS).toFixed(2)}${out};`;
  last = out;
});
chain += `${last}format=yuv420p[out]`;
args.push("-filter_complex", chain, "-map", "[out]", "-r", "30", "-c:v", "libx264", "-crf", "22", "-movflags", "+faststart", join(dir, "EBayManager-tour.mp4"));
const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (r.status !== 0) throw new Error("ffmpeg failed.");
console.log("EBayManager-tour.mp4");
