// Adds any missing app secrets to a vars file without printing them. Existing values are kept.
//   node scripts/make-keys.mjs              -> .dev.vars (Sandbox)
//   node scripts/make-keys.mjs .prod.vars   -> production
//   node scripts/make-keys.mjs --power-platform [.prod.vars]   adds only the two Power Platform keys, which
//     turn on the read-only API and the Stock Room intake once uploaded (docs/power-platform.md). Nothing else
//     is added: a new EBAY_DELETION_TOKEN or IMAGEAI_KEY uploaded over the vault's would break eBay's deletion
//     check or the photo AI container.
// Then upload with: node scripts/azure-secrets.mjs sandbox|production. People: node scripts/people.mjs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, webcrypto } from "node:crypto";

const args = process.argv.slice(2);
const powerPlatform = args.includes("--power-platform");
const file = args.find((a) => !a.startsWith("--")) ?? ".dev.vars";
let vars = existsSync(file) ? readFileSync(file, "utf8") : "";
if (vars && !vars.endsWith("\n")) vars += "\n";
// A key counts as present only with a value, so an empty line copied from .dev.vars.example is filled in.
const has = (k) => new RegExp(`^${k}=\\S`, "m").test(vars);
const added = [];
const add = (k, v) => {
  if (has(k)) return;
  const empty = new RegExp(`^${k}=[ \\t]*$`, "m");
  vars = empty.test(vars) ? vars.replace(empty, () => `${k}=${v}`) : vars + `${k}=${v}\n`;
  added.push(k);
};

if (powerPlatform) {
  add("RO_API_KEY", randomBytes(32).toString("base64url"));
  add("INTAKE_API_KEY", randomBytes(32).toString("base64url"));
} else {
  add("SIGNING_KEY", randomBytes(48).toString("base64url"));
  // K's operations key: reads /health (and, on Sandbox only, a test sign-in).
  add("DASHBOARD_KEY", randomBytes(24).toString("base64url"));
  // eBay accepts 32 to 80 characters: letters, digits, underscore and hyphen.
  add("EBAY_DELETION_TOKEN", randomBytes(36).toString("base64url"));
  // The photo AI container shares this key with the app (docs/imageai.md).
  add("IMAGEAI_KEY", randomBytes(32).toString("base64url"));
  if (!has("VAPID_KEY")) {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const { kty, crv, x, y, d } = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
    add("VAPID_KEY", JSON.stringify({ kty, crv, x, y, d }));
  }
}
writeFileSync(file, vars);
console.log(added.length ? `Added ${added.join(", ")} to ${file}` : `Nothing to add to ${file}`);
