// A small in-memory stand-in for D1, backed by node:sqlite and loaded with schema.sql.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class Statement {
  private args: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: unknown[]) {
    this.args = args.map((a) => (a === undefined ? null : a));
    return this;
  }
  async first<T>(): Promise<T | null> {
    return ((this.db.prepare(this.sql).get(...(this.args as any[])) as T) ?? null);
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as any[])) as T[] };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as any[]));
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("schema.sql", "utf8"));
  return {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (stmts: Statement[]) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}
