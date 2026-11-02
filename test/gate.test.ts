import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import { createProposal, decide, getProposal } from "../src/proposals";
import { callFor, ebayWrite, setWritesPaused, WriteRefused } from "../src/ebay/write";
import { trading } from "../src/ebay/trading";
import { ebayHosts } from "../src/ebay/hosts";
import { READONLY_SCOPES, FULL_SCOPES, userScopes } from "../src/ebay/auth";

const OK_XML = `<ReviseFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><ItemID>111</ItemID></ReviseFixedPriceItemResponse>`;

let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;

async function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
  const e = {
    DB: fakeD1(),
    EBAY_ENV: "sandbox",
    WRITE_MODE: "approval",
    EBAY_SITE_ID: "3",
    PUBLIC_URL: "https://test.example",
    SIGNING_KEY: "k",
    NTFY_TOPIC: "",
    ...overrides,
  } as Env;
  // A live token, so the Trading client never needs to refresh.
  await e.DB.prepare(
    "INSERT INTO ebay_tokens (id, access_token, access_expires_at, refresh_token, refresh_expires_at, scopes) VALUES (1, 't', ?, 'r', ?, 's')",
  )
    .bind(Date.now() + 3_600_000, Date.now() + 3_600_000)
    .run();
  return e;
}

const ebayCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("ebay.com"));
const price = (e: Env, itemId = "111", newPrice = 9.99) => createProposal(e, { kind: "price", itemId, payload: { newPrice } });
const setStatus = (e: Env, id: string, status: string) =>
  e.DB.prepare("UPDATE proposals SET status = ? WHERE id = ?").bind(status, id).run();
const auditOutcomes = async (e: Env) =>
  (await e.DB.prepare("SELECT outcome FROM audit_log ORDER BY id").all<{ outcome: string }>()).results.map((r) => r.outcome);

beforeEach(async () => {
  fetchMock = vi.fn(async () => new Response(OK_XML));
  vi.stubGlobal("fetch", fetchMock);
  env = await makeEnv();
});
afterEach(() => vi.unstubAllGlobals());

