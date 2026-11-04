// Creates or updates an environment's Azure resources from infra/main.bicep (docs/azure-migration.md).
//   node scripts/azure-infra.mjs sandbox                                   (Claude may run this)
//   $env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-infra.mjs production   (K only)
// AZURE_LOCATION picks the region (default francecentral); it must be one the subscription allows.
import { az, envArg, outputs } from "./azure-common.mjs";

const env = envArg();
const location = process.env.AZURE_LOCATION || "francecentral";
process.env.AZURE_LOCATION = location;
process.env.AZURE_OWNER_OBJECT_ID ||= az(["ad", "signed-in-user", "show", "--query", "id", "-o", "tsv"]);

console.log(`Deploying ${env} infrastructure to ${location} (subscription: ${az(["account", "show", "--query", "name", "-o", "tsv"])})...`);
az(["deployment", "sub", "create", "--name", `ebay-${env}`, "--location", location, "--template-file", "infra/main.bicep", "--parameters", `infra/${env}.bicepparam`], { quiet: true });
const o = outputs(env);
console.log(`Done.\n  App:        ${o.functionAppName}\n  Address:    ${o.publicUrl}\n  Key Vault:  ${o.keyVaultName}\n  Storage:    ${o.storageAccountName}\n  Cosmos DB:  ${o.cosmosAccount} (database ebay-${env})`);
console.log(`Next: node scripts/azure-secrets.mjs ${env}, then node scripts/azure-deploy.mjs ${env}`);
