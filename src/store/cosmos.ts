import { CosmosClient, ErrorResponse, type Container as CosmosContainer, type OperationInput, type SqlParameter } from "@azure/cosmos";
import { assertField, assertPath, CONTAINERS, type BatchOp, type Cond, type Container, type Doc, type DocStore, type PatchOp, type Query } from "./doc";

// DocStore on Azure Cosmos DB for NoSQL (docs/azure-migration.md). The Function App signs in with its managed
// identity (key auth is disabled on the account) and may only touch its own database, by RBAC. Containers are
// created by Bicep from infra/cosmos-containers.json, never from code.
//
// Every safety-critical write is a conditional write: patch with a filter predicate, replace with an etag, or
// create that fails on an existing id. The server checks these against the latest committed version, so they
// hold whatever the read consistency.

const status = (e: unknown) => (e instanceof ErrorResponse ? Number(e.code) : (e as any)?.code ?? (e as any)?.statusCode);
const isStatus = (e: unknown, ...codes: number[]) => codes.includes(Number(status(e)));

/** Builds a WHERE clause over `c` from conditions, with numbered parameters. */
export function whereSql(conds: Cond[], params: SqlParameter[], alias = "c"): string {
  return conds
    .map((c) => {
      assertField(c.f);
      const f = `${alias}["${c.f}"]`;
      if (c.op === "null") return `(NOT IS_DEFINED(${f}) OR IS_NULL(${f}))`;
      if (c.op === "notnull") return `(IS_DEFINED(${f}) AND NOT IS_NULL(${f}))`;
      const name = `@p${params.length}`;
      params.push({ name, value: c.v as any });
      if (c.op === "in") return `ARRAY_CONTAINS(${name}, ${f})`;
      if (c.op === "contains") return `CONTAINS(${f}, ${name})`;
      return `${f} ${c.op} ${name}`;
    })
    .join(" AND ");
}

/** A patch filter predicate ("FROM c WHERE ...") with values inlined: patch conditions take no parameters. */
export function conditionSql(conds: Cond[]): string {
  const lit = (v: unknown) => JSON.stringify(v);
  const parts = conds.map((c) => {
    assertField(c.f);
    const f = `c["${c.f}"]`;
    if (c.op === "null") return `(NOT IS_DEFINED(${f}) OR IS_NULL(${f}))`;
    if (c.op === "notnull") return `(IS_DEFINED(${f}) AND NOT IS_NULL(${f}))`;
    if (c.op === "in") return `ARRAY_CONTAINS(${lit(c.v)}, ${f})`;
    if (c.op === "contains") return `CONTAINS(${f}, ${lit(c.v)})`;
    if (typeof c.v === "number" && !Number.isFinite(c.v)) throw new Error("Bad condition value");
    return `${f} ${c.op} ${lit(c.v)}`;
  });
  return `FROM c WHERE ${parts.join(" AND ")}`;
}

const patchOps = (ops: PatchOp[]) =>
  ops.map((o) => {
    assertPath(o.path);
    return o.op === "remove" ? { op: "remove" as const, path: o.path } : { op: o.op, path: o.path, value: o.value };
  });

const strip = (d: any): Doc | null => {
  if (!d) return null;
  const { _rid, _self, _attachments, _ts, ...rest } = d;
  return rest as Doc;
};

export class CosmosDocStore implements DocStore {
  private containers = new Map<Container, CosmosContainer>();
  constructor(client: CosmosClient, database: string) {
    const db = client.database(database);
    for (const c of CONTAINERS) this.containers.set(c, db.container(c));
  }

  private c(name: Container) {
    return this.containers.get(name)!;
  }

  /** Startup check: every container exists (a missing one is a deploy error, not something code may create). */
  async check(): Promise<void> {
    for (const c of CONTAINERS) await this.c(c).read();
  }

  async get<T extends Doc = Doc>(c: Container, id: string, pk: string): Promise<T | null> {
    try {
      const { resource } = await this.c(c).item(id, pk).read();
      return (strip(resource) as T) ?? null;
    } catch (e) {
      if (isStatus(e, 404)) return null;
      throw e;
    }
  }

