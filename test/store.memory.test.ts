import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runConformance } from "./store/conformance";
import { MemoryDocStore } from "../src/store/memory";
import { CONTAINERS, DEFAULT_TTL } from "../src/store/doc";
import { conditionSql, whereSql } from "../src/store/cosmos";

runConformance("memory", async () => new MemoryDocStore());

describe("the store's definitions agree", () => {
  const def = JSON.parse(readFileSync("infra/cosmos-containers.json", "utf8")) as { containers: { id: string; defaultTtl: number | null; indexed: string[] }[] };

  it("every container in code is defined for Bicep, with the same default TTL", () => {
    expect(def.containers.map((c) => c.id).sort()).toEqual([...CONTAINERS].sort());
    for (const c of def.containers) expect(c.defaultTtl ?? undefined, c.id).toBe(DEFAULT_TTL[c.id as keyof typeof DEFAULT_TTL]);
  });

  it("builds Cosmos SQL from conditions without string injection", () => {
    const params: any[] = [];
    expect(whereSql([{ f: "status", op: "=", v: "x' OR 1=1" }, { f: "used_at", op: "null" }], params)).toBe('c["status"] = @p0 AND (NOT IS_DEFINED(c["used_at"]) OR IS_NULL(c["used_at"]))');
    expect(params).toEqual([{ name: "@p0", value: "x' OR 1=1" }]);
    expect(conditionSql([{ f: "status", op: "=", v: 'a" OR true' }, { f: "dry_run", op: "=", v: 0 }])).toBe('FROM c WHERE c["status"] = "a\\" OR true" AND c["dry_run"] = 0');
    expect(() => whereSql([{ f: "x) OR (1", op: "null" }], [])).toThrow(/Bad field/);
  });
});
