import type { Env } from "./env";
import { completeOnce, MODELS } from "./claude";
import { getActiveOffers, getUnansweredQuestions, type Offer, type Question } from "./ebay/inbox";
import { getItem } from "./ebay/trading";
import { proposeAndNotify } from "./proposals";

// Every 15 minutes: read new buyer questions and Best Offers (read-only polling, so no eBay notification
// settings need changing), draft a reply or suggest a response with Haiku, and file each as a proposal.
// K leads negotiation: nothing reaches a buyer until K approves it, and K can edit any draft in the Inbox.

export const QUESTION_SYSTEM = `You draft K's reply to a buyer's question about one of K's eBay UK listings. K reads and approves every reply before it is sent, and can edit it.

- Use only facts in the listing details you're given. If they don't answer the question, say K will check and reply soon. Never guess.
- Two to four friendly sentences in British English. No greeting line with a name, no sign-off.
- Don't offer discounts or agree a price: K leads negotiation. If the buyer asks about price, say they're welcome to make an offer.
- Returns are accepted and the buyer pays return postage. K posts the item unless the listing says collection only.
- Keep everything on eBay: no phone numbers, emails, links or payment outside eBay.

Reply with the message text only.`;

export const OFFER_SYSTEM = `You suggest how K should answer a Best Offer on one of K's eBay UK listings. K decides: your suggestion is shown to K with Approve, Reject and Edit.

K prices at the lower end of comparable sold prices, so the asking price is already competitive. As a guide: accept offers within about 5% of the asking price; counter offers 5 to 20% below with a price between the offer and the asking price; for offers more than 20% below, counter if the buyer seems genuine, otherwise decline. Never go below K's floor price when one is given.

counterPrice is set only when action is "counter", and the message must match the action: a decline doesn't propose a price.

The message to the buyer is optional, at most two short sentences, friendly, British English.`;

const OFFER_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["accept", "counter", "decline"] },
    counterPrice: { type: ["number", "null"] },
    message: { type: "string" },
    reason: { type: "string" },
  },
  required: ["action", "counterPrice", "message", "reason"],
  additionalProperties: false,
};

interface OfferSuggestion {
  action: "accept" | "counter" | "decline";
  counterPrice: number | null;
  message: string;
  reason: string;
}

const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** What the drafts may draw on: the listing's own words, never anything else. */
export async function listingContext(env: Env, itemId: string): Promise<string> {
  const item = await getItem(env, itemId);
  const specifics = [item?.ItemSpecifics?.NameValueList ?? []]
    .flat()
    .map((nv: any) => `${nv.Name}: ${[nv.Value].flat().join(", ")}`)
    .join("; ");
  const price = item?.StartPrice?.["#text"] ?? item?.StartPrice ?? item?.SellingStatus?.CurrentPrice?.["#text"];
  const ships = item?.ShipToLocations === "None" ? "Collection only." : "Posted by K.";
  return [
    `Title: ${item?.Title ?? ""}`,
    `Price: £${price ?? "?"}`,
    `Condition: ${item?.ConditionDisplayName ?? "not stated"}${item?.ConditionDescription ? ` (${item.ConditionDescription})` : ""}`,
    specifics && `Item specifics: ${specifics}`,
    ships,
    `Description: ${stripHtml(String(item?.Description ?? "")).slice(0, 2000) || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Applies K's floor to a suggestion, in code: never accept or counter below it. A "decline" that names a
 * counter price is a counter, so what eBay receives matches the message to the buyer.
 */
export function enforceFloor(suggestion: OfferSuggestion, offer: Offer, floor: number | null): OfferSuggestion & { flags: string[] } {
  const s: OfferSuggestion =
    suggestion.action === "decline" && Number(suggestion.counterPrice) > 0 ? { ...suggestion, action: "counter" } : suggestion;
  const flags: string[] = [];
  if (floor == null) return { ...s, flags };
  if (s.action === "accept" && offer.price < floor) {
    flags.push(`the offer is below your floor of £${floor.toFixed(2)}, so this counters at the floor instead of accepting`);
    return { ...s, action: "counter", counterPrice: floor, flags };
  }
  if (s.action === "counter" && (s.counterPrice ?? 0) < floor) {
    flags.push(`counter raised to your floor of £${floor.toFixed(2)}`);
    return { ...s, counterPrice: floor, flags };
  }
  return { ...s, flags };
}

/** Without Claude: a plain suggestion from the same guide, for K to adjust. */
export function defaultSuggestion(offer: Offer): OfferSuggestion {
  const list = offer.listPrice ?? offer.price;
  const gap = list > 0 ? (list - offer.price) / list : 0;
  if (gap <= 0.05) return { action: "accept", counterPrice: null, message: "", reason: "Within 5% of the asking price." };
  const counter = Math.round(((offer.price + list) / 2) * 2) / 2;
  return { action: "counter", counterPrice: counter, message: "", reason: `${Math.round(gap * 100)}% below the asking price; meets halfway.` };
}

async function floorFor(env: Env, itemId: string) {
  const row = await env.DB.prepare("SELECT floor_price FROM item_settings WHERE item_id = ?").bind(itemId).first<{ floor_price: number | null }>();
  return row?.floor_price ?? null;
}

async function handleQuestion(env: Env, q: Question) {
  let body = "";
  try {
    if (env.ANTHROPIC_API_KEY)
      body =
        (await completeOnce<string>(env, {
          job: `reply:${q.itemId}`,
          model: MODELS.triage,
          system: QUESTION_SYSTEM,
          prompt: `Listing details:\n${await listingContext(env, q.itemId)}\n\nBuyer's question:\n${q.body}`,
        })) ?? "";
  } catch {
    // No draft (budget reached, Claude unavailable): K writes the reply in the Inbox.
  }
  const out = await proposeAndNotify(
    env,
    {
      kind: "message",
      itemId: q.itemId,
      payload: { itemTitle: q.itemTitle, parentMessageId: q.messageId, recipientId: q.sender, question: q.body, body },
      reason: body ? "Drafted from the listing's own details." : "No draft yet: write the reply in the Inbox.",
    },
    `Question: ${q.itemTitle}`,
    body ? `"${q.body}"\n\nDraft reply: ${body}` : `"${q.body}"\n\nOpen the app to write a reply.`,
    { links: Boolean(body) },
  );
  await env.DB.prepare("INSERT INTO buyer_messages (message_id, item_id, sender, body, received_at, proposal_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(q.messageId, q.itemId, q.sender, q.body, q.receivedAt, out.proposalId)
    .run();
}

