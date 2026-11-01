import type { Env } from "./env";
import { revisePrice } from "./ebay/trading";

export type ProposalKind = "price" | "revise" | "promote" | "offer_to_watchers" | "message" | "best_offer_response";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  item_id: string | null;
  payload: string;
  reason: string | null;
  status: string;
  created_at: number;
}

export async function createProposal(
  env: Env,
  p: { kind: ProposalKind; itemId?: string; payload: unknown; reason?: string },
): Promise<Proposal> {
  const row: Proposal = {
    id: crypto.randomUUID(),
    kind: p.kind,
    item_id: p.itemId ?? null,
    payload: JSON.stringify(p.payload),
    reason: p.reason ?? null,
    status: "pending",
    created_at: Date.now(),
  };
  await env.DB.prepare(
    "INSERT INTO proposals (id, kind, item_id, payload, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.kind, row.item_id, row.payload, row.reason, row.status, row.created_at)
    .run();
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

// --- One-tap approval links. Only a link signed with SIGNING_KEY can approve; Claude never holds that key path. ---

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const signDecision = (env: Env, id: string, decision: "approve" | "reject") =>
  hmac(env.SIGNING_KEY, `${id}:${decision}`);

export async function verifyDecision(env: Env, id: string, decision: "approve" | "reject", sig: string) {
  const expected = await signDecision(env, id, decision);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export async function decisionLinks(env: Env, id: string) {
  return {
    approve: `${env.PUBLIC_URL}/decide/${id}?d=approve&s=${await signDecision(env, id, "approve")}`,
    reject: `${env.PUBLIC_URL}/decide/${id}?d=reject&s=${await signDecision(env, id, "reject")}`,
  };
}

/** Applies an approved proposal to eBay. Kinds not built yet stay approved for a later phase. */
export async function applyProposal(env: Env, p: Proposal): Promise<string> {
  const payload = JSON.parse(p.payload);
  switch (p.kind) {
    case "price":
      await revisePrice(env, p.item_id!, Number(payload.newPrice));
      return `Price set to ${payload.newPrice}`;
    default:
      return `Approved; applying ${p.kind} arrives in a later phase`;
  }
}

export async function decide(env: Env, id: string, decision: "approve" | "reject"): Promise<string> {
  const p = await getProposal(env, id);
  if (!p) return "Not found";
  if (p.status !== "pending") return `Already ${p.status}`;
  if (decision === "reject") {
    await env.DB.prepare("UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ?").bind(Date.now(), id).run();
    return "Rejected";
  }
  try {
    const result = await applyProposal(env, p);
    const status = result.startsWith("Approved;") ? "approved" : "applied";
    await env.DB.prepare("UPDATE proposals SET status = ?, decided_at = ?, result = ? WHERE id = ?")
      .bind(status, Date.now(), result, id)
      .run();
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE proposals SET status = 'failed', decided_at = ?, result = ? WHERE id = ?")
      .bind(Date.now(), msg, id)
      .run();
    return `Failed: ${msg}`;
  }
}
