// Imports a Cloudflare D1 export into an environment's Cosmos DB database (docs/azure-migration.md, M4/M6).
//   npx wrangler d1 export ebay-autopilot-<env> --env <env> --remote --output=.d1-<env>.sql
//   npm run migrate:d1 -- sandbox .d1-sandbox.sql
//   $env:EBAY_CONFIRM_PRODUCTION='yes'; npm run migrate:d1 -- production .d1-production.sql      (K only)
//   npm run migrate:d1 -- sandbox .d1-sandbox.sql --dry-run    (into memory: checks the mapping, writes nothing)
// Writes with upserts, so it can be run again after an interruption. Then it verifies: documents per table,
// a field-by-field check of 20 random documents per container, and the old SQL metrics against the new
// metrics() on the imported data. Finally it writes a re-enrolment invite per person (passkeys are bound to
// the old address) to .owner-invite-<env>.txt, never to the screen.
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CosmosClient } from "@azure/cosmos";
import { AzureCliCredential } from "@azure/identity";
import { planImport, expectedCounts, type Rows } from "../src/store/migrate";
import { CosmosDocStore } from "../src/store/cosmos";
import { MemoryDocStore } from "../src/store/memory";
import type { DocStore } from "../src/store/doc";
import { makeStore } from "../src/store";
import { metrics } from "../src/api";
import { b64u } from "../src/push";
import type { Env } from "../src/env";
// @ts-ignore: plain JS helper
import { outputs } from "./azure-common.mjs";

const [env, file, flag] = process.argv.slice(2);
const dryRun = flag === "--dry-run";
if (!["sandbox", "production"].includes(env) || !file) {
  console.error("Usage: npm run migrate:d1 -- sandbox|production <d1-export.sql>");
  process.exit(2);
}
if (env === "production" && !dryRun && process.env.EBAY_CONFIRM_PRODUCTION !== "yes") {
  console.error("This writes to PRODUCTION. Run it yourself with EBAY_CONFIRM_PRODUCTION=yes set.");
  process.exit(2);
}

// 1. The D1 export, loaded into SQLite as it was.
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(file, "utf8"));
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all() as { name: string }[]).map((t) => t.name);
const rows: Rows = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all() as any[]]));
console.log(`Read ${file}: ${tables.map((t) => `${t} ${rows[t].length}`).join(", ")}`);

// 2. Plan and write.
const now = Date.now();
const { docs, notes } = await planImport(rows, now);
for (const n of notes) console.log(`  note: ${n}`);
const o = dryRun ? { publicUrl: "https://dry-run.example" } : outputs(env);
let target: DocStore;
if (dryRun) {
  target = new MemoryDocStore();
  console.log("  dry run: importing into memory");
} else {
  const client = new CosmosClient({ endpoint: o.cosmosEndpoint, aadCredentials: new AzureCliCredential(), connectionPolicy: { retryOptions: { maxRetryAttemptCount: 20, fixedRetryIntervalInMilliseconds: 0, maxWaitTimeInSeconds: 120 } } });
  target = new CosmosDocStore(client, `ebay-${env}`);
}
try {
  if (target instanceof CosmosDocStore) await target.check();
} catch (e) {
  console.error(`Can't reach ebay-${env}: ${e instanceof Error ? e.message : e}`);
  if (env === "production")
    console.error(`For the import, give yourself write access for an hour, then remove it (commands in docs/azure-migration.md, M6).`);
  process.exit(1);
}
let written = 0;
for (let i = 0; i < docs.length; i += 4) {
  await Promise.all(docs.slice(i, i + 4).map((d) => target.upsert(d.container, d.doc)));
  written = Math.min(docs.length, i + 4);
  if (written % 100 < 4) process.stdout.write(`\r  written ${written}/${docs.length}`);
}
console.log(`\r  written ${docs.length}/${docs.length} documents`);

// 3. Verify: every table in full, and 20 random documents per container field by field.
let problems = 0;
const fail = (msg: string) => (problems++, console.log(`  FAIL ${msg}`));
for (const [table, want, planned] of expectedCounts(rows, docs)) if (planned !== want) fail(`${table}: ${want} rows but ${planned} documents planned`);
const byContainer = new Map<string, typeof docs>();
for (const d of docs) byContainer.set(d.container, [...(byContainer.get(d.container) ?? []), d]);
for (const [c, ds] of byContainer) {
  const sample = [...ds].sort(() => Math.random() - 0.5).slice(0, 20);
  for (const d of sample) {
    const got = await target.get(d.container, d.doc.id, d.doc.pk);
    if (!got) fail(`${c}/${d.doc.id} missing`);
    else for (const [k, v] of Object.entries(d.doc)) if (k !== "ttl" && JSON.stringify(got[k]) !== JSON.stringify(v)) fail(`${c}/${d.doc.id}.${k} differs`);
  }
  console.log(`  ${c}: ${ds.length} documents, ${sample.length} checked`);
}

