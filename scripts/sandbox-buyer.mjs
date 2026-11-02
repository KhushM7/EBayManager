// Acts as a SANDBOX TEST BUYER, for testing the offer flow when eBay's Sandbox website won't load buyer pages.
// Hard-wired to eBay Sandbox: it can't reach a real account. It is not part of the seller service in src/.
//
// 1. In the developer portal: Application Keys -> Sandbox -> User Tokens -> "Get a Token from eBay via Your
//    Application" (OAuth), sign in as the BUYER test user, and copy the token (valid about 2 hours).
// 2. Save it as the only line of .sandbox-buyer-token in the project folder (gitignored).
// 3. node scripts/sandbox-buyer.mjs offer <itemId> <price> ["message to the seller"]
//    node scripts/sandbox-buyer.mjs offers            (the buyer's offers and their status)
//    node scripts/sandbox-buyer.mjs whoami            (which Sandbox user the token belongs to)
import { readFileSync } from "node:fs";

const SANDBOX_TRADING = "https://api.sandbox.ebay.com/ws/api.dll";
const SITE_ID_UK = "3";

const token = readFileSync(".sandbox-buyer-token", "utf8").trim();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function call(verb, inner) {
  const res = await fetch(SANDBOX_TRADING, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": verb,
      "X-EBAY-API-SITEID": SITE_ID_UK,
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1349",
      "X-EBAY-API-IAF-TOKEN": token,
      "Content-Type": "text/xml",
    },
    body: `<?xml version="1.0" encoding="utf-8"?><${verb}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_GB</ErrorLanguage><WarningLevel>High</WarningLevel>${inner}</${verb}Request>`,
  });
  const xml = await res.text();
  const ack = xml.match(/<Ack>(\w+)<\/Ack>/)?.[1];
  const errors = [...xml.matchAll(/<LongMessage>([^<]*)<\/LongMessage>/g)].map((m) => m[1]);
  return { ack, errors, xml };
}

const [cmd, itemId, price, message] = process.argv.slice(2);

/** The Sandbox user the token belongs to (GetUser with no UserID returns the caller). */
async function whoami() {
  const r = await call("GetUser", "");
  if (r.ack === "Failure") throw new Error(`GetUser failed: ${r.errors.join("; ")}`);
  return r.xml.match(/<UserID>([^<]*)<\/UserID>/)?.[1] ?? "unknown";
}


if (cmd === "whoami") {
  console.log(`Token belongs to: ${await whoami()}`);
} else if (cmd === "offer") {
  if (!/^\d+$/.test(itemId ?? "") || !(Number(price) > 0)) throw new Error("Usage: offer <itemId> <price> [message]");
  const user = await whoami();
  const seller = (await call("GetItem", `<ItemID>${esc(itemId)}</ItemID>`)).xml.match(/<Seller>[\s\S]*?<UserID>([^<]*)<\/UserID>/)?.[1];
  if (user === seller) throw new Error(`This token belongs to the seller (${user}). Get a token signed in as the buyer test user.`);
  console.log(`Offering as ${user} on ${seller}'s item`);
  const r = await call(
    "PlaceOffer",
    `<ItemID>${esc(itemId)}</ItemID><EndUserIP>127.0.0.1</EndUserIP>
     <Offer><Action>Offer</Action><MaxBid currencyID="GBP">${Number(price).toFixed(2)}</MaxBid><Quantity>1</Quantity>${
       message ? `<Message>${esc(message)}</Message>` : ""
     }</Offer>`,
  );
  console.log(`PlaceOffer: ${r.ack}${r.errors.length ? `\n  ${r.errors.join("\n  ")}` : ""}`);
  const id = r.xml.match(/<BestOfferID>([^<]*)<\/BestOfferID>/)?.[1];
  if (id) console.log(`Best Offer ID: ${id}`);
} else if (cmd === "offers") {
  const r = await call("GetBestOffers", `<BestOfferStatus>All</BestOfferStatus><DetailLevel>ReturnAll</DetailLevel>`);
  console.log(`GetBestOffers: ${r.ack}${r.errors.length ? `\n  ${r.errors.join("\n  ")}` : ""}`);
  for (const m of r.xml.matchAll(/<BestOffer>([\s\S]*?)<\/BestOffer>/g)) {
    const f = (tag) => m[1].match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))?.[1];
    console.log(`  ${f("BestOfferID")}: £${f("Price")} ${f("Status")} ${f("SellerMessage") ? `· seller: ${f("SellerMessage")}` : ""}`);
  }
} else {
  console.log("Usage: node scripts/sandbox-buyer.mjs offer <itemId> <price> [message] | offers");
}
