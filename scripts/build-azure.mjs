// Builds the Azure Functions package (docs/azure-migration.md): the web app (web/dist), the function code
// bundled into one file, host.json and a minimal package.json, in dist/azure. scripts/azure-deploy.mjs zips
// and deploys that folder. No secrets are read or written here.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const out = "dist/azure";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

execSync("npx vite build web", { stdio: "inherit" });
cpSync("web/dist", `${out}/web`, { recursive: true });

await build({
  entryPoints: ["src/platform/azure/functions.ts"],
  outfile: `${out}/index.js`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // Provided by the Functions host at run time.
  external: ["@azure/functions-core"],
  logLevel: "info",
});

cpSync("host.json", `${out}/host.json`);
writeFileSync(`${out}/package.json`, JSON.stringify({ name: "ebay-autopilot", private: true, main: "index.js", type: "commonjs" }, null, 2));
console.log(`Built ${out}`);
