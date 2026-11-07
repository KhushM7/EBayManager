// Source scans that keep every eBay write behind the write gate. If one fails, route the new code
// through src/ebay/write.ts instead of loosening the test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCKED_KINDS } from "../src/rules";

function sourceFiles(dir = "src"): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p.replace(/\\/g, "/")] : [];
  });
}

const filesMatching = (re: RegExp) => sourceFiles().filter((f) => re.test(readFileSync(f, "utf8")));

const WRITE_VERBS =
  /\b(ReviseFixedPriceItem|ReviseItem|ReviseInventoryStatus|AddFixedPriceItem|AddItem|AddItems|EndFixedPriceItem|EndItem|EndItems|RelistFixedPriceItem|RelistItem|AddMemberMessageRTQ|AddMemberMessageAAQToPartner|RespondToBestOffer|SetUserPreferences|SetNotificationPreferences|UploadSiteHostedPictures|createImageFromFile|create_image_from_file|CompleteSale|LeaveFeedback|publishOffer|createOffer|updateOffer|bulkCreateAdsByListingId|bulkUpdateAdsBidByListingId|sendOfferToInterestedBuyers|sendMessage)\b/;

describe("write gate is the only path to eBay writes", () => {
  it("only src/ebay/write.ts (and the allowlist that names them) names eBay write calls", () => {
    expect(filesMatching(WRITE_VERBS).sort()).toEqual(["src/ebay/allowlist.ts", "src/ebay/write.ts"]);
  });

  it("only the Trading client and the write gate use tradingRequest, tradingUpload and mediaUpload", () => {
    expect(filesMatching(/\b(tradingRequest|tradingUpload|mediaUpload)\b/).sort()).toEqual(["src/ebay/trading.ts", "src/ebay/write.ts"]);
  });

  it("network calls happen only in reviewed modules", () => {
    // Outgoing calls only (a method named fetch on an object, such as a test double, does not count).
    expect(filesMatching(/(?<!async |[.\w])fetch\(/).sort()).toEqual([
      "src/deletion.ts",
      "src/ebay/auth.ts",
      "src/ebay/browse.ts",
      "src/ebay/sell.ts",
      "src/ebay/trading.ts",
      "src/notify.ts",
      "src/postage.ts",
      "src/push.ts",
      "src/solddata.ts",
    ]);
  });

  it("eBay hosts are chosen in one place", () => {
    expect(filesMatching(/ebay\.com(?!\/oauth\/api_scope)/)).toEqual(["src/ebay/hosts.ts"]);
  });

  it("every module that calls eBay checks the allowlist first", () => {
    for (const f of ["src/ebay/auth.ts", "src/ebay/browse.ts", "src/ebay/sell.ts", "src/ebay/trading.ts", "src/deletion.ts"]) {
      const src = readFileSync(f, "utf8");
      const fetches = (src.match(/(?<!async |[.\w])fetch\(/g) ?? []).length;
      const checks = (src.match(/assert(Rest|Trading)\(/g) ?? []).length;
      expect(checks, f).toBeGreaterThanOrEqual(fetches);
    }
  });

  it("every Trading verb the code names is on the allowlist", async () => {
    const { TRADING_READ, TRADING_CHECK, TRADING_WRITE } = await import("../src/ebay/allowlist");
    const allowed = new Set([...TRADING_READ, ...TRADING_CHECK, ...TRADING_WRITE]);
    const named = new Set<string>();
    for (const f of sourceFiles()) for (const m of readFileSync(f, "utf8").matchAll(/call: "([A-Z]\w+)"|trading\(\s*env,\s*"([A-Z]\w+)"|tradingRequest\(env, "([A-Z]\w+)"/g)) named.add(m[1] ?? m[2] ?? m[3]);
    expect(named.size).toBeGreaterThan(5);
    for (const v of named) expect(allowed.has(v), v).toBe(true);
  });

  it("prices, messages, offers and promotion are locked to approval", () => {
    for (const k of ["price", "message", "best_offer_response", "offer_to_watchers", "create_listing", "end_listing", "policy", "promote"])
      expect(LOCKED_KINDS).toContain(k);
  });
});

describe("data access stays behind the store (docs/azure-migration.md)", () => {
  it("nothing uses the old D1 database", () => {
    expect(filesMatching(/\benv\.DB\b|D1Database|\.prepare\(/)).toEqual([]);
  });

  it("only the Cosmos store and the Azure platform layer import Azure SDKs", () => {
    const azure = filesMatching(/from "@azure\//).sort();
    for (const f of azure) expect(f.startsWith("src/store/cosmos") || f.startsWith("src/platform/azure/"), f).toBe(true);
  });

  it("only src/store/ touches documents directly", () => {
    const direct = filesMatching(/\.docs\.(get|create|upsert|replace|patch|delete|query|batch)\(/).filter((f) => !f.startsWith("src/store/"));
    expect(direct).toEqual([]);
  });
});
