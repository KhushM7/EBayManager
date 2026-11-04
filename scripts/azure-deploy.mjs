// Builds and deploys the app to an environment's Function App (docs/azure-migration.md), replacing
// `wrangler deploy`. Signs in with Entra ID (basic-auth publishing is off).
//   node scripts/azure-deploy.mjs sandbox                                    (Claude may run this)
//   $env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-deploy.mjs production   (K only), then:
//   node scripts/check-production.mjs
import { execSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { az, envArg, outputs } from "./azure-common.mjs";

const env = envArg();
const o = outputs(env);

execSync("npm run typecheck && npm test", { stdio: "inherit" });
execSync("node scripts/build-azure.mjs", { stdio: "inherit" });

const zip = "dist/azure.zip";
rmSync(zip, { force: true });
const r =
  process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path dist/azure/* -DestinationPath ${zip} -Force`], { stdio: "inherit" })
    : spawnSync("sh", ["-c", `cd dist/azure && zip -qr ../azure.zip .`], { stdio: "inherit" });
if (r.status !== 0) throw new Error("Couldn't make the deployment zip");

console.log(`Deploying to ${o.functionAppName} (${env})...`);
az(["functionapp", "deployment", "source", "config-zip", "--resource-group", o.resourceGroup, "--name", o.functionAppName, "--src", zip], { quiet: true });
console.log(`Deployed. ${o.publicUrl}/health should show ${env}.`);
