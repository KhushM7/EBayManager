import type { Env } from "./env";
import { runFirstDayAudit } from "./firstday";
import { auditListing } from "./jobs";
import { priceCheck } from "./pricing/actions";
import { push } from "./notify";
import { composeDraft, priceDraft, reviewDraft } from "./newlisting";

// Long tasks K starts from the app (docs/azure-migration.md): on Azure an HTTP response must come within
// 230 seconds, so the first-day audit, a price check and Claude's listing review run as background jobs. The
// request records the job and hands it to the queue; a queue-triggered function runs it (no time limit) and
// the app shows its progress. Where there is no queue (tests, local runs) the job runs inline and the
// request answers with the result, exactly as before.

export type JobKind = "firstday" | "price_check" | "listing_review" | "draft_review" | "draft_compose" | "draft_price";

async function execute(env: Env, kind: JobKind, args: any): Promise<unknown> {
  switch (kind) {
    case "firstday":
      return { report: await runFirstDayAudit(env, { relearnStyle: args?.relearnStyle === true }) };
    case "price_check":
      return priceCheck(env, String(args.itemId));
    // Add Listing (src/newlisting.ts): each returns the updated draft.
    case "draft_review":
      return reviewDraft(env, String(args.draftId));
    case "draft_compose":
      return composeDraft(env, String(args.draftId));
    case "draft_price":
      return priceDraft(env, String(args.draftId));
    case "listing_review": {
      const r = await auditListing(env, String(args.itemId));
      return { itemId: args.itemId, note: r.text, turns: r.turns, costUsd: r.costUsd, stopReason: r.stopReason };
    }
  }
}

const TITLES: Record<JobKind, string> = {
  firstday: "First-day audit",
  price_check: "Price check",
  listing_review: "Claude's listing review",
  draft_review: "Photo check",
  draft_compose: "Listing draft",
  draft_price: "Price for the new listing",
};

/**
 * Starts a job. With a queue: records it, queues it, and returns { jobId, status: "queued" }. Without: runs
 * it now and returns { status: "done", result } (or throws, as the inline code always did).
 */
export async function startJob(env: Env, kind: JobKind, args: unknown, by: string | null): Promise<{ jobId?: string; status: "queued" | "done"; result?: unknown }> {
  if (!env.enqueue) return { status: "done", result: await execute(env, kind, args) };
  const jobId = await env.store.jobs.createJob(kind, args, by, Date.now());
  await env.enqueue({ jobId });
  return { jobId, status: "queued" };
}

/**
 * Runs a queued job, once: the queued -> running claim is a conditional write, so a message delivered twice
 * (the queue may redeliver after a crash) can't run the job twice. Results are capped at 1 MB.
 */
export async function runJob(env: Env, jobId: string): Promise<void> {
  const job = await env.store.jobs.getJob(jobId);
  if (!job || !(await env.store.jobs.startJob(jobId, Date.now()))) return;
  const kind = job.kind as JobKind;
  try {
    const result = JSON.stringify(await execute(env, kind, JSON.parse(job.args)));
    await env.store.jobs.finishJob(jobId, Date.now(), { result: result.length > 1_000_000 ? JSON.stringify({ truncated: true }) : result });
    // The audit sends its own summary; the others say they're ready.
    if (kind !== "firstday") await push(env, `${TITLES[kind]} ready`, "Open the app to see it.", undefined, `job-${jobId}`).catch(() => {});
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    await env.store.jobs.finishJob(jobId, Date.now(), { error });
    await push(env, `${TITLES[kind]} failed`, error.slice(0, 200), undefined, `job-${jobId}`).catch(() => {});
  }
}

/** A job's status for the app: queued, running, done (with its result) or failed (with the reason). */
export async function jobStatus(env: Env, jobId: string) {
  const job = await env.store.jobs.getJob(jobId);
  if (!job) return null;
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    result: job.result ? JSON.parse(job.result) : null,
    error: job.error,
  };
}
