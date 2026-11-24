import type { Env } from "../env";
import { log } from "../log";
import { structure } from "./inbox";
import { sellGet } from "./sell";
import { trading } from "./trading";

// eBay's Message API: conversations with buyers. Everything about it that isn't proven is in this file: the scope
// name, the paths, the conversation type and the field names came from eBay's documentation (2026-11-24) and have
// answered by production that day (reads; nothing has been sent yet). Each list read logs its shape.
// Sending is the write gate's (src/ebay/write.ts), for an approved `new_message`.

export const MESSAGE_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.message";
const BASE = "/commerce/message/v1";
export const NEW_MESSAGE_PATH = `${BASE}/send_message`;

/** eBay's word for conversations with other members (its other type is messages from eBay itself). */
const CONVERSATION_TYPE = "FROM_MEMBERS";

export async function canMessage(env: Env): Promise<boolean> {
  const t = await env.store.kv.getEbayTokens();
  return Boolean(t && t.scopes.split(" ").includes(MESSAGE_SCOPE));
}

export interface Conversation {
  id: string;
  otherParty: string;
  itemId: string | null;
  lastText: string;
  /** Whether the latest message is K's. */
  lastMine: boolean;
  lastAt: number | null;
  unread: number;
}

const at = (v: unknown) => (typeof v === "string" ? Date.parse(v) || null : null);
const same = (a: string, b: string) => a !== "" && a.toLowerCase() === b.toLowerCase();

const people = (m: any) => ({ from: String(m?.senderUsername ?? m?.sender?.username ?? ""), to: String(m?.recipientUsername ?? "") });

/**
 * K's own username, as eBay's messages spell it. Production's replies name only each message's sender and recipient
 * (2026-11-24), so the account's own name is what tells the two sides apart. Kept a week; "" when it can't be read.
 */
export async function ownUsername(env: Env): Promise<string> {
  const kept = await env.store.kv.getJson<{ name: string; at: number }>("own_username").catch(() => null);
  if (kept?.name && Date.now() - kept.at < 7 * 86_400_000) return kept.name;
  try {
    const name = String((await trading(env, "GetUser", ""))?.User?.UserID ?? "");
    if (name) await env.store.kv.setJson("own_username", { name, at: Date.now() });
    return name || (kept?.name ?? "");
  } catch (err) {
    await log(env, "warn", "messages.own_name_failed", { job: "messages", err });
    return kept?.name ?? "";
  }
}

export function toConversations(doc: any, own: string): Conversation[] {
  return [doc?.conversations ?? []]
    .flat()
    .map((c: any) => {
      const m = c?.latestMessage ?? c?.lastMessage ?? {};
      const ref = c?.reference?.referenceId ?? c?.referenceId;
      const { from, to } = people(m);
      const named = String(c?.otherPartyUsername ?? c?.otherParty?.username ?? "");
      return {
        id: String(c?.conversationId ?? ""),
        // Whichever of the two isn't K. Without K's own name there's no telling, so nobody is named.
        otherParty: named || (own ? (same(from, own) ? to : from) : ""),
        itemId: /^\d{9,14}$/.test(String(ref ?? "")) ? String(ref) : null,
        lastText: String(m?.messageBody ?? m?.messageText ?? ""),
        lastMine: same(from, own),
        lastAt: at(m?.createdDate ?? c?.lastMessageDate ?? c?.lastModifiedDate),
        unread: Number(c?.unreadCount ?? c?.unreadMessageCount ?? 0),
      };
    })
    .filter((c) => c.id)
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

export interface ChatMessage {
  id: string;
  side: "me" | "buyer" | "unknown";
  text: string;
  at: number | null;
}

/** A page of a conversation, oldest message first whatever order eBay gives. */
export function toMessages(doc: any, own: string): ChatMessage[] {
  const seen = new Set<string>();
  return [doc?.messages ?? []]
    .flat()
    .map((m: any): ChatMessage => {
      const { from, to } = people(m);
      const side = own === "" ? "unknown" : same(from, own) ? "me" : same(to, own) || from !== "" ? "buyer" : "unknown";
      return { id: String(m?.messageId ?? ""), side, text: String(m?.messageBody ?? m?.messageText ?? ""), at: at(m?.createdDate) };
    })
    .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.id < b.id ? -1 : 1));
}

async function read(env: Env, path: string, what: string, quiet = false): Promise<any> {
  try {
    const doc = await sellGet(env, path, { watch: false });
    await log(env, "info", "messages.read", { job: "messages", detail: `${what}: ${structure(doc, 40)}`, lineOnly: quiet });
    return doc;
  } catch (err) {
    await log(env, "warn", "messages.failed", { job: "messages", detail: what, err });
    throw err;
  }
}

export const getConversations = async (env: Env, quiet = false): Promise<Conversation[]> =>
  toConversations(await read(env, `${BASE}/conversation?conversation_type=${CONVERSATION_TYPE}&limit=25`, "conversations", quiet), await ownUsername(env));

const PAGE = 50;

/**
 * One page of a conversation and the offset of the next older one. eBay gives the newest first (seen on production);
 * `older` is null at the start of the conversation.
 */
export async function getConversation(env: Env, id: string, offset = 0): Promise<{ messages: ChatMessage[]; older: number | null }> {
  const doc = await read(env, `${BASE}/conversation/${encodeURIComponent(id)}?conversation_type=${CONVERSATION_TYPE}&limit=${PAGE}&offset=${offset}`, "conversation", true);
  const got = [doc?.messages ?? []].flat().length;
  const next = offset + got;
  return { messages: toMessages(doc, await ownUsername(env)), older: got > 0 && Number(doc?.total ?? 0) > next ? next : null };
}

/** What the gate sends for an approved new_message: a reply in a conversation, or the first message to a buyer. */
export function newMessageBody(a: { conversationId?: unknown; recipientId?: unknown; body?: unknown }, itemId: string | null) {
  const messageText = String(a.body ?? "").trim().slice(0, 2000);
  const to = a.conversationId ? { conversationId: String(a.conversationId) } : { otherPartyUsername: String(a.recipientId ?? "") };
  return { ...to, messageText, ...(itemId && !a.conversationId ? { reference: { referenceType: "LISTING", referenceId: itemId } } : {}) };
}
