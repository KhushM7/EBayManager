import type { Env } from "./env";
import { titleLock } from "./ebay/trading";
import { callFor, ebayWrite, WriteRefused } from "./ebay/write";
import { push } from "./notify";
import { snapshotListings } from "./snapshot";
import { PROPOSAL_TTL_DAYS } from "./rules";
import { newProposalId } from "./store/proposals";
import { signDecision, verifyDecision } from "./links";

export type ProposalKind =
  | "price"
  | "revise"
  | "create_listing"
  | "end_listing"
  | "relist"
  | "promote"
  | "offer_to_watchers"
  | "message"
  | "best_offer_response"
  | "policy";

const SUPERSEDING_KINDS: ProposalKind[] = ["price", "revise", "promote"];

export interface Proposal {
  id: string;
  kind: ProposalKind;
  item_id: string | null;
  payload: string;
  reason: string | null;
  status: string;
  dry_run: number;
  created_at: number;
  expires_at: number;
}

/** Records a proposal. While WRITE_MODE is off it is a dry run that can never be applied. */
export async function createProposal(
  env: Env,
  p: { kind: ProposalKind; itemId?: string; payload: unknown; reason?: string },
): Promise<Proposal> {
  const now = Date.now();
  const row: Proposal = {
    id: newProposalId(p.itemId ?? null),
    kind: p.kind,
    item_id: p.itemId ?? null,
    payload: JSON.stringify(p.payload),
    reason: p.reason ?? null,
    status: "pending",
    dry_run: env.WRITE_MODE === "approval" ? 0 : 1,
    created_at: now,
    expires_at: now + PROPOSAL_TTL_DAYS * 86_400_000,
  };
  // A newer price, revision or ad rate for the same item supersedes the pending one, in the same transaction.
  // Replies and offer responses never do: each answers a different buyer.
  await env.store.proposals.create(row, Boolean(row.item_id) && SUPERSEDING_KINDS.includes(row.kind));
  return row;
}

export async function listProposals(env: Env, status = "pending"): Promise<Proposal[]> {
  return (await env.store.proposals.listByStatus(status, "asc")) as Proposal[];
}

export async function getProposal(env: Env, id: string): Promise<Proposal | null> {
  return (await env.store.proposals.get(id)) as (Proposal & { decided_by?: string | null; result?: string | null }) | null;
}

/** Marks pending proposals past their expiry as expired. Runs nightly. */
export async function expireStale(env: Env): Promise<void> {
  await env.store.proposals.expireStale(Date.now());
}

// --- One-tap approval links. Only a link signed with SIGNING_KEY can approve; Claude never holds that key path. ---

// The signing itself lives in src/links.ts, which imports nothing that can write, so read-only code can use it.
export { signDecision, verifyDecision };

/** Signed approve/reject links, valid until the proposal expires. Dry runs get none. */
export async function decisionLinks(env: Env, p: Proposal) {
  if (p.dry_run) return undefined;
  const link = async (d: "approve" | "reject") =>
    `${env.PUBLIC_URL}/decide/${p.id}?d=${d}&e=${p.expires_at}&s=${await signDecision(env, p.id, d, p.expires_at)}`;
  return { approve: await link("approve"), reject: await link("reject") };
}

/**
 * Records a proposal and pushes it to K's phone with Approve/Reject (or marked as a dry run). With
 * `links: false` the push only points to the app, for proposals K must finish first (an empty reply).
 */
export async function proposeAndNotify(
  env: Env,
  p: Parameters<typeof createProposal>[1],
  title: string,
  body: string,
  opts: { links?: boolean } = {},
) {
  const row = await createProposal(env, p);
  // On the real account, replies and offer answers are approved in the app, not from the lock screen.
  const appOnly = env.EBAY_ENV === "production" && APP_ONLY_KINDS.includes(row.kind) && (await requireAppForReplies(env));
  const links = opts.links === false || appOnly ? undefined : await decisionLinks(env, row);
  await push(env, row.dry_run ? `Dry run: ${title}` : title, body, links, row.id);
  return { proposalId: row.id, status: row.dry_run ? "dry run: cannot be applied while writes are off" : "pending K's approval" };
}

const APP_ONLY_KINDS = ["message", "best_offer_response"];

/** Settings switch, on unless K turns it off: replies and offer answers need the app, not a notification tap. */
export async function requireAppForReplies(env: Env): Promise<boolean> {
  return (await env.store.kv.get("require_app_for_replies")) !== "0";
}

/** Kinds whose pending drafts K may edit in the Inbox before approving. */
export const EDITABLE_KINDS = ["message", "best_offer_response"];

