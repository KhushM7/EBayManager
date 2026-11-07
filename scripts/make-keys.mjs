// Adds any missing app secrets to a vars file without printing them. Existing values are kept.
//   node scripts/make-keys.mjs              -> .dev.vars (Sandbox)
//   node scripts/make-keys.mjs .prod.vars   -> production
// Then upload with: node scripts/azure-secrets.mjs sandbox|production. People: node scripts/people.mjs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, webcrypto } from "node:crypto";

const file = process.argv[2] ?? ".dev.vars";
let vars = existsSync(file) ? readFileSync(file, "utf8") : "";
if (vars && !vars.endsWith("\n")) vars += "\n";
const has = (k) => new RegExp(`^${k}=`, "m").test(vars);
const added = [];
const add = (k, v) => {
  if (has(k)) return;
  vars += `${k}=${v}\n`;
  added.push(k);
};

add("SIGNING_KEY", randomBytes(48).toString("base64url"));
// K's operations key: reads /health (and, on Sandbox only, a test sign-in).
add("DASHBOARD_KEY", randomBytes(24).toString("base64url"));
// eBay accepts 32 to 80 characters: letters, digits, underscore and hyphen.
add("EBAY_DELETION_TOKEN", randomBytes(36).toString("base64url"));
if (!has("VAPID_KEY")) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const { kty, crv, x, y, d } = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  add("VAPID_KEY", JSON.stringify({ kty, crv, x, y, d }));
}
writeFileSync(file, vars);
console.log(added.length ? `Added ${added.join(", ")} to ${file}` : `Nothing to add to ${file}`);
