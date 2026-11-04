// Builds and deploys the app to an environment's Function App (docs/azure-migration.md), replacing
// `wrangler deploy`. Signs in with Entra ID (basic-auth publishing is off).
//   node scripts/azure-deploy.mjs sandbox                                    (Claude may run this)
//   $env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-deploy.mjs production   (K only), then:
//   node scripts/check-production.mjs
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { makeZip } from "./make-zip.mjs";
import { az, envArg, outputs } from "./azure-common.mjs";

const env = envArg();
const o = outputs(env);

execSync("npm run typecheck && npm test", { stdio: "inherit" });
execSync("node scripts/build-azure.mjs", { stdio: "inherit" });

const zip = "dist/azure.zip";
rmSync(zip, { force: true });
// Built in Node, not with Compress-Archive or tar: Compress-Archive stores "web\\index.html" (a file name,
// not a folder, on the Linux host: every page but the API answered 500), and a PC's tar may be GNU tar,
// which can't write zips. Then refuse a package without the app or the dashboard.
const entries = makeZip("dist/azure", zip);
if (entries.some((e) => e.includes("\\")) || !entries.includes("index.js") || !entries.includes("web/index.html"))
  throw new Error(`The deployment zip looks wrong. First entries: ${entries.slice(0, 5).join(", ")}`);

console.log(`Deploying to ${o.functionAppName} (${env})...`);
az(["functionapp", "deployment", "source", "config-zip", "--resource-group", o.resourceGroup, "--name", o.functionAppName, "--src", zip], { quiet: true });
console.log(`Deployed. ${o.publicUrl}/health should show ${env}.`);
