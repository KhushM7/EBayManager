// Remote go-live checks against the production Worker (docs/go-live-tests.md, sections B and C). Read-only:
// it signs nobody in and changes nothing. Run: node scripts/check-production.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const URL_ = "https://ebay-autopilot-production.ebay-autopilot.workers.dev";
const vars = parseEnv(readFileSync(".prod.vars", "utf8"));
let failed = 0;
const check = (id, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const get = (path, init = {}) => fetch(URL_ + path, { redirect: "manual", ...init });

const health = await (await get("/health")).json();
check("A6  production runs with writes off", health.ebayEnv === "production" && health.writeMode === "off", JSON.stringify(health));

for (const p of ["/api/me", "/api/proposals", "/api/listings", "/api/activity", "/api/people", "/api/usage"])
  check(`B1  ${p} needs a session`, (await get(p)).status === 401);
check("B1  a forged session cookie is refused", (await get("/api/me", { headers: { Cookie: "__Host-sid=forgedforgedforgedforgedforged" } })).status === 401);

check("B2  state changes need the custom header", (await get("/api/logout", { method: "POST" })).status === 403);
check("B2  cross-site requests are refused", (await get("/api/auth/login/options", { method: "POST", headers: { "X-EbayManager": "1", Origin: "https://evil.example" } })).status === 403);

check("B7  /mcp is off", (await get("/mcp", { method: "POST" })).status === 404);
check("B7  connecting eBay needs the owner's session", (await get("/oauth/start")).status === 401);
const keyLogin = await get("/api/login", {
  method: "POST",
  headers: { "X-EbayManager": "1", "Content-Type": "application/json" },
  body: JSON.stringify({ key: vars.DASHBOARD_KEY }),
});
check("B7  the key sign-in never works in production", keyLogin.status === 401);

const page = await get("/");
const csp = page.headers.get("content-security-policy") ?? "";
check("B8  CSP allows only the app's own origin", /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/https:/.test(csp), csp);
check("B8  nosniff and no referrer", page.headers.get("x-content-type-options") === "nosniff" && page.headers.get("referrer-policy") === "no-referrer");

const code = "go-live-check";
const res = await (await get(`/ebay/account-deletion?challenge_code=${code}`)).json();
const expected = createHash("sha256").update(code + vars.EBAY_DELETION_TOKEN + `${URL_}/ebay/account-deletion`).digest("hex");
check("C6  account deletion endpoint answers eBay's challenge", res.challengeResponse === expected);
check("C6  unsigned deletion notifications are refused", (await get("/ebay/account-deletion", { method: "POST", body: "{}" })).status === 412);

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exitCode = failed ? 1 : 0;
