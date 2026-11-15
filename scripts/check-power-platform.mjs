// Checks the Power Platform APIs on a deployed environment (docs/power-platform.md). It only reads: it never
// sends an item to the intake, and prints no key.
//   node scripts/check-power-platform.mjs              (sandbox; reads .dev.vars)
//   node scripts/check-power-platform.mjs production   (production; reads .prod.vars)
// Without the keys in the vars file it checks that both APIs are hidden (off).
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";

const env = process.argv[2] === "production" ? "production" : "sandbox";
const file = env === "production" ? ".prod.vars" : ".dev.vars";
const vars = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
const URL_ = process.env.PUBLIC_URL ?? `https://ebay-autopilot-${env}-wrpoyt.azurewebsites.net`;
console.log(`Checking ${env}: ${URL_}\n`);
let failed = 0;
const check = (id, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const get = (path, init = {}) => fetch(URL_ + path, { redirect: "manual", ...init });
const blank = async (path, init) => {
  const r = await get(path, init);
  return r.status === 404 && (await r.text()) === "";
};

// Hidden from everyone without the key.
check("P1  the read-only API shows strangers nothing", await blank("/api/ro/status"));
check("P1  a wrong key gets nothing", await blank("/api/ro/status", { headers: { "X-Api-Key": "x".repeat(43) } }));
check("P1  the intake shows strangers nothing", await blank("/api/intake/drafts", { method: "POST", body: "{}" }));
check("P1  a wrong intake key gets nothing", await blank("/api/intake/drafts", { method: "POST", body: "{}", headers: { "X-Api-Key": "x".repeat(43) } }));

const key = vars.RO_API_KEY;
if (!key) {
  console.log(`\nRO_API_KEY isn't in ${file}: the read-only API should be off, which the checks above cover.`);
} else {
  const ro = (path, init = {}) => get(`/api/ro${path}`, { ...init, headers: { "X-Api-Key": key, ...(init.headers ?? {}) } });
  const status = await (await ro("/status")).json().catch(() => ({}));
  check("P2  the read-only key reads the status", status.read_only === true && status.environment === env, JSON.stringify(status));
  for (const method of ["POST", "PUT", "DELETE"]) check(`P3  ${method} is refused`, (await ro("/proposals", { method })).status === 405);
  check("P4  the key doesn't open the dashboard API", await blank("/api/me", { headers: { "X-Api-Key": key } }));
  check("P4  the key doesn't open the intake", await blank("/api/intake/drafts", { method: "POST", body: "{}", headers: { "X-Api-Key": key } }));
  for (const p of ["/listings", "/sales", "/proposals", "/proposals/waiting", "/pricing", "/pricing-accuracy", "/health-flags", "/spend", "/digest"]) {
    const r = await ro(p);
    check(`P5  ${p} answers`, r.status === 200, String(r.status));
  }
  const waiting = await (await ro("/proposals/waiting")).json().catch(() => ({ items: [] }));
  if (env === "sandbox") check("P6  on Sandbox nothing waiting carries a signed link", (waiting.items ?? []).every((w) => w.approve_url === null && w.reject_url === null));
  const csv = await ro("/export/sales.csv");
  const head = (await csv.text()).split("\r\n")[0];
  check("P7  the sales export is a CSV with its columns", csv.headers.get("content-type")?.startsWith("text/csv") && head.startsWith("sale_id,sold_at,item_id"), `exported ${csv.headers.get("x-exported-at")}`);
  const tools = await (await ro("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json().catch(() => ({}));
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  check("P8  the agent's tools only read", names.length === 9 && !names.some((n) => /propos|approv|reject|pause|set_|write|create|send/.test(n)), names.join(", "));
}

console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