  async create(c: Container, doc: Doc) {
    try {
      const { _etag, ...body } = doc;
      await this.c(c).items.create(body);
      return true;
    } catch (e) {
      if (isStatus(e, 409)) return false;
      throw e;
    }
  }

  async upsert(c: Container, doc: Doc) {
    const { _etag, ...body } = doc;
    await this.c(c).items.upsert(body);
  }

  async replace(c: Container, doc: Doc, etag?: string) {
    try {
      const { _etag, ...body } = doc;
      await this.c(c)
        .item(doc.id, doc.pk)
        .replace(body, etag ? { accessCondition: { type: "IfMatch", condition: etag } } : undefined);
      return true;
    } catch (e) {
      if (isStatus(e, 404, 412)) return false;
      throw e;
    }
  }

  async patch(c: Container, id: string, pk: string, ops: PatchOp[], cond?: Cond[]) {
    if (ops.length > 10) throw new Error("A patch holds at most 10 operations");
    try {
      await this.c(c)
        .item(id, pk)
        .patch(cond?.length ? { operations: patchOps(ops), condition: conditionSql(cond) } : patchOps(ops));
      return true;
    } catch (e) {
      // 412: condition false. 404: no such document. 400: e.g. a path whose parent is missing.
      if (isStatus(e, 404, 412, 400)) return false;
      throw e;
    }
  }

  async delete(c: Container, id: string, pk: string) {
    try {
      await this.c(c).item(id, pk).delete();
      return true;
    } catch (e) {
      if (isStatus(e, 404)) return false;
      throw e;
    }
  }

  async query<T = Doc>(c: Container, q: Query): Promise<T[]> {
    const params: SqlParameter[] = [];
    const conds = [...(q.where ?? [])];
    const select = q.fields ? q.fields.map((f) => (assertField(f), `c["${f}"]`)).join(", ") : "*";
    const top = q.limit != null ? `TOP ${Math.max(0, Math.floor(q.limit))} ` : "";
    let sql = `SELECT ${top}${select === "*" ? "*" : select} FROM c`;
    if (q.pk !== undefined) conds.unshift({ f: "pk", op: "=", v: q.pk });
    if (conds.length) sql += ` WHERE ${whereSql(conds, params)}`;
    if (q.orderBy) {
      assertField(q.orderBy[0]);
      sql += ` ORDER BY c["${q.orderBy[0]}"] ${q.orderBy[1] === "desc" ? "DESC" : "ASC"}`;
    }
    const iter = this.c(c).items.query({ query: sql, parameters: params }, q.pk !== undefined ? { partitionKey: q.pk } : {});
    const { resources } = await iter.fetchAll();
    return (q.fields ? resources : resources.map(strip)) as T[];
  }

  async batch(c: Container, pk: string, ops: BatchOp[]) {
    if (ops.length > 100) throw new Error("A batch holds at most 100 operations");
    const input: OperationInput[] = ops.map((op): OperationInput => {
      if ("doc" in op && op.doc.pk !== pk) throw new Error("Batch document in another partition");
      switch (op.op) {
        case "create":
          return { operationType: "Create", resourceBody: (({ _etag, ...b }) => b)(op.doc) as any };
        case "upsert":
          return { operationType: "Upsert", resourceBody: (({ _etag, ...b }) => b)(op.doc) as any };
        case "replace":
          return { operationType: "Replace", id: op.doc.id, resourceBody: (({ _etag, ...b }) => b)(op.doc) as any, ...(op.etag ? { ifMatch: op.etag } : {}) };
        case "patch":
          return {
            operationType: "Patch",
            id: op.id,
            resourceBody: op.cond?.length ? { operations: patchOps(op.ops), condition: conditionSql(op.cond) } : { operations: patchOps(op.ops) },
          };
        case "delete":
          return { operationType: "Delete", id: op.id };
        case "read":
          return { operationType: "Read", id: op.id };
      }
    });
    try {
      const res = await this.c(c).items.batch(input, pk);
      const results = res.result ?? [];
      const ok = results.length === ops.length && results.every((r) => r.statusCode >= 200 && r.statusCode < 300);
      return { ok, results: ok ? results.map((r) => strip(r.resourceBody)) : [] };
    } catch (e) {
      if (isStatus(e, 400, 404, 409, 412, 424)) return { ok: false, results: [] };
      throw e;
    }
  }
}
