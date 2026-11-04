import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

// The dashboard and PWA (web/dist, copied next to the function code at build time), served from memory with
// the single-page-app fallback that Workers static assets used to provide. Only GET and HEAD; files are
// looked up by exact path, so ".." and other tricks can't reach anything outside web/dist.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

interface File {
  body: Uint8Array;
  type: string;
}

function load(dir: string): Map<string, File> {
  const files = new Map<string, File>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set("/" + relative(dir, p).split(sep).join("/"), { body: readFileSync(p), type: TYPES[extname(p).toLowerCase()] ?? "application/octet-stream" });
    }
  };
  walk(dir);
  return files;
}

export function staticAssets(dir: string) {
  let files: Map<string, File> | null = null;
  return {
    async serve(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      files ??= load(dir);
      const path = decodeURIComponent(new URL(request.url).pathname);
      let file = files.get(path === "/" ? "/index.html" : path);
      // Single-page app: a path that isn't a file and has no extension is a screen; serve the app.
      if (!file && !extname(path)) file = files.get("/index.html");
      if (!file) return new Response("Not found", { status: 404 });
      // Hashed build assets never change; the shell, the service worker and the manifest must stay fresh.
      const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
      return new Response(request.method === "HEAD" ? null : (file.body as BodyInit), { headers: { "Content-Type": file.type, "Cache-Control": cache } });
    },
  };
}
