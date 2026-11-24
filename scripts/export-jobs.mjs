// Saves background job results before they expire (30 days) to exports/, which git ignores: they describe K's real
// listings, so never commit them. Reads only.
//   node scripts/export-jobs.mjs sandbox|production
import { mkdirSync, writeFileSync } from "node:fs";
import { CosmosClient } from "@azure/cosmos";
import { AzureCliCredential } from "@azure/identity";
import { outputs } from "./azure-common.mjs";

const env = process.argv[2];
if (!["sandbox", "production"].includes(env)) {
  console.error("Usage: node scripts/export-jobs.mjs sandbox|production");
  process.exit(2);
}
const db = new CosmosClient({ endpoint: outputs(env).cosmosEndpoint, aadCredentials: new AzureCliCredential() }).database(`ebay-${env}`);
const sql = "SELECT c.id, c.kind, c.status, c.args, c.created_at, c.updated_at, c.result, c.error FROM c WHERE c.type = 'job'";
const { resources } = await db.container("jobs").items.query(sql, { partitionKey: "queue" }).fetchAll();
mkdirSync("exports", { recursive: true });
const file = `exports/jobs-${env}-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(resources, null, 2));
console.log(`${resources.length} jobs saved to ${file}`);