/** K's edit to a pending draft: the reply text, or the offer action, counter price and message. */
export async function editProposal(env: Env, id: string, changes: Record<string, unknown>, actor: string | null = null): Promise<string> {
  const p = await getProposal(env, id);
  if (!p) return "Not found";
  if (p.status !== "pending") return `Already ${p.status}`;
  if (!EDITABLE_KINDS.includes(p.kind)) return `A ${p.kind} proposal can't be edited`;
  const payload = JSON.parse(p.payload);
  if (p.kind === "message") {
    if (typeof changes.body !== "string") return "Give the reply text";
    payload.body = changes.body.slice(0, 2000);
  } else {
    if (!["accept", "counter", "decline"].includes(String(changes.action))) return "Choose accept, counter or decline";
    payload.action = changes.action;
    payload.counterPrice = changes.action === "counter" ? Number(changes.counterPrice) || null : null;
    if (changes.action === "counter" && !payload.counterPrice) return "A counter-offer needs a price";
    if (typeof changes.message === "string") payload.message = changes.message.slice(0, 250);
  }
  payload.editedByK = true;
  payload.editedBy = actor;
  if (!(await env.store.proposals.editPayload(id, JSON.stringify(payload)))) return "Already decided";
  return "Saved";
}

/** Listing changes show on the Listings screen straight away; a failed re-read waits for the nightly one. */
async function refreshAfterChange(env: Env, kind: string) {
  if (!["price", "revise", "create_listing", "end_listing", "relist"].includes(kind)) return;
  await snapshotListings(env).catch(() => {});
}

/** Applies proposals K approved while writes were paused. Run when K resumes writes. */
export async function applyApproved(env: Env): Promise<{ id: string; result: string }[]> {
  const approved = (await env.store.proposals.listWhere([
    { f: "status", op: "=", v: "approved" },
    { f: "dry_run", op: "=", v: 0 },
  ])).sort((a, b) => (a.decided_at ?? 0) - (b.decided_at ?? 0));
  const out: { id: string; result: string }[] = [];
  for (const { id } of approved) {
    try {
      const result = await ebayWrite(env, id);
      await env.store.proposals.setOutcome(id, { status: "applied", result });
      out.push({ id, result });
      await refreshAfterChange(env, "revise");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof WriteRefused)) {
        await env.store.proposals.setOutcome(id, { status: "failed", result: msg });
        const p = await getProposal(env, id);
        if (p) await reportWriteFailure(env, p, msg);
      }
      out.push({ id, result: msg });
      if (e instanceof WriteRefused && /paused|Writes are off/.test(msg)) break;
    }
  }
  return out;
}

/** The marker between a to-do's plain words and its raw diagnostics (web/src/todos.tsx shows those as a copyable block). */
export const DIAGNOSTICS_MARK = "--- diagnostics ---";

const KIND_WORDS: Record<string, string> = {
  promote: "the promotion change",
  offer_to_watchers: "the offer to watchers",
  price: "the price change",
  revise: "the listing edit",
  create_listing: "the new listing",
  message: "the reply",
  best_offer_response: "the offer answer",
};
const failedCode = (kind: string) => `ebay_refused_${kind}`;

/**
 * eBay refused or failed an approved change (K, 2026-11-15: never silently). An Inbox to-do says so in plain
 * words and carries the raw diagnostics from the audit log (each call sent for this label, what was sent, and
 * eBay's whole reply), so K can paste them to whoever fixes it; a notification points to it. One to-do per
 * listing and kind, refreshed by a later failure and resolved when the same kind of change next goes through.
 */