// 4. The old SQL metrics on the export against the new metrics() on the imported data.
const store = makeStore(target);
const newM = await metrics({ store } as Env);
const oldM = oldMetrics(db, now);
for (const k of ["listings", "sales", "spend", "proposals", "medianMinutesToDecide"] as const) {
  // Sums of money can differ in the last binary digit depending on the order they were added: compare to 1e-9.
  const round = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v));
  const a = round(oldM[k]);
  const b = round((newM as any)[k]);
  if (a !== b) fail(`metrics.${k} differs:\n    old ${a}\n    new ${b}`);
}
for (const k of ["items", "revenue", "fees"] as const) if (Math.abs((oldM.sold30 as any)[k] - (newM.sold30 as any)[k]) > 1e-9) fail(`metrics.sold30.${k} differs`);
console.log(problems ? `\n${problems} problem(s): fix and run again (it is safe to rerun).` : "\nVerified: every table, sampled documents and the metrics match.");

// 5. Re-enrolment invites (single use, 24 hours), one per person, written to a gitignored file.
if (!problems && !dryRun) {
  const lines: string[] = [];
  for (const u of await store.auth.listPeople(now).then((p) => p.people)) {
    const token = b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
    const hash = b64u.encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    await store.auth.createInvite({ token_hash: hash, name: u.name, role: u.role, created_by: "migration", created_at: now, expires_at: now + 24 * 3_600_000, used_at: null, reenrol_user_id: u.id });
    lines.push(`${u.name} (${u.role}): ${o.publicUrl}/join#${token}`);
  }
  writeFileSync(`.owner-invite-${env}.txt`, lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`Re-enrolment links for ${lines.length} people written to .owner-invite-${env}.txt (valid 24 hours, single use).`);
}
process.exitCode = problems ? 1 : 0;

/** The metrics SQL as it ran on D1 before the move (src/api.ts at 2026-11-03), for the comparison. */
function oldMetrics(d: DatabaseSync, at: number) {
  const DAY = 86_400_000;
  const since = at - 90 * DAY;
  const since30 = at - 30 * DAY;
  const all = (sql: string, ...args: any[]) => d.prepare(sql).all(...args) as any[];
  const listings = all(
    `SELECT date(s.taken_at / 1000, 'unixepoch') AS day, COUNT(*) AS active, SUM(s.price * MAX(s.quantity_available, 1)) AS asking, SUM(s.watch_count) AS watchers
     FROM listing_snapshots s WHERE s.taken_at >= ? AND s.taken_at = (SELECT MAX(taken_at) FROM listing_snapshots x WHERE date(x.taken_at / 1000, 'unixepoch') = date(s.taken_at / 1000, 'unixepoch'))
     GROUP BY day ORDER BY day`,
    since,
  ).map((r) => ({ ...r }));
  const sales = all(`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS orders, SUM(total) AS revenue, SUM(fees) AS fees FROM orders WHERE created_at >= ? GROUP BY day ORDER BY day`, since).map((r) => ({ ...r }));
  const spend = all(`SELECT date(at / 1000, 'unixepoch') AS day, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM claude_usage WHERE at >= ? GROUP BY day ORDER BY day`, since).map((r) => ({ ...r }));
  const sold30 = { ...(d.prepare(`SELECT COUNT(DISTINCT i.item_id) AS items, COALESCE(SUM(o.total), 0) AS revenue, COALESCE(SUM(o.fees), 0) AS fees FROM orders o JOIN order_items i ON i.order_id = o.order_id WHERE o.created_at >= ?`).get(since30) as any) };
  const proposals = Object.fromEntries(all("SELECT status, COUNT(*) AS n FROM proposals WHERE created_at >= ? GROUP BY status", since30).map((p) => [p.status, p.n]));
  const times = all("SELECT (decided_at - created_at) / 60000.0 AS mins FROM proposals WHERE decided_at IS NOT NULL AND status IN ('applied', 'approved', 'rejected', 'failed') AND created_at >= ? ORDER BY mins", since30);
  return { listings, sales, spend, sold30, proposals, medianMinutesToDecide: times.length ? times[Math.floor(times.length / 2)].mins : null };
}
