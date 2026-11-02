// Adds any missing app secrets to .dev.vars without printing them: DASHBOARD_KEY (K's sign-in key)
// and VAPID_KEY (Web Push key pair as a P-256 private JWK). Existing values are kept.
// Then upload with: npx wrangler secret bulk .dev.vars --env sandbox
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes, webcrypto } from "node:crypto";

let vars = readFileSync(".dev.vars", "utf8");
if (!vars.endsWith("\n")) vars += "\n";
const has = (k) => new RegExp(`^${k}=`, "m").test(vars);
const added = [];

if (!has("DASHBOARD_KEY")) {
  vars += `DASHBOARD_KEY=${randomBytes(24).toString("base64url")}\n`;
  added.push("DASHBOARD_KEY");
}
if (!has("VAPID_KEY")) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const { kty, crv, x, y, d } = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  vars += `VAPID_KEY=${JSON.stringify({ kty, crv, x, y, d })}\n`;
  added.push("VAPID_KEY");
}
writeFileSync(".dev.vars", vars);
console.log(added.length ? `Added ${added.join(", ")} to .dev.vars` : "Nothing to add");
