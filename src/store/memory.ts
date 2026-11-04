import { assertField, assertPath, DEFAULT_TTL, type BatchOp, type Cond, type Container, type Doc, type DocStore, type PatchOp, type Query } from "./doc";

// In-memory DocStore with Cosmos DB semantics (see src/store/doc.ts), for tests. Every operation checks and
// writes with no await in between, so conditional writes stay atomic under Promise.all, as on the server.

type Row = { doc: Doc; ts: number; etag: number };

const clone = <T>(x: T): T => structuredClone(x);

function getPath(obj: any, path: string): any {
  return path
    .split("/")
    .slice(1)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function applyOps(doc: Doc, ops: PatchOp[]): Doc {
  const out = clone(doc);
  for (const op of ops) {
    assertPath(op.path);
    const keys = op.path.split("/").slice(1);
    const last = keys.pop()!;
    let parent: any = out;
    for (const k of keys) {
      // As in Cosmos DB, every parent on the path must already exist.
      if (parent[k] == null || typeof parent[k] !== "object") throw new PatchFailed();
      parent = parent[k];
    }
    if (op.op === "set") parent[last] = clone(op.value);
    else if (op.op === "remove") {
      if (!(last in parent)) throw new PatchFailed();
      delete parent[last];
    } else {
      const cur = parent[last] ?? 0;
      if (typeof cur !== "number") throw new PatchFailed();
      parent[last] = cur + op.value;
    }
  }
  return out;
}

class PatchFailed extends Error {}

export function matches(doc: Doc, conds: Cond[] = []): boolean {
  return conds.every((c) => {
    assertField(c.f);
    const v = doc[c.f];
    if (c.op === "null") return v === undefined || v === null;
    if (c.op === "notnull") return v !== undefined && v !== null;
    if (v === undefined) return false;
    if (c.op === "in") return c.v.some((x) => x === v);
    if (c.op === "contains") return typeof v === "string" && v.includes(c.v);
    if (v === null || typeof v !== typeof c.v) return false;
    switch (c.op) {
      case "=":
        return v === c.v;
      case "!=":
        return v !== c.v;
      case "<":
        return v < c.v;
      case "<=":
        return v <= c.v;
      case ">":
        return v > c.v;
      case ">=":
        return v >= c.v;
    }
  });
}

export class MemoryDocStore implements DocStore {
  private data = new Map<string, Row>();
  private etagSeq = 0;
  constructor(private clock: () => number = Date.now) {}

  private key = (c: Container, pk: string, id: string) => `${c}\u0000${pk}\u0000${id}`;

  private live(c: Container, row: Row | undefined): Row | undefined {
    if (!row) return undefined;
    const ttl = row.doc.ttl ?? DEFAULT_TTL[c];
    if (ttl != null && ttl > 0 && this.clock() > row.ts + ttl * 1000) return undefined;
    return row;
  }

  private out(row: Row): Doc {
    return { ...clone(row.doc), _etag: String(row.etag) };
  }

  private write(c: Container, doc: Doc): Row {
    if (!doc.id || typeof doc.pk !== "string") throw new Error("A document needs id and pk");
    const { _etag, ...rest } = doc;
    const row = { doc: clone(rest) as Doc, ts: this.clock(), etag: ++this.etagSeq };
    this.data.set(this.key(c, doc.pk, doc.id), row);
    return row;
  }

  private row(c: Container, id: string, pk: string) {
    return this.live(c, this.data.get(this.key(c, pk, id)));
  }

  async get<T extends Doc = Doc>(c: Container, id: string, pk: string): Promise<T | null> {
    const r = this.row(c, id, pk);
    return r ? (this.out(r) as T) : null;
  }

  async create(c: Container, doc: Doc) {
    if (this.row(c, doc.id, doc.pk)) return false;
    this.write(c, doc);
    return true;
  }

  async upsert(c: Container, doc: Doc) {
    this.write(c, doc);
  }

  async replace(c: Container, doc: Doc, etag?: string) {
    const r = this.row(c, doc.id, doc.pk);
    if (!r || (etag !== undefined && String(r.etag) !== etag)) return false;
    this.write(c, doc);
    return true;
  }

  async patch(c: Container, id: string, pk: string, ops: PatchOp[], cond?: Cond[]) {
    const r = this.row(c, id, pk);
    if (!r || !matches(r.doc, cond)) return false;
    try {
      this.write(c, applyOps(r.doc, ops));
      return true;
    } catch (e) {
      if (e instanceof PatchFailed) return false;
      throw e;
    }
  }

  async delete(c: Container, id: string, pk: string) {
    if (!this.row(c, id, pk)) return false;
    this.data.delete(this.key(c, pk, id));
    return true;
  }

  async query<T = Doc>(c: Container, q: Query): Promise<T[]> {
    const prefix = `${c}\u0000`;
    let docs: Doc[] = [];
    for (const [k, row] of this.data) {
      if (!k.startsWith(prefix) || !this.live(c, row)) continue;
      if (q.pk !== undefined && row.doc.pk !== q.pk) continue;
      if (matches(row.doc, q.where)) docs.push(this.out(row));
    }
    if (q.orderBy) {
      const [f, dir] = q.orderBy;
      assertField(f);
      docs = docs.filter((d) => d[f] !== undefined);
      docs.sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0) * (dir === "desc" ? -1 : 1));
    }
    if (q.limit != null) docs = docs.slice(0, q.limit);
    if (q.fields) docs = docs.map((d) => Object.fromEntries(q.fields!.filter((f) => f in d).map((f) => [f, d[f]])) as Doc);
    return docs as T[];
  }

  async batch(c: Container, pk: string, ops: BatchOp[]) {
    if (ops.length > 100) throw new Error("A batch holds at most 100 operations");
    // Work on a copy of this partition; commit only if every operation succeeds.
    const staged = new Map<string, Row | null>();
    const current = (id: string): Row | undefined => {
      if (staged.has(id)) return staged.get(id) ?? undefined;
      return this.row(c, id, pk);
    };
    const results: (Doc | null)[] = [];
    const stage = (doc: Doc) => {
      const { _etag, ...rest } = doc;
      const row = { doc: clone({ ...rest, pk }) as Doc, ts: this.clock(), etag: 0 };
      staged.set(doc.id, row);
      return row;
    };
    for (const op of ops) {
      if ("doc" in op && op.doc.pk !== pk) throw new Error("Batch document in another partition");
      if (op.op === "read") {
        const r = current(op.id);
        if (!r) return { ok: false, results: [] };
        results.push(clone(r.doc));
      } else if (op.op === "create") {
        if (current(op.doc.id)) return { ok: false, results: [] };
        results.push(stage(op.doc).doc);
      } else if (op.op === "upsert") {
        results.push(stage(op.doc).doc);
      } else if (op.op === "replace") {
        const r = current(op.doc.id);
        if (!r || (op.etag !== undefined && (r.etag === 0 || String(r.etag) !== op.etag))) return { ok: false, results: [] };
        results.push(stage(op.doc).doc);
      } else if (op.op === "patch") {
        const r = current(op.id);
        if (!r || !matches(r.doc, op.cond)) return { ok: false, results: [] };
        try {
          results.push(stage(applyOps(r.doc, op.ops)).doc);
        } catch (e) {
          if (e instanceof PatchFailed) return { ok: false, results: [] };
          throw e;
        }
      } else {
        if (!current(op.id)) return { ok: false, results: [] };
        staged.set(op.id, null);
        results.push(null);
      }
    }
    for (const [id, row] of staged) {
      if (row) {
        row.etag = ++this.etagSeq;
        this.data.set(this.key(c, pk, id), row);
      } else this.data.delete(this.key(c, pk, id));
    }
    return { ok: true, results: results.map((d) => (d ? clone(d) : null)) };
  }

  /** Tests: every live document in a container. */
  all(c: Container): Doc[] {
    const prefix = `${c}\u0000`;
    return [...this.data].filter(([k, r]) => k.startsWith(prefix) && this.live(c, r)).map(([, r]) => this.out(r));
  }
}
