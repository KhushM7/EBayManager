import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { flushLog, INFO_CHARS_PER_HOUR, log, MAX_EVENTS, MAX_INFO_EVENTS, resetLogState, startRun } from "../src/log";
import { beat, checkHeartbeat, lastRuns, NIGHTLY_LATE_MS, noteNightly, notePoll, outsideHeartbeat, POLL_LATE_MS, resetOutside } from "../src/monitor";
import { recordFailure } from "../src/services";
import { memoryStore } from "../src/store";

let env: Env;
const NOW = 1_800_000_000_000;
const open = async () => (await env.store.todos.list("open")).map((t) => t.code);

beforeEach(() => {
  env = { store: memoryStore(), EBAY_ENV: "production", WRITE_MODE: "approval" } as Env;
  resetOutside();
  resetLogState();
});
afterEach(() => vi.useRealTimers());

describe("heartbeats", () => {
  it("a stopped poll or nightly becomes one to-do, resolved when it runs again", async () => {
    await checkHeartbeat(env, ["poll", "nightly"], NOW);
    expect(await open()).toEqual([]);
    await beat(env, "poll", NOW);
    await beat(env, "nightly", NOW);
    await checkHeartbeat(env, ["poll", "nightly"], NOW + POLL_LATE_MS + 1);
    expect(await open()).toEqual(["monitor_poll"]);
    await checkHeartbeat(env, ["poll", "nightly"], NOW + NIGHTLY_LATE_MS + 1);
    expect((await open()).sort()).toEqual(["monitor_nightly", "monitor_poll"]);
    await beat(env, "poll", NOW + NIGHTLY_LATE_MS + 1);
    await beat(env, "nightly", NOW + NIGHTLY_LATE_MS + 1);
    await checkHeartbeat(env, ["poll", "nightly"], NOW + NIGHTLY_LATE_MS + 2);
    expect(await open()).toEqual([]);
  });

  it("the outside trigger checks at most every half hour", async () => {
    await beat(env, "poll", NOW);
    await outsideHeartbeat(env, NOW + 1000);
    await outsideHeartbeat(env, NOW + POLL_LATE_MS - 16 * 60_000);
    expect(await open()).toEqual([]);
    // Another instance, while the lock is held: no second check.
    resetOutside();
    await outsideHeartbeat(env, NOW + POLL_LATE_MS + 1);
    expect(await open()).toEqual([]);
    await env.store.jobs.releaseLock("heartbeat");
    resetOutside();
    await outsideHeartbeat(env, NOW + POLL_LATE_MS + 1);
    expect(await open()).toEqual(["monitor_poll"]);
  });

  it("never throws", async () => {
    const broken = { store: null } as unknown as Env;
    await checkHeartbeat(broken, ["poll"]);
    await notePoll(broken, ["x"]);
    await noteNightly(broken, {});
  });
});

describe("failures", () => {
  it("three polls failing in a row are told once, and cleared by a good one", async () => {
    await notePoll(env, ["a"], NOW);
    await notePoll(env, ["a"], NOW + 1);
    expect(await open()).toEqual([]);
    await notePoll(env, ["a"], NOW + 2);
    await notePoll(env, ["a"], NOW + 3);
    expect(await open()).toEqual(["monitor_poll_errors"]);
    await notePoll(env, [], NOW + 4);
    expect(await open()).toEqual([]);
  });

  it("isn't told twice when the eBay sign-in alert already says why", async () => {
    await recordFailure(env, "ebay_account", "auth", new Error("invalid_grant"));
    for (let i = 0; i < 4; i++) await notePoll(env, ["invalid_grant"], NOW + i);
    await noteNightly(env, { snapshot: "failed: invalid_grant" }, NOW);
    expect(await open()).toEqual([]);
  });

  it("failed nightly steps are logged as errors and named in one to-do", async () => {
    await noteNightly(env, { snapshot: "7 listings", orders: "failed: HTTP 500", traffic: "failed: none" }, NOW);
    expect(await open()).toEqual(["monitor_nightly_steps"]);
    expect((await env.store.todos.list("open"))[0].detail).toContain("orders, traffic");
    const errors = await env.store.jobs.recentEvents({ since: 0, status: ["error"] });
    expect(errors.map((e) => e.detail).sort()).toEqual(["orders: failed: HTTP 500", "traffic: failed: none"]);
    await env.store.kv.setJson("last_nightly", { at: NOW, steps: { orders: "failed: HTTP 500" } });
    expect(await lastRuns(env)).toMatchObject({ nightly: NOW, failedSteps: ["orders"] });
    await noteNightly(env, { orders: "4 orders" }, NOW + 1);
    expect(await open()).toEqual([]);
  });

  it("Sandbox's missing traffic data isn't a problem", async () => {
    env.EBAY_ENV = "sandbox";
    await noteNightly(env, { traffic: "failed: none" }, NOW);
    expect(await open()).toEqual([]);
  });
});

describe("Azure's share of the log", () => {
  const withSink = () => {
    const lines: { level: string; line: string }[] = [];
    env.logSink = (level, line) => void lines.push({ level, line });
    return lines;
  };

  it("stops routine lines at the allowance, counts them, and still sends errors", async () => {
    vi.useFakeTimers({ now: NOW });
    const lines = withSink();
    const each = "x".repeat(900);
    for (let i = 0; i < 300; i++) await log(env, "info", "routine", { detail: each + i, lineOnly: true });
    expect(lines.reduce((s, l) => s + l.line.length, 0)).toBeLessThanOrEqual(INFO_CHARS_PER_HOUR);
    const sent = lines.length;
    await log(env, "error", "broken", { detail: "real" });
    expect(lines.length).toBe(sent + 1);
    flushLog(env);
    expect(JSON.parse(lines.at(-1)!.line)).toMatchObject({ ev: "log.held_back", routine: 300 - sent });
    vi.setSystemTime(NOW + 3_600_000);
    await log(env, "info", "routine", { detail: "next hour", lineOnly: true });
    expect(lines.at(-1)!.line).toContain("next hour");
  });

  it("counts repeats of the same error instead of sending each", async () => {
    vi.useFakeTimers({ now: NOW });
    const lines = withSink();
    for (let i = 0; i < 5; i++) await log(env, "error", "same", { detail: "again" });
    expect(lines.length).toBe(1);
    vi.setSystemTime(NOW + 11 * 60_000);
    await log(env, "error", "same", { detail: "again" });
    expect(JSON.parse(lines.at(-1)!.line).repeats).toBe(4);
    // Every one is still an event.
    expect((await env.store.jobs.recentEvents({ since: 0 })).length).toBe(6);
  });

  it("names the run, and caps its events with room kept for failures", async () => {
    startRun(env, "nightly", "run-1");
    for (let i = 0; i < MAX_INFO_EVENTS + 20; i++) await log(env, "info", "routine", { detail: String(i) });
    for (let i = 0; i < 200; i++) await log(env, "error", "bad", { detail: String(i) });
    const all = await env.store.jobs.recentEvents({ since: 0, limit: 1000 });
    expect(all.length).toBe(MAX_EVENTS + 1);
    expect(all.filter((e) => e.kind === "bad").length).toBe(MAX_EVENTS - MAX_INFO_EVENTS);
    expect(all.filter((e) => e.kind === "log.capped").length).toBe(1);
    expect(all.every((e) => e.run_id === "run-1" && e.job === "nightly")).toBe(true);
  });
});
