import type { Env } from "./env";
import { getItem, titleLockReason } from "./ebay/trading";
import { callFor, ebayWrite, WriteRefused } from "./ebay/write";
import { push } from "./notify";
import { snapshotListings } from "./snapshot";
import { PROPOSAL_TTL_DAYS } from "./rules";
import { newProposalId } from "./store/proposals";

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

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const signDecision = (env: Env, id: string, decision: "approve" | "reject", expiresAt: number) =>
  hmac(env.SIGNING_KEY, `${id}:${decision}:${expiresAt}`);

export async function verifyDecision(env: Env, id: string, decision: "approve" | "reject", expiresAt: number, sig: string) {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = await signDecision(env, id, decision, expiresAt);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

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
      if (!(e instanceof WriteRefused)) await env.store.proposals.setOutcome(id, { status: "failed", result: msg });
      out.push({ id, result: msg });
      if (e instanceof WriteRefused && /paused|Writes are off/.test(msg)) break;
    }
  }
  return out;
}

export const DRY_RUN_AGREED = "Dry run: recorded as approved. Nothing was sent to eBay, and it can't be.";

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
      const lock = titleLockReason(await getItem(env, p.item_id).catch(() => null));
      if (lock) return `Not approved yet: ${lock}. Approve it again after that.`;
    }
  }

  // Approve once, and only while still pending and unexpired: one conditional write.
  if (!(await env.store.proposals.decide(id, "approved", now, actor, undefined, now))) return "Already decided";
  try {
    const result = await ebayWrite(env, id);
    await env.store.proposals.setOutcome(id, { status: "applied", result });
    await refreshAfterChange(env, p.kind);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof WriteRefused) {
      // Stays approved; nothing reached eBay.
      await env.store.proposals.setOutcome(id, { result: msg });
      return `Approved, not applied: ${msg}`;
    }
    await env.store.proposals.setOutcome(id, { status: "failed", result: msg });
    return `Failed: ${msg}`;
  }
}
