import type { DocStore } from "./doc";
import { MemoryDocStore } from "./memory";
import { auditRepo, proposalsRepo } from "./proposals";
import { authRepo } from "./auth";
import { todosRepo } from "./todos";
import { draftsRepo } from "./drafts";
import { jobsRepo, kvRepo, listingsRepo, messagesRepo, ordersRepo, pricingRepo, pushRepo, reportsRepo, soldDataRepo, usageRepo } from "./data";

// The app's data store (replaces Cloudflare D1; docs/azure-migration.md). Code uses env.store's repositories;
// only src/store/ knows about documents, and only src/store/cosmos.ts knows about Cosmos DB.

export function makeStore(docs: DocStore) {
  return {
    docs,
    kv: kvRepo(docs),
    proposals: proposalsRepo(docs),
    audit: auditRepo(docs),
    auth: authRepo(docs),
    push: pushRepo(docs),
    listings: listingsRepo(docs),
    orders: ordersRepo(docs),
    messages: messagesRepo(docs),
    pricing: pricingRepo(docs),
    solddata: soldDataRepo(docs),
    usage: usageRepo(docs),
    reports: reportsRepo(docs),
    jobs: jobsRepo(docs),
    todos: todosRepo(docs),
    drafts: draftsRepo(docs),
  };
}

export type Store = ReturnType<typeof makeStore>;

/** An empty in-memory store (tests, local mock runs). */
export function memoryStore(clock?: () => number): Store {
  return makeStore(new MemoryDocStore(clock));
}

export { orderLines } from "./data";
export type { DecisionRow, ItemSettings, LatestRow, OrderDoc, PushRow, JobRow, UsageRow } from "./data";
export type { ProposalRow, AuditRow } from "./proposals";
export type { TodoInput, TodoRow, TodoScope, TodoKind, TodoStatus } from "./todos";
export type { DraftRow, DraftPhoto, DraftStatus } from "./drafts";
