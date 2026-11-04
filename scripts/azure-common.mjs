// Shared helpers for the Azure scripts (docs/azure-migration.md). They run the Azure CLI as whoever is signed
// in (az login). Nothing here prints a secret.
import { spawnSync } from "node:child_process";

/** Runs az with arguments; returns stdout. Throws with az's message on failure. */
export function az(args, { json = false, quiet = false } = {}) {
  const r = spawnSync("az", [...args, ...(json ? ["-o", "json"] : [])], { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`az ${args.slice(0, 3).join(" ")} failed:\n${(r.stderr || r.stdout || "").trim()}`);
  if (!quiet && r.stderr?.trim()) process.stderr.write(r.stderr);
  return json ? JSON.parse(r.stdout || "null") : r.stdout.trim();
}

export function envArg() {
  const env = process.argv[2];
  if (env !== "sandbox" && env !== "production") {
    console.error("Usage: node <script> sandbox|production");
    process.exit(2);
  }
  // Production changes are K's (CLAUDE.md). A deliberate extra step so nothing deploys to it by accident.
  if (env === "production" && process.env.EBAY_CONFIRM_PRODUCTION !== "yes") {
    console.error("This changes PRODUCTION. Run it yourself with EBAY_CONFIRM_PRODUCTION=yes set, e.g.:\n  $env:EBAY_CONFIRM_PRODUCTION='yes'; node " + process.argv[1].split(/[\\/]/).pop() + " production");
    process.exit(2);
  }
  return env;
}

/** The outputs of an environment's last infrastructure deployment (names, URL, endpoints). */
export function outputs(env) {
  const o = az(["deployment", "sub", "show", "--name", `ebay-${env}`, "--query", "properties.outputs"], { json: true });
  if (!o) throw new Error(`No deployment named ebay-${env}. Run: node scripts/azure-infra.mjs ${env}`);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.value]));
}
