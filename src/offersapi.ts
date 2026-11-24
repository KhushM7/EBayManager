import type { Env } from "./env";
import { canMessage, getConversation, getConversations } from "./ebay/messages";
import { outcomeOf } from "./ebay/inbox";
import { log } from "./log";
import { createProposal } from "./proposals";
import { listSales } from "./sales";

// The Offers and messages screen's API (src/api.ts calls it, after sign-in). Reads, and filing of labels only: every
// answer and message still goes through decide() and the write gate.

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const bad = (error: string, status = 400) => json({ error }, status);

export async function handleOffers(env: Env, method: string, path: string, body: () => Promise<any>): Promise<Response | null> {
  if (path === "/sales" && method === "GET") return json(await listSales(env));

  if (path === "/offers" && method === "GET") {
    const now = Date.now();
    const settings = await env.store.listings.settingsAll();
    const rows = (await env.store.messages.offers()).slice(0, 200);
    const out = [];
    for (const o of rows) {
      const label = o.proposal_id ? await env.store.proposals.get(o.proposal_id) : null;
      const open = !o.outcome && !(o.expires_at != null && o.expires_at < now);
      out.push({ ...o, open, waiting_on: open ? (o.code_type === "SellerCounterOffer" ? "buyer" : "you") : null, floor: settings.get(o.item_id)?.floor_price ?? null, label_status: label?.status ?? null, label_result: label?.result ?? null });
    }
    return json({ offers: out, canMessage: await canMessage(env), lastPoll: await env.store.kv.getJson("last_inbox_poll") });
  }

  // Answering an offer whose label was rejected or ran out: a fresh label, which the person then approves.
  if (path === "/offers/answer" && method === "POST") {
    const b = await body();
    const o = await env.store.messages.offer(String(b.bestOfferId ?? ""));
    if (!o) return bad("That offer isn't known", 404);
    if (o.outcome || outcomeOf({ status: o.status ?? "", expiresAt: o.expires_at ?? null } as any)) return bad("That offer is already over");
    const action = ["accept", "counter", "decline"].includes(b.action) ? String(b.action) : null;
    if (!action) return bad("Choose accept, counter or decline");
    const counterPrice = action === "counter" ? Number(b.counterPrice) : null;
    if (action === "counter" && !(counterPrice! > 0)) return bad("A counter-offer needs a price");
    const label = o.proposal_id ? await env.store.proposals.get(o.proposal_id) : null;
    if (label && ["pending", "approved", "applying"].includes(label.status)) return bad("There's already an answer waiting for this offer");
    const p = await createProposal(env, {
      kind: "best_offer_response",
      itemId: o.item_id,
      expiresAt: o.expires_at,
      payload: { itemTitle: o.item_title, bestOfferId: o.best_offer_id, buyer: o.buyer, offerPrice: o.price, listPrice: o.list_price, buyerMessage: o.buyer_message, expiresAt: o.expires_at, fullPrice: o.full_price, action, counterPrice, message: String(b.message ?? "").slice(0, 250), flags: [], editedByK: true },
      reason: "Your answer.",
    });
    await env.store.messages.saveOffer({ best_offer_id: o.best_offer_id, proposal_id: p.id });
    await log(env, "info", "inbox.offer_refiled", { itemId: o.item_id, proposalId: p.id, detail: action });
    return json({ id: p.id });
  }

  if (path === "/conversations" && method === "GET") {
    if (!(await canMessage(env))) return json({ canMessage: false, conversations: [] });
    try {
      const rows = await Promise.all(
        (await getConversations(env)).map(async (c) => {
          const l = c.itemId ? await env.store.listings.latest(c.itemId) : null;
          return { ...c, itemTitle: l?.title ?? null, itemPrice: l?.price ?? null, image: l?.image_url ? `/api/listings/${c.itemId}/image` : null };
        }),
      );
      return json({ canMessage: true, conversations: rows });
    } catch {
      return bad("eBay didn't give the conversations. What it answered is in the log.", 502);
    }
  }
  const one = path.match(/^\/conversations\/([\w.:~-]{1,80})(?:\/(\d{1,5}))?$/);
  if (one && method === "GET") {
    if (!(await canMessage(env))) return bad("Messaging needs a one-off reconnect first", 403);
    try {
      const page = await getConversation(env, one[1], Number(one[2] ?? 0));
      // What was written here for this conversation, so its state (waiting, sent, not sent) shows in the chat.
      const sends = (await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "new_message" }, { f: "created_at", op: ">=", v: Date.now() - 30 * 86_400_000 }]))
        .map((p) => ({ p, a: JSON.parse(p.payload) }))
        .filter(({ a }) => a.conversationId === one[1])
        .map(({ p, a }) => ({ id: p.id, body: String(a.body ?? ""), status: p.status, result: p.result ?? null, at: p.decided_at ?? p.created_at }))
        .sort((x, y) => x.at - y.at);
      return json({ ...page, sends });
    } catch {
      return bad("eBay didn't give that conversation. What it answered is in the log.", 502);
    }
  }
  // A message a person wrote: a label, approved like any other.
  if (path === "/conversations/message" && method === "POST") {
    if (!(await canMessage(env))) return bad("Messaging needs a one-off reconnect first", 403);
    const b = await body();
    const text = String(b.body ?? "").trim().slice(0, 2000);
    const conversationId = /^[\w.:~-]{1,80}$/.test(String(b.conversationId ?? "")) ? String(b.conversationId) : null;
    const recipientId = String(b.recipientId ?? "").trim().slice(0, 64);
    const itemId = /^\d{9,14}$/.test(String(b.itemId ?? "")) ? String(b.itemId) : undefined;
    if (!text) return bad("Write the message");
    if (!conversationId && !recipientId) return bad("Choose who it goes to");
    const p = await createProposal(env, { kind: "new_message", itemId, payload: { itemTitle: itemId ? ((await env.store.listings.latest(itemId))?.title ?? null) : null, conversationId, recipientId, body: text }, reason: "Your message." });
    return json({ id: p.id });
  }
  return null;
}
