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

const health = await (await get("/health", { headers: { "X-Health-Key": vars.DASHBOARD_KEY ?? "" } })).json().catch(() => ({}));
// Since go-live (2026-11-07) production runs in approval mode: every eBay change still needs K's approval.
if (env === "production") check("A6  production runs in approval mode (or read-only)", health.ebayEnv === "production" && ["approval", "off"].includes(health.writeMode), JSON.stringify(health));
else check("A6  sandbox reports itself", health.ebayEnv === "sandbox", JSON.stringify(health));

// The site is hidden: without a session, everything is a blank Not found.
const blank = async (path, init) => {
  const r = await get(path, init);
  return r.status === 404 && (await r.text()) === "";
};
for (const p of ["/", "/settings", "/api/me", "/api/proposals", "/api/listings", "/api/people", "/health", "/oauth/start", "/s/not-the-real-address-0000"])
  check(`B1  ${p} shows strangers nothing`, await blank(p));
check("B1  a forged session cookie gets nothing", await blank("/api/me", { headers: { Cookie: "__Host-sid=forgedforgedforgedforgedforged" } }));
check("B2  posted requests get nothing either", await blank("/api/logout", { method: "POST", headers: { "X-EbayManager": "1", Origin: "https://evil.example" } }));
if (vars.SIGNIN_PATH) {
  const signin = await get(`/s/${vars.SIGNIN_PATH}`);
  const html = await signin.text();
  check("B3  the hidden sign-in page loads, with no script", signin.status === 200 && /one-time-code/.test(html) && !/<script/i.test(html));
  check("B3  it isn't indexed", /noindex/.test(signin.headers.get("x-robots-tag") ?? ""));
} else check("B3  SIGNIN_PATH is set (scripts/people.mjs)", false);

if (env === "production") {
  check("B7  /mcp is off", (await get("/mcp", { method: "POST" })).status === 404);
  const keyLogin = await get("/api/login", {
    method: "POST",
    headers: { "X-EbayManager": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ key: vars.DASHBOARD_KEY }),
  });
  check("B7  the key sign-in never works in production", keyLogin.status === 404 || keyLogin.status === 401);
}

const page = await get("/");
const csp = page.headers.get("content-security-policy") ?? "";
check("B8  CSP allows only the app's own origin", /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/https?:/.test(csp), csp);
check("B8  nosniff, no referrer, no framing", page.headers.get("x-content-type-options") === "nosniff" && page.headers.get("referrer-policy") === "no-referrer" && page.headers.get("x-frame-options") === "DENY");
check("B8  HSTS", /max-age=31536000/.test(page.headers.get("strict-transport-security") ?? ""));
const api = await get("/health");
check("B8  other responses carry the headers too", /default-src 'none'/.test(api.headers.get("content-security-policy") ?? "") && api.headers.get("x-frame-options") === "DENY");

// Azure settings (infra/modules/app.bicep).
const plain = await fetch(URL_.replace("https://", "http://") + "/health", { redirect: "manual" });
check("AZ  plain HTTP redirects to HTTPS", plain.status >= 301 && plain.status <= 308 && (plain.headers.get("location") ?? "").startsWith("https://"), String(plain.status));
check("AZ  the Functions host's /admin endpoints are closed", [401, 403, 404].includes((await get("/admin/host/status")).status));
// The site's settings come from `config show`: on Flex `functionapp show` leaves siteConfig empty, and newer
// CLIs (2.92) put httpsOnly under properties.
const site = {
  https: az(["functionapp", "show", "-g", o.resourceGroup, "-n", o.functionAppName, "--query", "httpsOnly || properties.httpsOnly"], { json: true }),
  ...az(["functionapp", "config", "show", "-g", o.resourceGroup, "-n", o.functionAppName, "--query", "{tls:minTlsVersion, ftps:ftpsState, cors:cors.allowedOrigins}"], { json: true }),
};
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
