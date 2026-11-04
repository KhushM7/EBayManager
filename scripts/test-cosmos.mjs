// Runs the store conformance suite against the local Azure Cosmos DB emulator (Windows installer or Docker).
// The emulator uses a self-signed certificate, so TLS checking is relaxed for this child process only.
import { spawnSync } from "node:child_process";

const endpoint = process.env.COSMOS_EMULATOR ?? "https://localhost:8081";
const r = spawnSync("npx", ["vitest", "run", "test/store.cosmos.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, COSMOS_EMULATOR: endpoint, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
});
process.exit(r.status ?? 1);
