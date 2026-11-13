import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { handlePhotoAi, pngSize } from "../src/imageai";
import { serviceState, serviceStatuses } from "../src/services";

// The photo AI proxy (src/imageai.ts): checks the upload, forwards it with the shared key, maps the replies.

const photo = new Uint8Array(readFileSync("test/fixtures-photos/front.jpg")); // 1600×1200

function png(w: number, h: number): Uint8Array {
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const x of b) for (let k = 0, v = (c ^ x) & 0xff; k < 8; k++) (v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1), k === 7 && (c = (c >>> 8) ^ v);
    return ~c >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(d.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(t), d])));
    return Buffer.concat([head, Buffer.from(t), d, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((w + 1) * h))), chunk("IEND", Buffer.alloc(0))]));
}

let env: Env;
let calls: { url: string; init: RequestInit }[];
const reply = (r: () => Response | Promise<Response>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return r();
    }),
  );

function post(op: string, parts: Record<string, Uint8Array | string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(parts)) typeof v === "string" ? form.append(k, v) : form.append(k, new Blob([v as BlobPart]), `${k}.bin`);
  return handlePhotoAi(env, new Request("https://app.test/api/photo-ai/" + op, { method: "POST", body: form }), op);
}

beforeEach(() => {
  env = { store: memoryStore(), EBAY_ENV: "sandbox", IMAGEAI_URL: "https://imageai.test/", IMAGEAI_KEY: "k-123" } as Env;
  calls = [];
  reply(() => new Response(new Uint8Array([0x89, 0x50]), { headers: { "Content-Type": "image/png" } }));
});
afterEach(() => vi.unstubAllGlobals());

describe("photo AI proxy", () => {
  it("says it isn't set up until the container's address and key are", async () => {
    env = { ...env, IMAGEAI_URL: undefined };
    const res = await post("remove_background", { image: photo });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "not_set_up" });
    expect(calls).toEqual([]);
    // Settings lists it only once it's set up.
    expect((await serviceStatuses(env)).some((s) => s.id === "imageai")).toBe(false);
  });

  it("forwards the photo with the shared key and returns the edited photo with what was done", async () => {
    const res = await post("remove_background", { image: photo });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Edit")).toBe("ai_background");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://imageai.test/v1/remove_background");
    expect((calls[0].init.headers as Record<string, string>)["X-ImageAI-Key"]).toBe("k-123");
    const sent = calls[0].init.body as FormData;
    expect((sent.get("image") as Blob).type).toBe("image/jpeg");
    expect(sent.get("mask")).toBeNull();
  });

  it("refuses what isn't a photo, an unknown tool, and a mask that doesn't match", async () => {
    expect((await post("remove_background", { image: new Uint8Array([1, 2, 3, 4, 5]) })).status).toBe(415);
    expect((await post("remove_background", {})).status).toBe(400);
    expect((await post("paint_a_cat", { image: photo })).status).toBe(404);
    expect((await post("erase", { image: photo })).status).toBe(400);
    const wrong = await post("erase", { image: photo, mask: png(800, 600) });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatch(/same size/);
    expect(calls).toEqual([]);
  });

  it("sends a matching mask for spot removal, and the denoise strength for upscale", async () => {
    reply(() => new Response(new Uint8Array([0xff, 0xd8]), { headers: { "Content-Type": "image/jpeg" } }));
    expect(pngSize(png(1600, 1200))).toEqual({ width: 1600, height: 1200 });
    const erased = await post("erase", { image: photo, mask: png(1600, 1200) });
    expect(erased.status).toBe(200);
    expect(erased.headers.get("X-Edit")).toBe("ai_erase");
    expect(((calls[0].init.body as FormData).get("mask") as Blob).type).toBe("image/png");
    const up = await post("upscale", { image: photo, denoise: "3" });
    expect(up.headers.get("X-Edit")).toBe("ai_upscale");
    expect((calls[1].init.body as FormData).get("denoise")).toBe("1");
  });

  it("passes on the container's reason for a photo it can't use, and hides anything else", async () => {
    reply(() => Response.json({ error: "Paint over what to remove first." }, { status: 400 }));
    const r1 = await post("erase", { image: photo, mask: png(1600, 1200) });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe("Paint over what to remove first.");

    reply(() => new Response("nope", { status: 401 }));
    const r2 = await post("upscale", { image: photo });
    expect(r2.status).toBe(502);
    expect(await r2.json()).toMatchObject({ code: "key_rejected" });
    // A rejected key is recorded at once, for the service alert.
    expect((await serviceState(env, "imageai")).kind).toBe("auth");

    reply(() => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await (await post("upscale", { image: photo })).json()).toMatchObject({ code: "bad_reply" });
  });

  it("times out after a long cold start with a clear message, and records the failure", async () => {
    reply(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const res = await post("upscale", { image: photo });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ code: "timeout" });
    expect((await serviceState(env, "imageai")).failures).toBe(1);
  });
});
