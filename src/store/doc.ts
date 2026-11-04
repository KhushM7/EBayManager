// The document layer under the store (docs/azure-migration.md). Two implementations behave the same way:
// src/store/memory.ts (tests) and src/store/cosmos.ts (Azure Cosmos DB for NoSQL). Repositories in
// src/store/repos/ are written once against this interface, so the safety-critical logic (conditional claims,
// transactional batches) is tested once and runs identically in production.
//
// Semantics follow Cosmos DB:
// - create fails (false) when the id already exists in that partition; replace/patch/delete fail when it
//   doesn't, and conditional patch/replace fail when the condition or etag doesn't hold. Nothing throws for
//   these: callers branch on the boolean.
// - a batch is all-or-nothing within one partition.
// - comparisons with a missing field are false (except op "null"), and ORDER BY leaves out documents that
//   lack the sort field, so repositories always write the fields they filter or sort on.
// - documents with ttl > 0 (seconds), or in a container with a default TTL, disappear that long after their
//   last write.

export type Container =
  | "kv"
  | "auth"
  | "ephemeral"
  | "proposals"
  | "audit"
  | "listings"
  | "orders"
  | "messages"
  | "pricing"
  | "market"
  | "cache"
  | "usage"
  | "reports"
  | "jobs";

export const CONTAINERS: Container[] = ["kv", "auth", "ephemeral", "proposals", "audit", "listings", "orders", "messages", "pricing", "market", "cache", "usage", "reports", "jobs"];

export interface Doc {
  id: string;
  pk: string;
  type?: string;
  /** Seconds to live after the last write; -1 never expires. */
  ttl?: number;
  _etag?: string;
  [field: string]: any;
}

/** A condition on one top-level field. "null" matches a missing or null field; "notnull" the opposite. */
export type Cond =
  | { f: string; op: "=" | "!=" | "<" | "<=" | ">" | ">="; v: string | number | boolean }
  | { f: string; op: "in"; v: (string | number)[] }
  | { f: string; op: "null" }
  | { f: string; op: "notnull" }
  | { f: string; op: "contains"; v: string };

export interface Query {
  /** Limits the query to one partition (cheaper); omitted means across partitions. */
  pk?: string;
  where?: Cond[];
  orderBy?: [field: string, dir: "asc" | "desc"];
  limit?: number;
  /** Top-level fields to return; omitted returns whole documents. */
  fields?: string[];
}

export type PatchOp = { op: "set"; path: string; value: unknown } | { op: "incr"; path: string; value: number } | { op: "remove"; path: string };

export type BatchOp =
  | { op: "create"; doc: Doc }
  | { op: "upsert"; doc: Doc }
  | { op: "replace"; doc: Doc; etag?: string }
  | { op: "patch"; id: string; ops: PatchOp[]; cond?: Cond[] }
  | { op: "delete"; id: string }
  | { op: "read"; id: string };

export interface DocStore {
  get<T extends Doc = Doc>(c: Container, id: string, pk: string): Promise<T | null>;
  create(c: Container, doc: Doc): Promise<boolean>;
  upsert(c: Container, doc: Doc): Promise<void>;
  replace(c: Container, doc: Doc, etag?: string): Promise<boolean>;
  patch(c: Container, id: string, pk: string, ops: PatchOp[], cond?: Cond[]): Promise<boolean>;
  delete(c: Container, id: string, pk: string): Promise<boolean>;
  query<T = Doc>(c: Container, q: Query): Promise<T[]>;
  /** All-or-nothing in one partition. results[i] is the document for a read (or the written one), else null. */
  batch(c: Container, pk: string, ops: BatchOp[]): Promise<{ ok: boolean; results: (Doc | null)[] }>;
}

// --- Helpers shared by both implementations and the repositories ---

/** Container default TTL in seconds (-1: per-document ttl only; undefined: TTL off). Mirrors infra/cosmos-containers.json. */
export const DEFAULT_TTL: Partial<Record<Container, number>> = { ephemeral: -1, market: 15_552_000, cache: -1, jobs: -1 };

let seq = 0;
/**
 * Time-ordered id: sorts as a string by time, and by order of creation within one process (as an
 * AUTOINCREMENT id did), with a random tail so two processes never clash.
 */
export function seqId(at: number): string {
  seq = (seq + 1) % 1_679_616; // 36^4
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${String(at).padStart(13, "0")}-${seq.toString(36).padStart(4, "0")}${rand}`;
}

export const pad13 = (n: number) => String(n).padStart(13, "0");

/** A safe document id for any key (URLs, JSON, titles): base64url SHA-256. */
export async function hashId(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  let s = "";
  for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PATH = /^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_-]+)*$/;
export function assertPath(path: string) {
  if (!PATH.test(path)) throw new Error(`Bad patch path ${path}`);
}

export const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function assertField(f: string) {
  if (!FIELD.test(f)) throw new Error(`Bad field ${f}`);
}
