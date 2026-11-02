import type { Env } from "./env";
import { callFor, ebayWrite, WriteRefused } from "./ebay/write";
import { push } from "./notify";
import { PROPOSAL_TTL_DAYS } from "./rules";

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
    id: crypto.randomUUID(),
    kind: p.kind,
    item_id: p.itemId ?? null,
    payload: JSON.stringify(p.payload),
    reason: p.reason ?? null,
    status: "pending",
    dry_run: env.WRITE_MODE === "approval" ? 0 : 1,
    created_at: now,
    expires_at: now + PROPOSAL_TTL_DAYS * 86_400_000,
  };
  const statements = [
    env.DB.prepare(
      "INSERT INTO proposals (id, kind, item_id, payload, reason, status, dry_run, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(row.id, row.kind, row.item_id, row.payload, row.reason, row.status, row.dry_run, row.created_at, row.expires_at),
  ];
  // A newer price, revision or ad rate for the same item supersedes the pending one. Replies and offer
  // responses never do: each answers a different buyer.
  if (row.item_id && SUPERSEDING_KINDS.includes(row.kind))
    statements.unshift(
      env.DB.prepare("UPDATE proposals SET status = 'expired', decided_at = ? WHERE item_id = ? AND kind = ? AND status = 'pending'").bind(
        now,
        row.item_id,
        row.kind,
      ),
    );
  await env.DB.batch(statements);
  return row;
}

export async function listProposals(env: Env, status = "pending"): Promise<Proposal[]> {
  const { results } = await env.DB.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at")
    .bind(status)
    .all<Proposal>();
  return results;
}

export async function getProposal(env: Env, id: string): Promise<Proposal | null> {
  return env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<Proposal>();
}

/** Marks pending proposals past their expiry as expired. Runs nightly. */
export async function expireStale(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at < ?")
    .bind(Date.now(), Date.now())
    .run();
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
  const links = opts.links === false ? undefined : await decisionLinks(env, row);
  await push(env, row.dry_run ? `Dry run: ${title}` : title, body, links, row.id);
  return { proposalId: row.id, status: row.dry_run ? "dry run: cannot be applied while writes are off" : "pending K's approval" };
}

/** Kinds whose pending drafts K may edit in the Inbox before approving. */
export const EDITABLE_KINDS = ["message", "best_offer_response"];

/** K's edit to a pending draft: the reply text, or the offer action, counter price and message. */
export async function editProposal(env: Env, id: string, changes: Record<string, unknown>): Promise<string> {
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
  await env.DB.prepare("UPDATE proposals SET payload = ? WHERE id = ? AND status = 'pending'").bind(JSON.stringify(payload), id).run();
  return "Saved";
}

/** Applies proposals K approved while writes were paused. Run when K resumes writes. */
export async function applyApproved(env: Env): Promise<{ id: string; result: string }[]> {
  const { results } = await env.DB.prepare("SELECT id FROM proposals WHERE status = 'approved' AND dry_run = 0 ORDER BY decided_at").all<{ id: string }>();
  const out: { id: string; result: string }[] = [];
  for (const { id } of results) {
    try {
      const result = await ebayWrite(env, id);
      await env.DB.prepare("UPDATE proposals SET status = 'applied', result = ? WHERE id = ?").bind(result, id).run();
      out.push({ id, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof WriteRefused)) await env.DB.prepare("UPDATE proposals SET status = 'failed', result = ? WHERE id = ?").bind(msg, id).run();
      out.push({ id, result: msg });
      if (e instanceof WriteRefused && /paused|Writes are off/.test(msg)) break;
    }
  }
  return out;
}

export async function decide(env: Env, id: string, decision: "approve" | "reject"): Promise<string> {
  const p = await getProposal(env, id);
  if (!p) return "Not found";
  if (p.status !== "pending") return `Already ${p.status}`;
  const now = Date.now();
  if (p.expires_at < now) {
    await env.DB.prepare("UPDATE proposals SET status = 'expired', decided_at = ? WHERE id = ?").bind(now, id).run();
    return "Expired";
  }
  if (decision === "reject") {
    await env.DB.prepare("UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").bind(now, id).run();
    return "Rejected";
  }
  if (p.dry_run) return "Dry run: this proposal can't be applied";
  // A draft that can't become an eBay call yet (an empty reply, a kind not built) stays pending for K to finish.
  try {
    callFor(p);
  } catch (e) {
    return `Not approved yet: ${e instanceof Error ? e.message : String(e)}`;
  }

  const approved = await env.DB.prepare("UPDATE proposals SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'")
    .bind(now, id)
    .run();
  if (!approved.meta.changes) return "Already decided";
  try {
    const result = await ebayWrite(env, id);
    await env.DB.prepare("UPDATE proposals SET status = 'applied', result = ? WHERE id = ?").bind(result, id).run();
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof WriteRefused) {
      // Stays approved; nothing reached eBay.
      await env.DB.prepare("UPDATE proposals SET result = ? WHERE id = ?").bind(msg, id).run();
      return `Approved, not applied: ${msg}`;
    }
    await env.DB.prepare("UPDATE proposals SET status = 'failed', result = ? WHERE id = ?").bind(msg, id).run();
    return `Failed: ${msg}`;
  }
}
