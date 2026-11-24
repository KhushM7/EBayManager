// What the app has been doing, for diagnosis: its own events (Cosmos, the jobs container) and Azure's warnings and
// errors together, oldest first, then how full the log workspace is. Read-only; signs in as whoever ran az login.
//   node scripts/logs.mjs production --since 24h --errors
//   node scripts/logs.mjs sandbox --item 123456789012      (or --run <invocation id>)
import { CosmosClient } from "@azure/cosmos";
import { AzureCliCredential } from "@azure/identity";
import { redact } from "../src/redact.ts"; // Node 22.18+ reads TypeScript
import { az, outputs } from "./azure-common.mjs";

const [env, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? null : rest[i + 1];
};
const since = /^(\d+)([hd])$/.exec(opt("since") ?? "24h");
const id = /^[\w-]{1,64}$/;
const item = opt("item");
const run = opt("run");
if (!["sandbox", "production"].includes(env) || !since || (item !== null && !id.test(item ?? "")) || (run !== null && !id.test(run ?? ""))) {
  console.error("Usage: node scripts/logs.mjs sandbox|production [--since 24h|7d] [--errors] [--item id] [--run id]");
  process.exit(2);
}
const hours = Number(since[1]) * (since[2] === "d" ? 24 : 1);
const errorsOnly = rest.includes("--errors");
const from = Date.now() - hours * 3_600_000;
const o = outputs(env);
const credential = new AzureCliCredential();

// Platform noise that isn't the app's: eBay hanging up early, and the host's own shutdown.
const PLATFORM = ["Unexpected end of request content", "request stream was aborted", "HTTP/2 connection faulted", "the request is complete", "EventStream", "WorkerTerminate", "ContainerAlreadyExists", "BadHttpRequestException", "Process reporting unhealthy", "Executed 'Functions.app' (Failed"];

const rows = [];
const client = new CosmosClient({ endpoint: o.cosmosEndpoint, aadCredentials: credential });
const { resources } = await client
  .database(`ebay-${env}`)
  .container("jobs")
  .items.query({
    query:
      "SELECT * FROM c WHERE c.type = 'event' AND c.created_at >= @from" +
      (errorsOnly ? " AND c.status IN ('warn', 'error')" : "") +
      (item ? " AND c.item_id = @item" : "") +
      (run ? " AND c.run_id = @run" : ""),
    parameters: [{ name: "@from", value: from }, ...(item ? [{ name: "@item", value: item }] : []), ...(run ? [{ name: "@run", value: run }] : [])],
  })
  .fetchAll();
for (const e of resources)
  rows.push({ at: e.created_at, level: e.status, src: "app", text: [e.kind, e.item_id && `item ${e.item_id}`, e.ms != null && `${e.ms} ms`, e.detail].filter(Boolean).join("  ") });

const workspace = o.functionAppName.replace("ebay-autopilot", "log-ebay");
const ws = az(["monitor", "log-analytics", "workspace", "show", "-g", o.resourceGroup, "-n", workspace, "--query", "{id:customerId, cap:workspaceCapping}"], { json: true });
const { token } = await credential.getToken("https://api.loganalytics.io/.default");
async function kql(query) {
  const r = await fetch(`https://api.loganalytics.io/v1/workspaces/${ws.id}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!j.tables) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j.tables[0].rows;
}
if (!item) {
  const skip = PLATFORM.map((p) => `| where Text !has ${JSON.stringify(p)}`).join(" ");
  // The app's own lines ({"ev":…) are skipped: the events above are the same, in full.
  const query =
    `union (AppExceptions | project TimeGenerated, Level = toint(3), Text = strcat(ProblemId, ": ", OuterMessage), OperationId), ` +
    `(AppTraces | where SeverityLevel >= 2 | project TimeGenerated, Level = toint(SeverityLevel), Text = Message, OperationId) ` +
    `| where TimeGenerated > ago(${hours}h) | where Text !startswith '{"ev":' ${run ? `| where OperationId == "${run}"` : ""} ${skip} | top 300 by TimeGenerated | project TimeGenerated, Level, Text`;
  for (const [t, level, text] of await kql(query)) rows.push({ at: Date.parse(t), level: level >= 3 ? "error" : "warn", src: "azure", text: redact(String(text).replace(/\s+/g, " "), 400) });
}

rows.sort((a, b) => a.at - b.at);
for (const r of rows) console.log(`${new Date(r.at).toISOString().slice(0, 19)}  ${r.level.padEnd(5)}  ${r.src.padEnd(5)}  ${r.text}`);
console.log(`\n${rows.length} entries in the last ${hours} hours.`);
const [[gb] = [0]] = await kql("Usage | where TimeGenerated > startofmonth(now()) and IsBillable == true | summarize sum(Quantity) / 1000");
console.log(`Azure logs: ${ws.cap?.dataIngestionStatus} (cap ${ws.cap?.dailyQuotaGb} GB a day, resets ${ws.cap?.quotaNextResetTime}). This workspace used ${Number(gb ?? 0).toFixed(2)} GB this month; the free 5 GB is shared with the other environment.`);
if (ws.cap?.dataIngestionStatus === "OverQuota") console.log("Azure is dropping log lines until it resets. The app's own events above are complete.");
