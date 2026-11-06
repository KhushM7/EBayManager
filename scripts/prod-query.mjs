// Read-only diagnosis of an environment's database (docs/azure-migration.md), replacing
// `wrangler d1 execute --command "SELECT ..."`. Signs in as whoever ran az login; on production that
// identity has only the Cosmos DB Built-in Data Reader role, so this can't change anything there even by
// mistake. It only ever calls the query API.
//   node scripts/prod-query.mjs production proposals "SELECT c.id, c.status FROM c WHERE c.type = 'proposal'"
import { CosmosClient } from "@azure/cosmos";
import { AzureCliCredential } from "@azure/identity";
import { outputs } from "./azure-common.mjs";

const [env, container, sql] = process.argv.slice(2);
if (!["sandbox", "production"].includes(env) || !container || !sql || !/^\s*SELECT\b/i.test(sql)) {
  console.error('Usage: node scripts/prod-query.mjs sandbox|production <container> "SELECT ... FROM c ..."');
  process.exit(2);
}
const o = outputs(env);
const client = new CosmosClient({ endpoint: o.cosmosEndpoint, aadCredentials: new AzureCliCredential() });
const { resources, requestCharge } = await client.database(`ebay-${env}`).container(container).items.query(sql).fetchAll();
console.log(JSON.stringify(resources, null, 2));
console.error(`${resources.length} rows, ${requestCharge?.toFixed?.(1) ?? "?"} RU`);
