// Creates the owner's one-time invite link while nobody is registered, and writes it to a gitignored file
// instead of printing it (it's a key to the whole app for 24 hours).
//   node scripts/owner-invite.mjs sandbox      -> .owner-invite-sandbox.txt
//   node scripts/owner-invite.mjs production   -> .owner-invite-production.txt
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const envName = process.argv[2];
const url = { sandbox: "https://ebay-autopilot-sandbox.ebay-autopilot.workers.dev", production: "https://ebay-autopilot-production.ebay-autopilot.workers.dev" }[envName];
if (!url) throw new Error("Usage: node scripts/owner-invite.mjs sandbox|production");
const vars = parseEnv(readFileSync(envName === "production" ? ".prod.vars" : ".dev.vars", "utf8"));

const res = await fetch(`${url}/api/setup`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-EbayManager": "1", Origin: url },
  body: JSON.stringify({ key: vars.DASHBOARD_KEY, name: process.argv[3] ?? "K" }),
});
const out = await res.json();
if (!res.ok) throw new Error(`Setup refused (${res.status}): ${out.error}`);
const file = `.owner-invite-${envName}.txt`;
writeFileSync(file, `${out.inviteUrl}\n`);
console.log(`Owner invite written to ${file}. Open it on the phone you'll use, within 24 hours. It works once.`);
