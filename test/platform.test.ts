// The Azure platform layer's platform-neutral parts: security headers on every response, static files with
// the single-page-app fallback, and the client address used for rate limits.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { handle } from "../src/index";
import { clientIp } from "../src/api";
import { staticAssets } from "../src/platform/azure/static";

const ORIGIN = "https://app.example";

function site() {
  const dir = mkdtempSync(join(tmpdir(), "web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>EBayManager</title>");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('fetch',()=>{})");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  return staticAssets(dir);
}

const env = () => ({ store: memoryStore(), EBAY_ENV: "production", WRITE_MODE: "off", PUBLIC_URL: ORIGIN, SIGNING_KEY: "k", ASSETS: site() }) as unknown as Env;

describe("security headers on every response", () => {
  const expectHeaders = (res: Response, csp: RegExp) => {
    expect(res.headers.get("Content-Security-Policy")).toMatch(csp);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/frame-ancestors 'none'/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=31536000/);
  };

  it("the app, its screens, the API, server pages and health all carry them", async () => {
    const e = env();
    const get = (p: string, init?: RequestInit) => handle(new Request(`${ORIGIN}${p}`, init), e);
    expectHeaders(await get("/"), /default-src 'self'/);
    expectHeaders(await get("/listings"), /default-src 'self'/);
    expectHeaders(await get("/api/me"), /default-src 'none'/);
    expectHeaders(await get("/health"), /default-src 'none'/);
    expectHeaders(await get("/decide/x?d=approve&e=1&s=bad"), /default-src 'none'/);
    expect((await get("/mcp", { method: "POST" })).status).toBe(404);
  });

  it("no CSP allows scripts from anywhere but the app itself", async () => {
    const e = env();
    for (const p of ["/", "/api/me", "/decide/x?d=approve&e=1&s=bad", "/oauth/start"]) {
      const csp = (await handle(new Request(`${ORIGIN}${p}`), e)).headers.get("Content-Security-Policy")!;
      expect(csp, p).not.toMatch(/https?:|\*|unsafe-eval/);
      expect(csp, p).not.toMatch(/script-src[^;]*unsafe-inline/);
    }
  });
});

describe("static files", () => {
  const assets = site();
  const get = (p: string, method = "GET") => assets.serve(new Request(`${ORIGIN}${p}`, { method }));

  it("serves files, falls back to the app for screens, and 404s missing files", async () => {
    expect(await (await get("/")).text()).toMatch(/EBayManager/);
    expect(await (await get("/inbox")).text()).toMatch(/EBayManager/);
    expect((await get("/missing.png")).status).toBe(404);
    const js = await get("/assets/app-abc123.js");
    expect(js.headers.get("Content-Type")).toMatch(/javascript/);
    expect(js.headers.get("Cache-Control")).toMatch(/immutable/);
    expect((await get("/sw.js")).headers.get("Cache-Control")).toBe("no-cache");
  });

  it("can't be walked out of its folder, and only answers GET and HEAD", async () => {
    expect((await get("/%2e%2e/package.json")).status).toBe(404);
    expect((await get("/..%2f..%2fhost.json")).status).toBe(404);
    expect((await get("/", "POST")).status).toBe(405);
    expect(await (await get("/", "HEAD")).text()).toBe("");
  });
});

describe("client address for rate limits", () => {
  const req = (h: Record<string, string>) => new Request(ORIGIN, { headers: h });
  it("uses Azure's Client-IP only (the one header the front end overwrites), without the port", () => {
    expect(clientIp(req({ "Client-IP": "203.0.113.7:49152" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "Client-IP": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "Client-IP": "[2001:db8::1]:443" }))).toBe("2001:db8::1");
    expect(clientIp(req({ "Client-IP": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(req({ "Client-IP": "1.2.3.4, 5.6.7.8" }))).toBe("unknown");
    // Headers a visitor can set and Azure passes through unchanged are ignored.
    expect(clientIp(req({ "X-Client-IP": "1.2.3.4", "X-Forwarded-For": "1.2.3.4", "X-Real-IP": "1.2.3.4", "X-Azure-ClientIP": "1.2.3.4", "CF-Connecting-IP": "1.2.3.4" }))).toBe("unknown");
    expect(clientIp(req({}))).toBe("unknown");
  });
});
