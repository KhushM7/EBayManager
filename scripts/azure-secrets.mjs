// Uploads an environment's secrets to its Key Vault (docs/azure-migration.md), replacing `wrangler secret
// bulk`. Sandbox reads .dev.vars, production reads .prod.vars (both gitignored). Each value goes to Key Vault
// through a private temporary file that is deleted at once; nothing is printed except key names.
//   node scripts/azure-secrets.mjs sandbox
//   $env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-secrets.mjs production   (K only)
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { az, envArg, outputs } from "./azure-common.mjs";

const SECRETS = ["EBAY_APP_ID", "EBAY_CERT_ID", "EBAY_DEV_ID", "EBAY_RUNAME", "EBAY_COMPS_APP_ID", "EBAY_COMPS_CERT_ID", "DASHBOARD_KEY", "VAPID_KEY", "ANTHROPIC_API_KEY", "EBAY_DELETION_TOKEN", "TRAWL_API_KEY", "COMPSAPI_KEY", "PARCEL2GO_CLIENT_ID", "PARCEL2GO_CLIENT_SECRET", "MCP_TOKEN", "SIGNING_KEY", "NTFY_TOPIC", "PEOPLE", "SIGNIN_PATH"];

const env = envArg();
const file = env === "production" ? ".prod.vars" : ".dev.vars";
const vars = parseEnv(readFileSync(file, "utf8"));
const vault = outputs(env).keyVaultName;
const dir = mkdtempSync(join(tmpdir(), "kv-"));
const uploaded = [];
try {
  for (const key of SECRETS) {
    const value = vars[key];
    if (!value) continue;
    const tmp = join(dir, "v");
    writeFileSync(tmp, value, { mode: 0o600 });
    try {
      az(["keyvault", "secret", "set", "--vault-name", vault, "--name", key.replace(/_/g, "-"), "--file", tmp, "--encoding", "utf-8", "--query", "id", "-o", "none"], { quiet: true });
    } finally {
      rmSync(tmp, { force: true });
    }
    uploaded.push(key);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const unknown = Object.keys(vars).filter((k) => !SECRETS.includes(k));
console.log(`Uploaded to ${vault}: ${uploaded.join(", ") || "nothing"}`);
if (unknown.length) console.log(`Not secrets, left out: ${unknown.join(", ")}`);
const missing = SECRETS.filter((k) => !vars[k]);
if (missing.length) console.log(`Not in ${file} (the app treats them as unset): ${missing.join(", ")}`);
console.log(`Azure caches secret values for up to 24 hours. To apply them now on every copy of the app: node scripts/people.mjs ${env} refresh`);
