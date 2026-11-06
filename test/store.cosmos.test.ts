// The conformance suite against the Azure Cosmos DB emulator (npm run test:cosmos). Skipped unless
// COSMOS_EMULATOR is set. Uses the emulator's published well-known key, never a real account.
import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { CosmosClient } from "@azure/cosmos";
import { runConformance } from "./store/conformance";
import { CosmosDocStore } from "../src/store/cosmos";

const ENDPOINT = process.env.COSMOS_EMULATOR ?? "";
// The emulator's documented, public development key (it only works against a local emulator).
const EMULATOR_KEY = "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

if (!ENDPOINT) describe.skip("DocStore: cosmos emulator (set COSMOS_EMULATOR to run)", () => it("skipped", () => {}));
else {
  const client = new CosmosClient({ endpoint: ENDPOINT, key: EMULATOR_KEY });
  const def = JSON.parse(readFileSync("infra/cosmos-containers.json", "utf8")) as { containers: { id: string; defaultTtl: number | null; indexed: string[] }[] };
  let n = 0;
  runConformance(
    "cosmos emulator",
    async () => {
      const id = `t${Date.now()}${n++}`;
      const { database } = await client.databases.createIfNotExists({ id });
      for (const c of def.containers)
        await database.containers.createIfNotExists({
          id: c.id,
          partitionKey: { paths: ["/pk"] },
          ...(c.defaultTtl != null ? { defaultTtl: c.defaultTtl } : {}),
          indexingPolicy: { includedPaths: c.indexed.map((path) => ({ path })), excludedPaths: [{ path: "/*" }] },
        });
      return new CosmosDocStore(client, id);
    },
    { ttl: true },
  );
}
