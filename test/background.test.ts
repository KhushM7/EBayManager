import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { jobStatus, runJob, startJob } from "../src/background";

describe("background jobs", () => {
  it("runs inline without a queue, and queues with one", async () => {
    const e = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", NTFY_TOPIC: "" } as Env;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    // Inline: the caller gets the outcome (here eBay is unreachable, so the price check throws, as before).
    await expect(startJob(e, "price_check", { itemId: "123456" }, "K")).rejects.toThrow();

    const sent: { jobId: string }[] = [];
    const q = { ...e, enqueue: (m: { jobId: string }) => void sent.push(m) } as Env;
    const started = await startJob(q, "price_check", { itemId: "123456" }, "K");
    expect(started.status).toBe("queued");
    expect(sent).toEqual([{ jobId: started.jobId }]);
    expect((await jobStatus(q, started.jobId!))!.status).toBe("queued");
    vi.unstubAllGlobals();
  });

  it("runs a job once even if the queue delivers it twice, and records a failure", async () => {
    const e = { store: memoryStore(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", NTFY_TOPIC: "", enqueue: () => {} } as unknown as Env;
    const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { jobId } = await startJob(e, "price_check", { itemId: "123456" }, "K");
    await Promise.all([runJob(e, jobId!), runJob(e, jobId!)]);
    const s = (await jobStatus(e, jobId!))!;
    expect(s.status).toBe("failed");
    expect(s.error).toBeTruthy();
    // One run: the second delivery found the job no longer queued and did nothing.
    const ebayCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("ebay.com")).length;
    await runJob(e, jobId!);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("ebay.com")).length).toBe(ebayCalls);
    vi.unstubAllGlobals();
  });
});
