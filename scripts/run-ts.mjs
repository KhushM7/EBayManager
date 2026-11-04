// Runs a TypeScript script by bundling it with esbuild first (no extra runtime needed).
//   node scripts/run-ts.mjs scripts/<name>.ts [args...]
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const [entry, ...args] = process.argv.slice(2);
mkdirSync("dist/scripts", { recursive: true });
const out = `dist/scripts/${entry.split(/[\/]/).pop().replace(/\.ts$/, ".mjs")}`;
await build({ entryPoints: [entry], outfile: out, bundle: true, platform: "node", target: "node22", format: "esm", packages: "external", logLevel: "warning" });
const r = spawnSync(process.execPath, [out, ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