export async function reportWriteFailure(env: Env, p: Pick<Proposal, "id" | "kind" | "item_id" | "payload">, message: string, now = Date.now()) {
  const what = KIND_WORDS[p.kind] ?? `the ${p.kind.replace(/_/g, " ")}`;
  const calls = (await env.store.audit.recent(40).catch(() => [])).filter((r) => r.proposal_id === p.id).reverse();
  const title = (() => {
    try {
      return String(JSON.parse(p.payload).itemTitle ?? JSON.parse(p.payload).title ?? "") || null;
    } catch {
      return null;
    }
  })();
  const diagnostics = [
    `time: ${new Date(now).toISOString()}`,
    `environment: ${env.EBAY_ENV}`,
    `label: ${p.id} (${p.kind})`,
    `listing: ${p.item_id ?? "none"}`,
    `payload: ${p.payload.slice(0, 1500)}`,
    `error: ${message}`,
    ...calls.flatMap((c, i) => [`call ${i + 1}: ${c.call} -> ${c.outcome}`, `  sent: ${String(c.request ?? "").slice(0, 2500)}`, `  reply: ${String(c.response ?? "").slice(0, 4000)}`]),
  ].join("\n");
  const detail = `You approved ${what}, but eBay didn't accept it, so nothing changed on eBay.\neBay said: ${message.split("\n")[0].slice(0, 300)}\nCopy the diagnostics below to Claude to get it fixed. Approving the label again won't help until then.\n${DIAGNOSTICS_MARK}\n${diagnostics}`;
  await env.store.todos
    .sync("gate", { codes: [failedCode(p.kind)], itemIds: p.item_id ? [p.item_id] : null }, [{ code: failedCode(p.kind), kind: "you", itemId: p.item_id, itemTitle: title, subject: p.item_id ? null : p.id, title: `eBay refused ${what}`, detail, fingerprint: `${p.id}:${now}` }], now)
    .catch(() => null);
  await push(env, `eBay refused ${what}`, `${title ? `${title.slice(0, 60)}: ` : ""}${message.split("\n")[0].slice(0, 160)} The details are in the Inbox.`, undefined, `refused-${p.id}`).catch(() => null);
}

/** The same kind of change has now gone through for this listing: its "eBay refused" to-do, if any, is resolved. */
async function clearWriteFailure(env: Env, p: Pick<Proposal, "kind" | "item_id">, now = Date.now()) {
  if (p.item_id) await env.store.todos.sync("gate", { codes: [failedCode(p.kind)], itemIds: [p.item_id] }, [], now).catch(() => null);
}

export const DRY_RUN_AGREED = "Dry run: recorded as approved. Nothing was sent to eBay, and it can't be.";

/**
 * Whether a proposal holds its listing against a repeat suggestion (the nightly triage and price review). While
 * changes are off every proposal is a dry run and holds, so the same change isn't suggested night after night.
 * Once writes are on (K, 2026-11-07), dry runs left over from the read-only days no longer hold: they never
 * reached eBay, so the listing gets fresh, real suggestions straight away. Real proposals (waiting, approved or
 * applied) still hold, so nothing repeats.
 */
export const holdsListing = (env: Pick<Env, "WRITE_MODE">, p: { dry_run?: number | null }) => !(env.WRITE_MODE === "approval" && Boolean(p.dry_run));

export async function decide(env: Env, id: string, decision: "approve" | "reject", actor: string | null = null): Promise<string> {
  const p = await getProposal(env, id);
  if (!p) return "Not found";
  if (p.status !== "pending") return `Already ${p.status}`;
  const now = Date.now();
  if (p.expires_at < now) {
    await env.store.proposals.expire(id, now);
    return "Expired";
  }
  if (decision === "reject") {
    if (!(await env.store.proposals.decide(id, "rejected", now, actor))) return "Already decided";
    return "Rejected";
  }
  // A dry run can be judged but never applied: approving records K's agreement as 'agreed', a status the write
  // gate never claims (it applies only 'approved' rows that aren't dry runs).
  if (p.dry_run) {
    if (!(await env.store.proposals.decide(id, "agreed", now, actor, DRY_RUN_AGREED))) return "Already decided";
    return DRY_RUN_AGREED;
  }
  // A draft that can't become an eBay call yet (an empty reply, a kind not built) stays pending for K to finish.
  try {
    callFor(p);
  } catch (e) {
    return `Not approved yet: ${e instanceof Error ? e.message : String(e)}`;
  }
  // An offer can arrive after a revision was proposed; eBay would then refuse a new title or description.
  if (p.kind === "revise" && p.item_id) {
    const a = JSON.parse(p.payload);
    if (a.title || a.description) {
      const lock = await titleLock(env, p.item_id);
      if (lock) return `Not approved yet: ${lock}. Approve it again after that.`;
    }
  }

  // Approve once, and only while still pending and unexpired: one conditional write.
  if (!(await env.store.proposals.decide(id, "approved", now, actor, undefined, now))) return "Already decided";
  try {
    const result = await ebayWrite(env, id);
    await env.store.proposals.setOutcome(id, { status: "applied", result });
    await refreshAfterChange(env, p.kind);
    await clearWriteFailure(env, p, now);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof WriteRefused) {
      // Stays approved; nothing reached eBay.
      await env.store.proposals.setOutcome(id, { result: msg });
      return `Approved, not applied: ${msg}`;
    }
    await env.store.proposals.setOutcome(id, { status: "failed", result: msg });
    await reportWriteFailure(env, p, msg, now);
    return `Failed: ${msg}`;
  }
}
