// Records, as History events, what happened to suggestions made before events existed (docs/approvals.md, "History").
// Dry run unless --write; running it twice adds nothing.
//   node scripts/backfill-history.mjs sandbox|production [--write]
// Production is K's: --write there refuses without EBAY_CONFIRM_PRODUCTION=yes, and needs a login that may write
// to Cosmos (K's usual one only reads production).
import { CosmosClient } from "@azure/cosmos";
import { AzureCliCredential } from "@azure/identity";
import { outputs } from "./azure-common.mjs";
import { planAdvice, planProposals, planTodos } from "./backfill-plan.mjs";

const env = process.argv[2];
const write = process.argv.includes("--write");
if (!["sandbox", "production"].includes(env)) {
  console.error("Usage: node scripts/backfill-history.mjs sandbox|production [--write]");
  process.exit(2);
}
if (write && env === "production" && process.env.EBAY_CONFIRM_PRODUCTION !== "yes") {
  console.error("This writes to PRODUCTION. Run it yourself with EBAY_CONFIRM_PRODUCTION=yes set.");
  process.exit(2);
}
const db = new CosmosClient({ endpoint: outputs(env).cosmosEndpoint, aadCredentials: new AzureCliCredential() }).database(`ebay-${env}`);
const read = async (container, type) =>
  (await db.container(container).items.query({ query: "SELECT * FROM c WHERE c.type = @t", parameters: [{ name: "@t", value: type }] }).fetchAll()).resources;
const known = async (container) => new Set((await read(container, "suggestion_event")).map((e) => `${e.suggestion_id}:${e.event}`));

const plans = [
  ["proposals", planProposals(await read("proposals", "proposal"), await known("proposals"))],
  ["pricing", planTodos(await read("pricing", "todo"), await known("pricing"))],
  ["pricing", planAdvice(await read("pricing", "bundle_advice"), await known("pricing"))],
];
for (const [name, plan] of plans) {
  console.log(`${name}: ${plan.events.length} events, ${plan.patches.length} reasons to add`);
  if (!write) continue;
  const c = db.container(name);
  for (const e of plan.events)
    await c.items.create(e).catch((x) => {
      if (Number(x.code) !== 409) throw x;
    });
  for (const p of plan.patches) {
    const operations = Object.entries(p.set).map(([k, value]) => ({ op: "set", path: `/${k}`, value }));
    const condition = "FROM c WHERE c.status = 'expired' AND (NOT IS_DEFINED(c.closed_reason) OR IS_NULL(c.closed_reason))";
    await c
      .item(p.id, p.pk)
      .patch({ operations, condition })
      .catch((x) => {
        if (Number(x.code) !== 412) throw x;
      });
  }
}
if (!write) console.log("Dry run: nothing written. Add --write to write.");
