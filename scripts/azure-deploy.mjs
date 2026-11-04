// Builds and deploys the app to an environment's Function App (docs/azure-migration.md), replacing
// `wrangler deploy`. Signs in with Entra ID (basic-auth publishing is off).
//   node scripts/azure-deploy.mjs sandbox                                    (Claude may run this)
//   $env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-deploy.mjs production   (K only), then:
//   node scripts/check-production.mjs
import { execSync, spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { az, envArg, outputs } from "./azure-common.mjs";

const env = envArg();
const o = outputs(env);

execSync("npm run typecheck && npm test", { stdio: "inherit" });
execSync("node scripts/build-azure.mjs", { stdio: "inherit" });

const zip = "dist/azure.zip";
rmSync(zip, { force: true });
// Windows: tar.exe (bsdtar, built into Windows 10+), not Compress-Archive, which stores paths with
// backslashes ("web\\index.html"); on the Linux host that is a file name, not a folder, so the dashboard
// files go missing and every page but the API answers 500.
const r =
  process.platform === "win32"
    ? spawnSync("tar.exe", ["-a", "-c", "-f", "../azure.zip", ...readdirSync("dist/azure")], { cwd: "dist/azure", stdio: "inherit" })
    : spawnSync("sh", ["-c", `cd dist/azure && zip -qr ../azure.zip .`], { stdio: "inherit" });
if (r.status !== 0) throw new Error("Couldn't make the deployment zip");
// Refuse a package whose paths the Linux host can't use, or that lacks the app or the dashboard.
const listing = spawnSync(process.platform === "win32" ? "tar.exe" : "unzip", process.platform === "win32" ? ["-tf", zip] : ["-Z1", zip], { encoding: "utf8" });
const entries = (listing.stdout || "").split(/\r?\n/).filter(Boolean);
if (listing.status !== 0 || entries.some((e) => e.includes("\\")) || !entries.includes("index.js") || !entries.some((e) => /^(\.\/)?web\/index\.html$/.test(e)))
  throw new Error(`The deployment zip looks wrong (backslash paths, or no index.js / web/index.html). First entries: ${entries.slice(0, 5).join(", ")}`);

console.log(`Deploying to ${o.functionAppName} (${env})...`);
az(["functionapp", "deployment", "source", "config-zip", "--resource-group", o.resourceGroup, "--name", o.functionAppName, "--src", zip], { quiet: true });
console.log(`Deployed. ${o.publicUrl}/health should show ${env}.`);
