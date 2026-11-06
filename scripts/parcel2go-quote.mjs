// Parcel2Go quote probe (docs/parcel2go-api.md): signs in with the Parcel2Go credentials in .dev.vars and asks
// for quotes for a few typical parcels, so the quote format can be checked against a real reply before
// src/postage.ts reads it (QUOTE_FORMAT_CONFIRMED). Read-only: quoting books nothing and costs nothing.
//
//   node scripts/parcel2go-quote.mjs            (sandbox.parcel2go.com when PARCEL2GO_SANDBOX=true, else live)
//
// Needs in .dev.vars (gitignored): PARCEL2GO_CLIENT_ID, PARCEL2GO_CLIENT_SECRET, PARCEL2GO_SANDBOX=true.
// The full reply is saved to .parcel2go-sample.json (gitignored). Secrets and the token are never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const vars = parseEnv(readFileSync(".dev.vars", "utf8"));
const { PARCEL2GO_CLIENT_ID: id, PARCEL2GO_CLIENT_SECRET: secret } = vars;
if (!id || !secret) {
  console.error("Add PARCEL2GO_CLIENT_ID and PARCEL2GO_CLIENT_SECRET (and PARCEL2GO_SANDBOX=true) to .dev.vars first.");
  process.exit(1);
}
const base = vars.PARCEL2GO_SANDBOX === "true" ? "https://sandbox.parcel2go.com" : "https://www.parcel2go.com";
console.log(`Parcel2Go: ${base}`);

// The same carriers the app keeps (src/postage.ts, SIMPLE_DELIVERY_CARRIERS).
const carrierOf = (name) => {
  const n = String(name).toLowerCase().replace(/[^a-z]/g, "");
  return n.includes("evri") || n.includes("hermes") ? "Evri" : n.includes("royalmail") ? "Royal Mail" : n.includes("dhl") ? "DHL" : n.includes("inpost") ? "InPost" : null;
};

const t0 = Date.now();
const tok = await fetch(`${base}/auth/connect/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
  body: new URLSearchParams({ grant_type: "client_credentials", scope: "public-api", client_id: id, client_secret: secret }),
});
if (!tok.ok) {
  console.error(`Sign-in failed: ${tok.status}. Check the ID and secret, and that sandbox credentials go with PARCEL2GO_SANDBOX=true.`);
  process.exit(1);
}
const { access_token, expires_in } = await tok.json();
console.log(`Signed in (${Date.now() - t0} ms), token lasts ${expires_in} s.`);

const parcels = [
  { name: "Small parcel (book, 0.5 kg)", Weight: 0.5, Length: 25, Width: 18, Height: 4, Value: 10 },
  { name: "Headphones box (1 kg)", Weight: 1, Length: 25, Width: 20, Height: 10, Value: 120 },
  { name: "Medium box (5 kg)", Weight: 5, Length: 45, Width: 35, Height: 20, Value: 50 },
  { name: "Too heavy (40 kg)", Weight: 40, Length: 100, Width: 60, Height: 60, Value: 50 },
];
const samples = {};
for (const { name, ...p } of parcels) {
  const t = Date.now();
  const res = await fetch(`${base}/api/quotes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ CollectionAddress: { Country: "GBR" }, DeliveryAddress: { Country: "GBR" }, Parcels: [p] }),
  });
  const ms = Date.now() - t;
  if (!res.ok) {
    console.log(`\n${name}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    continue;
  }
  const data = await res.json();
  samples[name] = data;
  const quotes = Array.isArray(data.Quotes) ? data.Quotes : [];
  console.log(`\n${name}: ${quotes.length} quotes in ${ms} ms`);
  if (quotes[0]) {
    console.log(`  fields on a quote: ${Object.keys(quotes[0]).join(", ")}`);
    console.log(`  fields on its Service: ${Object.keys(quotes[0].Service ?? {}).join(", ")}`);
  }
  const simple = quotes
    .map((q) => ({ carrier: carrierOf(q.Service?.CourierName ?? ""), courier: q.Service?.CourierName, service: q.Service?.Name, price: Number(q.TotalPrice), collection: q.Service?.CollectionType, printer: q.Service?.IsPrinterRequired }))
    .filter((q) => q.carrier && q.price > 0)
    .sort((a, b) => a.price - b.price);
  console.log(`  couriers: ${[...new Set(quotes.map((q) => q.Service?.CourierName))].join(", ") || "none"}`);
  console.log(`  eBay Simple Delivery carriers, cheapest first:`);
  for (const q of simple.slice(0, 6)) console.log(`    ${q.carrier.padEnd(10)} ${String(q.service).padEnd(40)} £${q.price.toFixed(2)}  ${q.collection ?? ""}${q.printer ? ", needs a printer" : ""}`);
  if (!simple.length) console.log("    none");
}
writeFileSync(".parcel2go-sample.json", JSON.stringify(samples, null, 2));
console.log("\nFull replies saved to .parcel2go-sample.json");
