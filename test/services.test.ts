import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import { checkServices, classifyClaudeError, ebayNeedsReconnect, PERSIST_MS, recordFailure, recordOk, serviceState, serviceStatuses } from "../src/services";
import { userToken } from "../src/ebay/auth";
import { searchSold } from "../src/solddata";

let env: Env;
const open = async () => (await env.store.todos.list("open")).filter((t) => t.code === "service_down");

beforeEach(() => {
  env = { store: memoryStore(), EBAY_ENV: "sandbox", EBAY_APP_ID: "app", EBAY_CERT_ID: "cert", EBAY_RUNAME: "ru", TRAWL_API_KEY: "t" } as Env;
});
afterEach(() => vi.unstubAllGlobals());

const expiredTokens = () =>
  env.store.kv.saveEbayTokens({ access_token: "old", access_expires_at: Date.now() - 1000, refresh_token: "r", refresh_expires_at: Date.now() + 1e9, scopes: "s" });

describe("outside services", () => {
  it("a revoked eBay sign-in (invalid_grant) asks K to reconnect at once, and clears when eBay accepts it again", async () => {
    await expiredTokens();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"invalid_grant","error_description":"the provided authorization refresh token is invalid"}', { status: 400 })));
    await expect(userToken(env)).rejects.toThrow(/invalid_grant/);
    expect(await ebayNeedsReconnect(env)).toBe(true);
    // eBay itself isn't blamed: the sign-in failed before any eBay call.
    expect((await serviceState(env, "ebay")).failures).toBe(0);

    expect(await checkServices(env)).toBe("1 down, 1 new");
    const [todo] = await open();
    expect(todo.title).toBe("Reconnect eBay");
    expect(todo.detail).toMatch(/username or password/);
    expect(todo.detail).toMatch(/Settings → eBay connection/);
    // Checked again with nothing changed: no second to-do or notification.
    expect(await checkServices(env)).toBe("1 down");

    // K reconnects: the next refresh works, and the to-do resolves.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "new", expires_in: 7200 })));
    expect(await userToken(env)).toBe("new");
    expect(await ebayNeedsReconnect(env)).toBe(false);
    expect(await checkServices(env)).toBe("0 down, 1 back");
    expect(await open()).toEqual([]);
  });

  it("passing faults alert only when they persist: 3 in a row over 10 minutes", async () => {
    const t0 = Date.now();
    await recordFailure(env, "ebay", "error", new Error("HTTP 503"), t0);
    await recordFailure(env, "ebay", "error", new Error("HTTP 503"), t0 + 60_000);
    await recordFailure(env, "ebay", "error", new Error("HTTP 503"), t0 + 120_000);
    expect(await checkServices(env)).toBe("0 down"); // 3 tries, but only 2 minutes
    await recordFailure(env, "ebay", "error", new Error("HTTP 502"), t0 + PERSIST_MS);
    expect(await checkServices(env)).toBe("1 down, 1 new");
    expect((await open())[0].title).toBe("eBay isn't answering");
    expect((await serviceStatuses(env)).find((s) => s.id === "ebay")).toMatchObject({ level: "down" });
    await recordOk(env, "ebay");
    expect(await checkServices(env)).toBe("0 down, 1 back");
  });

  it("Claude: a rejected key or an empty credit balance is a stop, an overload is a passing fault", () => {
    expect(classifyClaudeError(Object.assign(new Error("invalid x-api-key"), { status: 401 }))).toBe("auth");
    expect(classifyClaudeError(Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), { status: 400 }))).toBe("auth");
    expect(classifyClaudeError(Object.assign(new Error("Overloaded"), { status: 529 }))).toBe("error");
    expect(classifyClaudeError(new Error("fetch failed"))).toBe("error");
  });

  it("sold data: a used-up month isn't an outage (the allowance check reports it), a rejected key is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    await expect(searchSold(env, "trawl", { words: "a b" })).rejects.toThrow();
    expect((await serviceState(env, "trawl")).failures).toBe(0);

    await env.store.kv.set("solddata_quota:trawl", "null");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(searchSold(env, "trawl", { words: "c d" })).rejects.toThrow();
    expect(await checkServices(env)).toBe("1 down, 1 new");
    expect((await open())[0].title).toBe("Trawl (sold prices) rejected the app's key");
  });

  it("a network failure is recorded and still thrown to the caller", async () => {
    await expiredTokens();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(userToken(env)).rejects.toThrow("fetch failed");
    expect(await serviceState(env, "ebay_account")).toMatchObject({ failures: 1, kind: "error", lastError: "fetch failed" });
    expect(await ebayNeedsReconnect(env)).toBe(false);
  });
});