describe("write gate", () => {
  it("applies an approved proposal on Sandbox and logs it", async () => {
    const p = await price(env);
    expect(await decide(env, p.id, "approve")).toContain("ReviseFixedPriceItem ok");
    expect((await getProposal(env, p.id))?.status).toBe("applied");
    expect(ebayCalls()).toHaveLength(1);
    expect(String(ebayCalls()[0][0])).toBe("https://api.sandbox.ebay.com/ws/api.dll");
    expect(await auditOutcomes(env)).toEqual(["applied"]);
  });

  it("refuses a pending proposal", async () => {
    const p = await price(env);
    await expect(ebayWrite(env, p.id)).rejects.toThrow(WriteRefused);
    expect(ebayCalls()).toHaveLength(0);
    expect(await auditOutcomes(env)).toEqual(["refused"]);
  });

  it("refuses rejected and expired proposals", async () => {
    for (const status of ["rejected", "expired", "failed"]) {
      const p = await price(env, `item-${status}`);
      await setStatus(env, p.id, status);
      await expect(ebayWrite(env, p.id)).rejects.toThrow(WriteRefused);
    }
    expect(ebayCalls()).toHaveLength(0);
  });

  it("never applies the same proposal twice", async () => {
    const p = await price(env);
    await decide(env, p.id, "approve");
    expect(await decide(env, p.id, "approve")).toBe("Already applied");
    await setStatus(env, p.id, "applied");
    await expect(ebayWrite(env, p.id)).rejects.toThrow(WriteRefused);
    expect(ebayCalls()).toHaveLength(1);
  });

  it("refuses everything when WRITE_MODE is off, even an approved proposal", async () => {
    env.WRITE_MODE = "off";
    const p = await price(env);
    expect(p.dry_run).toBe(1);
    expect(await decide(env, p.id, "approve")).toMatch(/Dry run/);

    // Even if the row were forced to approved and not a dry run, the gate checks WRITE_MODE.
    await env.DB.prepare("UPDATE proposals SET status = 'approved', dry_run = 0 WHERE id = ?").bind(p.id).run();
    await expect(ebayWrite(env, p.id)).rejects.toThrow(/Writes are off/);
    expect(ebayCalls()).toHaveLength(0);
  });

  it("refuses when WRITE_MODE is unset", async () => {
    env.WRITE_MODE = "";
    const p = await price(env);
    await setStatus(env, p.id, "approved");
    await expect(ebayWrite(env, p.id)).rejects.toThrow(/Writes are off/);
  });

  it("refuses a dry-run proposal even after writes are switched on", async () => {
    env.WRITE_MODE = "off";
    const p = await price(env);
    env.WRITE_MODE = "approval";
    await setStatus(env, p.id, "approved");
    await expect(ebayWrite(env, p.id)).rejects.toThrow(/Dry-run/);
    expect(ebayCalls()).toHaveLength(0);
  });

  it("holds approved proposals while writes are paused", async () => {
    await setWritesPaused(env, true);
    const p = await price(env);
    expect(await decide(env, p.id, "approve")).toBe("Approved, not applied: Writes are paused");
    expect((await getProposal(env, p.id))?.status).toBe("approved");
    expect(ebayCalls()).toHaveLength(0);

    await setWritesPaused(env, false);
    expect(await ebayWrite(env, p.id)).toContain("ok");
  });

  it("won't approve an expired proposal", async () => {
    const p = await price(env);
    await env.DB.prepare("UPDATE proposals SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, p.id).run();
    expect(await decide(env, p.id, "approve")).toBe("Expired");
    expect(ebayCalls()).toHaveLength(0);
  });

  it("keeps kinds without a builder pending instead of approving them", async () => {
    const p = await createProposal(env, { kind: "end_listing", itemId: "111", payload: {} });
    expect(await decide(env, p.id, "approve")).toMatch(/^Not approved yet: .*not built yet/);
    expect((await getProposal(env, p.id))?.status).toBe("pending");
    expect(ebayCalls()).toHaveLength(0);
  });

  it("marks a failed eBay call as failed", async () => {
    fetchMock.mockImplementation(
      async () => new Response(`<ReviseFixedPriceItemResponse><Ack>Failure</Ack><Errors><LongMessage>Nope</LongMessage></Errors></ReviseFixedPriceItemResponse>`),
    );
    const p = await price(env);
    expect(await decide(env, p.id, "approve")).toBe("Failed: ReviseFixedPriceItem failed: Nope");
    expect((await getProposal(env, p.id))?.status).toBe("failed");
    expect(await auditOutcomes(env)).toEqual(["failed"]);
  });

  it("supersedes an older pending proposal of the same kind for the same item", async () => {
    const a = await price(env, "111", 10);
    const b = await price(env, "111", 9);
    expect((await getProposal(env, a.id))?.status).toBe("expired");
    expect((await getProposal(env, b.id))?.status).toBe("pending");
  });
});

describe("listing builder", () => {
  const base = { title: "T", description: "D", categoryId: "1", price: 5, conditionId: "3000", postcode: "SW1A 1AA" };
  it("collection only offers no postage service", () => {
    const { xml } = callFor({ kind: "create_listing", item_id: null, payload: JSON.stringify({ ...base, collectionOnly: true }) });
    expect(xml).toContain("<ShipToLocations>None</ShipToLocations>");
    expect(xml).not.toContain("ShippingDetails");
  });
  it("posted items use Royal Mail 2nd class at the given cost", () => {
    const { xml } = callFor({ kind: "create_listing", item_id: null, payload: JSON.stringify({ ...base, shippingCost: 2.85 }) });
    expect(xml).toContain("UK_RoyalMailSecondClassStandard");
    expect(xml).toContain('<ShippingServiceCost currencyID="GBP">2.85</ShippingServiceCost>');
  });
});

describe("environment safety", () => {
  it("fails closed when EBAY_ENV is missing or misspelt", () => {
    expect(() => ebayHosts({ EBAY_ENV: "" })).toThrow();
    expect(() => ebayHosts({ EBAY_ENV: "prod" })).toThrow();
    expect(ebayHosts({ EBAY_ENV: "sandbox" }).api).toBe("https://api.sandbox.ebay.com");
  });

  it("the read client refuses write verbs before calling eBay", async () => {
    await expect(trading(env, "ReviseFixedPriceItem", "")).rejects.toThrow(/not a read call/);
    await expect(trading(env, "AddFixedPriceItem", "")).rejects.toThrow(/not a read call/);
    expect(ebayCalls()).toHaveLength(0);
  });

  it("asks eBay for read-only scopes unless writes are on", () => {
    expect(userScopes({ WRITE_MODE: "off" } as Env)).toBe(READONLY_SCOPES);
    expect(userScopes({ WRITE_MODE: "approval" } as Env, true)).toBe(READONLY_SCOPES);
    expect(userScopes({ WRITE_MODE: "approval" } as Env)).toBe(FULL_SCOPES);
  });
});
