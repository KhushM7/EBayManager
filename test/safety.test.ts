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
  /\b(ReviseFixedPriceItem|ReviseItem|ReviseInventoryStatus|AddFixedPriceItem|AddItem|AddItems|EndFixedPriceItem|EndItem|EndItems|RelistFixedPriceItem|RelistItem|AddMemberMessageRTQ|AddMemberMessageAAQToPartner|RespondToBestOffer|SetUserPreferences|SetNotificationPreferences|UploadSiteHostedPictures|CompleteSale|LeaveFeedback|publishOffer|createOffer|updateOffer|bulkCreateAdsByListingId|bulkUpdateAdsBidByListingId|sendOfferToInterestedBuyers|sendMessage)\b/;

describe("write gate is the only path to eBay writes", () => {
  it("only src/ebay/write.ts names eBay write calls", () => {
    expect(filesMatching(WRITE_VERBS)).toEqual(["src/ebay/write.ts"]);
  });

  it("only the Trading client and the write gate use tradingRequest", () => {
    expect(filesMatching(/\btradingRequest\b/).sort()).toEqual(["src/ebay/trading.ts", "src/ebay/write.ts"]);
  });

  it("network calls happen only in reviewed modules", () => {
    // Outgoing calls only; the Worker's own `async fetch(` handler and `env.ASSETS.fetch(` (static files) don't count.
    expect(filesMatching(/(?<!async |[.\w])fetch\(/).sort()).toEqual([
      "src/ebay/auth.ts",
      "src/ebay/browse.ts",
      "src/ebay/trading.ts",
      "src/notify.ts",
      "src/push.ts",
    ]);
  });

  it("eBay hosts are chosen in one place", () => {
    expect(filesMatching(/ebay\.com(?!\/oauth\/api_scope)/)).toEqual(["src/ebay/hosts.ts"]);
  });

  it("prices, messages and offers are locked to approval", () => {
    for (const k of ["price", "message", "best_offer_response", "offer_to_watchers", "create_listing", "end_listing", "policy"])
      expect(LOCKED_KINDS).toContain(k);
  });
});
