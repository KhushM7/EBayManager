// Remote go-live checks against a deployed environment (docs/go-live-tests.md, sections A, B and C, plus the
// Azure settings from docs/azure-migration.md). Read-only: it signs nobody in and changes nothing.
//   node scripts/check-production.mjs              (production; reads .prod.vars)
//   node scripts/check-production.mjs sandbox      (sandbox; reads .dev.vars)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { az, outputs } from "./azure-common.mjs";

const env = process.argv[2] === "sandbox" ? "sandbox" : "production";
const o = outputs(env);
const URL_ = o.publicUrl;
const vars = parseEnv(readFileSync(env === "production" ? ".prod.vars" : ".dev.vars", "utf8"));
console.log(`Checking ${env}: ${URL_}\n`);
let failed = 0;
const check = (id, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const get = (path, init = {}) => fetch(URL_ + path, { redirect: "manual", ...init });

const health = await (await get("/health")).json();
if (env === "production") check("A6  production runs with writes off", health.ebayEnv === "production" && health.writeMode === "off", JSON.stringify(health));
else check("A6  sandbox reports itself", health.ebayEnv === "sandbox", JSON.stringify(health));

for (const p of ["/api/me", "/api/proposals", "/api/listings", "/api/activity", "/api/people", "/api/usage"])
  check(`B1  ${p} needs a session`, (await get(p)).status === 401);
check("B1  a forged session cookie is refused", (await get("/api/me", { headers: { Cookie: "__Host-sid=forgedforgedforgedforgedforged" } })).status === 401);

check("B2  state changes need the custom header", (await get("/api/logout", { method: "POST" })).status === 403);
check("B2  cross-site requests are refused", (await get("/api/auth/login/options", { method: "POST", headers: { "X-EbayManager": "1", Origin: "https://evil.example" } })).status === 403);

if (env === "production") {
  check("B7  /mcp is off", (await get("/mcp", { method: "POST" })).status === 404);
  const keyLogin = await get("/api/login", {
    method: "POST",
    headers: { "X-EbayManager": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ key: vars.DASHBOARD_KEY }),
  });
  check("B7  the key sign-in never works in production", keyLogin.status === 401);
}
check("B7  connecting eBay needs the owner's session", (await get("/oauth/start")).status === 401);

const page = await get("/");
const csp = page.headers.get("content-security-policy") ?? "";
check("B8  CSP allows only the app's own origin", /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/https?:/.test(csp), csp);
check("B8  nosniff, no referrer, no framing", page.headers.get("x-content-type-options") === "nosniff" && page.headers.get("referrer-policy") === "no-referrer" && page.headers.get("x-frame-options") === "DENY");
check("B8  HSTS", /max-age=31536000/.test(page.headers.get("strict-transport-security") ?? ""));
const api = await get("/api/me");
check("B8  API responses carry the headers too", /default-src 'none'/.test(api.headers.get("content-security-policy") ?? "") && api.headers.get("x-frame-options") === "DENY");

// Azure settings (infra/modules/app.bicep).
const plain = await fetch(URL_.replace("https://", "http://") + "/health", { redirect: "manual" });
check("AZ  plain HTTP redirects to HTTPS", plain.status >= 301 && plain.status <= 308 && (plain.headers.get("location") ?? "").startsWith("https://"), String(plain.status));
check("AZ  the Functions host's /admin endpoints are closed", [401, 403, 404].includes((await get("/admin/host/status")).status));
const site = az(["functionapp", "show", "-g", o.resourceGroup, "-n", o.functionAppName, "--query", "{https:httpsOnly, tls:siteConfig.minTlsVersion, ftps:siteConfig.ftpsState, cors:siteConfig.cors.allowedOrigins}"], { json: true });
check("AZ  HTTPS only, TLS 1.2+, no FTP, no CORS", site.https === true && site.tls === "1.2" && site.ftps === "Disabled" && (site.cors ?? []).length === 0, JSON.stringify(site));
for (const kind of ["ftp", "scm"]) {
  const allow = az(["resource", "show", "-g", o.resourceGroup, "--namespace", "Microsoft.Web", "--resource-type", "basicPublishingCredentialsPolicies", "--parent", `sites/${o.functionAppName}`, "-n", kind, "--query", "properties.allow"], { json: true });
  check(`AZ  ${kind.toUpperCase()} basic-auth publishing is off`, allow === false);
}
const cosmos = az(["cosmosdb", "show", "-g", "rg-ebay-shared", "-n", o.cosmosAccount, "--query", "{local:disableLocalAuth, free:enableFreeTier, tls:minimalTlsVersion}"], { json: true });
check("AZ  Cosmos DB: keys disabled, free tier, TLS 1.2", cosmos.local === true && cosmos.free === true && cosmos.tls === "Tls12", JSON.stringify(cosmos));

const code = "go-live-check";
const res = await (await get(`/ebay/account-deletion?challenge_code=${code}`)).json().catch(() => ({}));
if (vars.EBAY_DELETION_TOKEN) {
  const expected = createHash("sha256").update(code + vars.EBAY_DELETION_TOKEN + `${URL_}/ebay/account-deletion`).digest("hex");
  check("C6  account deletion endpoint answers eBay's challenge", res.challengeResponse === expected);
  check("C6  unsigned deletion notifications are refused", (await get("/ebay/account-deletion", { method: "POST", body: "{}" })).status === 412);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exitCode = failed ? 1 : 0;