async function handleOffer(env: Env, o: Offer) {
  const floor = await floorFor(env, o.itemId);
  let suggestion = defaultSuggestion(o);
  let drafted = false;
  try {
    if (env.ANTHROPIC_API_KEY) {
      const s = await completeOnce<OfferSuggestion>(env, {
        job: `offer:${o.itemId}`,
        model: MODELS.triage,
        system: OFFER_SYSTEM,
        prompt: `Listing details:\n${await listingContext(env, o.itemId)}\n\nOffer: £${o.price.toFixed(2)} from ${o.buyer}${
          o.buyerMessage ? `, who wrote: "${o.buyerMessage}"` : ""
        }\nK's floor price: ${floor == null ? "not set" : `£${floor.toFixed(2)}`}`,
        schema: OFFER_SCHEMA,
      });
      if (s) (suggestion = s), (drafted = true);
    }
  } catch {
    // Keep the plain suggestion.
  }
  const s = enforceFloor(suggestion, o, floor);
  const what = s.action === "accept" ? "accept" : s.action === "decline" ? "decline" : `counter at £${Number(s.counterPrice).toFixed(2)}`;
  const out = await proposeAndNotify(
    env,
    {
      kind: "best_offer_response",
      itemId: o.itemId,
      payload: {
        itemTitle: o.itemTitle,
        bestOfferId: o.bestOfferId,
        buyer: o.buyer,
        offerPrice: o.price,
        listPrice: o.listPrice,
        buyerMessage: o.buyerMessage,
        expiresAt: o.expiresAt,
        action: s.action,
        counterPrice: s.counterPrice,
        message: s.message,
        flags: s.flags,
        drafted,
      },
      reason: s.reason,
    },
    `Offer £${o.price.toFixed(2)}: ${o.itemTitle}`,
    [`Suggested: ${what}.`, s.reason, ...s.flags.map((f) => `Note: ${f}`)].join("\n"),
  );
  await env.DB.prepare("INSERT INTO best_offers (best_offer_id, item_id, buyer, price, seen_at, proposal_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(o.bestOfferId, o.itemId, o.buyer, o.price, Date.now(), out.proposalId)
    .run();
}

export async function pollInbox(env: Env): Promise<{ questions: number; offers: number; errors: string[] }> {
  const errors: string[] = [];
  let questions = 0;
  let offers = 0;
  const seen = async (table: "buyer_messages" | "best_offers", col: string, id: string) =>
    Boolean(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ?`).bind(id).first());

  try {
    for (const q of await getUnansweredQuestions(env)) {
      if (await seen("buyer_messages", "message_id", q.messageId)) continue;
      await handleQuestion(env, q);
      questions++;
    }
  } catch (e) {
    errors.push(`questions: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    for (const o of await getActiveOffers(env)) {
      if (await seen("best_offers", "best_offer_id", o.bestOfferId)) continue;
      await handleOffer(env, o);
      offers++;
    }
  } catch (e) {
    errors.push(`offers: ${e instanceof Error ? e.message : String(e)}`);
  }
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_inbox_poll', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ at: Date.now(), questions, offers, errors }))
    .run();
  return { questions, offers, errors };
}
