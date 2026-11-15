// One-time set-up so GitHub Actions can deploy an environment (.github/workflows/deploy.yml) without a stored
// password. K runs it, once per environment, signed in to Azure (Azure Cloud Shell in a browser works):
//   node scripts/azure-github-oidc.mjs sandbox
//   EBAY_CONFIRM_PRODUCTION=yes node scripts/azure-github-oidc.mjs production
//
// It makes an Azure identity (an app registration) that only GitHub's "<environment>" environment of this
// repository can sign in as, and lets it publish to that environment's Function App and nothing else
// (Website Contributor on the app: no secrets, no database, no other resources). Then it prints the five
// values to enter as that GitHub environment's variables. Nothing here is a secret.
import { az, envArg, outputs } from "./azure-common.mjs";

const REPO = process.env.GITHUB_REPOSITORY || "KhushM7/EBayManager";
const env = envArg();
const o = outputs(env);
const name = `ebay-github-deploy-${env}`;

const account = az(["account", "show"], { json: true });
let appId = az(["ad", "app", "list", "--display-name", name, "--query", "[0].appId", "-o", "tsv"]).trim();
if (!appId) appId = az(["ad", "app", "create", "--display-name", name, "--query", "appId", "-o", "tsv"]).trim();
let spId = az(["ad", "sp", "list", "--filter", `appId eq '${appId}'`, "--query", "[0].id", "-o", "tsv"]).trim();
if (!spId) spId = az(["ad", "sp", "create", "--id", appId, "--query", "id", "-o", "tsv"]).trim();

// Only this repository's GitHub environment of the same name may sign in as it. GitHub names the repository in
// its token either by name or by name and permanent id ("KhushM7@124626664/EBayManager@1415007865": the first
// deploy run on 2026-11-15 was refused because only the plain form was registered), so both are registered.
const REPO_WITH_IDS = process.env.GITHUB_REPOSITORY_WITH_IDS || "KhushM7@124626664/EBayManager@1415007865";
const subjects = [
  [`github-${env}`, `repo:${REPO}:environment:${env}`],
  [`github-${env}-ids`, `repo:${REPO_WITH_IDS}:environment:${env}`],
];
const registered = az(["ad", "app", "federated-credential", "list", "--id", appId, "--query", "[].subject", "-o", "tsv"]).split(/\r?\n/).map((x) => x.trim());
for (const [credential, subject] of subjects)
  if (!registered.includes(subject))
    az(["ad", "app", "federated-credential", "create", "--id", appId, "--parameters", JSON.stringify({ name: credential, issuer: "https://token.actions.githubusercontent.com", subject, audiences: ["api://AzureADTokenExchange"] })], { quiet: true });

// Publish to this one Function App only.
const scope = `/subscriptions/${account.id}/resourceGroups/${o.resourceGroup}/providers/Microsoft.Web/sites/${o.functionAppName}`;
az(["role", "assignment", "create", "--assignee-object-id", spId, "--assignee-principal-type", "ServicePrincipal", "--role", "Website Contributor", "--scope", scope], { quiet: true });

console.log(`\nDone. In GitHub: Settings -> Environments -> "${env}" (create it) -> Environment variables, add:\n`);
console.log(`  AZURE_CLIENT_ID         ${appId}`);
console.log(`  AZURE_TENANT_ID         ${account.tenantId}`);
console.log(`  AZURE_SUBSCRIPTION_ID   ${account.id}`);
console.log(`  AZURE_RESOURCE_GROUP    ${o.resourceGroup}`);
console.log(`  AZURE_FUNCTIONAPP_NAME  ${o.functionAppName}`);
if (env === "production") console.log(`\nThen, on the same page: tick "Required reviewers", add yourself, and under "Deployment branches and tags" allow only main.`);
