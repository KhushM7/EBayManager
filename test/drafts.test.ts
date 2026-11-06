import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { handleApi } from "../src/api";
import { acceptPhoto, jpegSize, memoryPhotoStore, stripJpegMetadata, MAX_PHOTOS } from "../src/photos";
import { cleanUpDrafts } from "../src/drafts";

/** A minimal JPEG: JFIF, an EXIF block holding a "GPS" marker, a comment, a frame header of w×h, and scan data. */
function jpeg(w: number, h: number, withExif = true): Uint8Array {
  const seg = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(withExif ? seg(0xe1, [...ascii("Exif"), 0, 0, ...ascii("GPS 51.5072N 0.1276W")]) : []),
    ...seg(0xfe, ascii("taken at home")),
    ...seg(0xc0, [8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    0x12, 0x34, 0x56, 0x78,
    0xff, 0xd9,
  ]);
}
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s));

describe("photo checks on the server", () => {
  it("reads a JPEG's size", () => {
    expect(jpegSize(jpeg(2400, 1800))).toEqual({ width: 2400, height: 1800 });
    expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("strips the location and comments, keeping the image", () => {
    const original = jpeg(2400, 1800);
    expect(has(original, "GPS")).toBe(true);
    const clean = stripJpegMetadata(original);
    expect(has(clean, "GPS")).toBe(false);
    expect(has(clean, "taken at home")).toBe(false);
    expect(has(clean, "JFIF")).toBe(true);
    expect(jpegSize(clean)).toEqual({ width: 2400, height: 1800 });
    expect(Buffer.from(clean.subarray(-6)).equals(Buffer.from([0x12, 0x34, 0x56, 0x78, 0xff, 0xd9]))).toBe(true);
  });

  it("refuses what isn't a usable photo", () => {
    expect(() => acceptPhoto(new TextEncoder().encode("<svg/>"))).toThrow(/Only JPEG/);
    expect(() => acceptPhoto(jpeg(300, 200))).toThrow(/too small/);
    expect(() => acceptPhoto(jpeg(6000, 4000))).toThrow(/too large/);
    expect(acceptPhoto(jpeg(1600, 1200))).toMatchObject({ width: 1600, height: 1200 });
  });
});

describe("drafts API", () => {
  let env: Env;
  let photos: ReturnType<typeof memoryPhotoStore>;
  let cookie = "";
  const call = (path: string, init: { method?: string; body?: BodyInit; json?: unknown } = {}) => {
    const url = new URL(`https://test.example/api${path}`);
    const method = init.method ?? (init.body !== undefined || init.json !== undefined ? "POST" : "GET");
    return handleApi(env, new Request(url, { method, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, headers: { "X-EbayManager": "1", Cookie: cookie } }), url);
  };
  const upload = (id: string, b: Uint8Array, issues = "") => call(`/drafts/${id}/photos${issues ? `?issues=${issues}` : ""}`, { body: b as unknown as BodyInit });

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<x/>")));
    photos = memoryPhotoStore();
    env = { store: memoryStore(), photos, EBAY_ENV: "sandbox", WRITE_MODE: "approval", SIGNING_KEY: "k", DASHBOARD_KEY: "dash-key", ALLOW_KEY_LOGIN: "true", PUBLIC_URL: "https://test.example" } as unknown as Env;
    cookie = "";
    cookie = ((await call("/login", { json: { key: "dash-key" } })).headers.get("Set-Cookie") ?? "").split(";")[0];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("needs a session", async () => {
    cookie = "";
    expect((await call("/drafts")).status).toBe(401);
  });

  it("creates a draft, stores photos without their location, serves them, and keeps K's title", async () => {
    const d = (await (await call("/drafts", { json: {} })).json()) as any;
    expect(d).toMatchObject({ status: "open", photos: [] });

    const r = (await (await upload(d.id, jpeg(2400, 1800), "dark,blur")).json()) as any;
    expect(r.photos).toEqual([expect.objectContaining({ width: 2400, height: 1800, issues: ["dark", "blur"], url: expect.stringMatching(new RegExp(`^/api/drafts/${d.id}/photos/\\w+$`)) })]);
    expect(photos.keys()).toEqual([`drafts/${d.id}/${r.photos[0].id}.jpg`]);
    const stored = await photos.get(photos.keys()[0]);
    expect(has(stored!, "GPS")).toBe(false);

    const served = await call(r.photos[0].url.replace(/^\/api/, ""));
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
    expect(served.headers.get("Cache-Control")).toMatch(/^private/);
    expect(has(new Uint8Array(await served.arrayBuffer()), "GPS")).toBe(false);

    await call(`/drafts/${d.id}`, { json: { title: "  Dyson vacuum, needs hose  " } });
    const list = (await (await call("/drafts")).json()) as any[];
    expect(list).toEqual([expect.objectContaining({ id: d.id, title: "Dyson vacuum, needs hose", created_by: "Sandbox test key" })]);
  });

  it("refuses a bad upload and keeps nothing of it", async () => {
    const d = (await (await call("/drafts", { json: {} })).json()) as any;
    const bad = await upload(d.id, new TextEncoder().encode("not a photo"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toMatch(/Only JPEG/);
    expect(photos.keys()).toEqual([]);
  });

  it("orders photos (the first is the main one) and removes one, deleting its file", async () => {
    const d = (await (await call("/drafts", { json: {} })).json()) as any;
    await upload(d.id, jpeg(1600, 1200));
    const two = (await (await upload(d.id, jpeg(1200, 1600))).json()) as any;
    const [a, b] = two.photos.map((p: any) => p.id);
    const ordered = (await (await call(`/drafts/${d.id}/order`, { json: { order: [b, a] } })).json()) as any;
    expect(ordered.photos.map((p: any) => p.id)).toEqual([b, a]);
    const removed = (await (await call(`/drafts/${d.id}/photos/${b}/remove`, { json: {} })).json()) as any;
    expect(removed.photos.map((p: any) => p.id)).toEqual([a]);
    expect(photos.keys()).toHaveLength(1);
  });

  it("stops at eBay's 24 photos", async () => {
    const d = (await (await call("/drafts", { json: {} })).json()) as any;
    for (let i = 0; i < MAX_PHOTOS; i++) expect((await upload(d.id, jpeg(1600, 1200))).status).toBe(200);
    const over = await upload(d.id, jpeg(1600, 1200));
    expect(over.status).toBe(400);
    expect(photos.keys()).toHaveLength(MAX_PHOTOS);
  });

  it("deletes a draft's photos when the draft is deleted, and after 30 days untouched", async () => {
    const a = (await (await call("/drafts", { json: {} })).json()) as any;
    const b = (await (await call("/drafts", { json: {} })).json()) as any;
    await upload(a.id, jpeg(1600, 1200));
    await upload(b.id, jpeg(1600, 1200));

    await call(`/drafts/${a.id}/delete`, { json: {} });
    expect(photos.keys().every((k) => k.startsWith(`drafts/${b.id}/`))).toBe(true);
    expect((await (await call("/drafts")).json()) as any[]).toHaveLength(1);

    expect(await cleanUpDrafts(env, Date.now() + 10 * 86_400_000)).toBe("0 abandoned, 0 published cleared, 0 photos deleted");
    expect(await cleanUpDrafts(env, Date.now() + 31 * 86_400_000)).toBe("1 abandoned, 0 published cleared, 1 photos deleted");
    expect(photos.keys()).toEqual([]);
  });

  it("refuses unknown drafts and photos", async () => {
    expect((await call("/drafts/draft_nope")).status).toBe(404);
    expect((await call("/drafts/../settings")).status).toBe(404);
    const d = (await (await call("/drafts", { json: {} })).json()) as any;
    expect((await call(`/drafts/${d.id}/photos/nothere`)).status).toBe(404);
  });
});
