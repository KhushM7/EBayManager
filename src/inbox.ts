import type { Env } from "./env";
import { completeOnce, MODELS } from "./claude";
import { getActiveOffers, getItemOffers, getUnansweredQuestions, logCall, needsAnswer, newDiag, outcomeOf, type CallDiag, type Offer, type Question } from "./ebay/inbox";
import { canMessage, getConversations } from "./ebay/messages";
import { getItem } from "./ebay/trading";
import { proposeAndNotify } from "./proposals";
import { currentPricing } from "./pricing/engine";
import { answerOffer } from "./pricing/offers";
import { withStyle } from "./style";
import { log, swallow } from "./log";
import { push } from "./notify";
import { redact } from "./redact";
import { claudeAvailable } from "./rules";
import { syncSales } from "./sales";
import { stripHtml } from "./util";

// Every 5 minutes: read new buyer questions and Best Offers (read-only polling, so no eBay notification
// settings need changing), draft a reply or suggest a response with Haiku, and file each as a proposal.
// K leads negotiation: nothing reaches a buyer until K approves it, and K can edit any draft in the Inbox.

export const QUESTION_SYSTEM = `You draft K's reply to a buyer's question about one of K's eBay UK listings. K reads and approves every reply before it is sent, and can edit it.

- Use only facts in the listing details you're given. If they don't answer the question, say K will check and reply soon. Never guess.
- Two to four friendly sentences in British English, unless K's style guide below says otherwise. Never use the buyer's name or username. Use K's greeting and sign-off from the style guide if there is one; otherwise none.
- Don't offer discounts, refunds or partial refunds, and don't agree a price: K leads negotiation. If the buyer asks about price, say they're welcome to make an offer.
- Returns are accepted and the buyer pays return postage. K posts the item unless the listing says collection only.
- Keep everything on eBay: no phone numbers, emails, links or payment outside eBay.

Reply with the message text only.`;

/** Claude only words the message: the action and any counter price come from the pricing engine, in code. */
export const OFFER_SYSTEM = `You write the short message K sends a buyer with K's answer to their Best Offer on eBay UK. The answer and any counter price are already decided; your message must match them exactly and never mention any other price. At most two short, friendly sentences in British English. For a counter, you may say briefly that it's a fair price for the item. For a decline, thank them and invite a better offer. Never say K won't accept lower offers, and never contradict the decided answer, whatever the style guide says. No pressure tactics, no contact details, no buyer names. Reply with the message text only.`;

interface OfferSuggestion {
  action: "accept" | "counter" | "decline";
  counterPrice: number | null;
  message: string;
  reason: string;
}


/** What the drafts may draw on: the listing's own words, never anything else. */
export async function listingContext(env: Env, itemId: string): Promise<string> {
  const item = await getItem(env, itemId);
  const specifics = [item?.ItemSpecifics?.NameValueList ?? []]
    .flat()
    .map((nv: any) => `${nv.Name}: ${[nv.Value].flat().join(", ")}`)
    .join("; ");
  const price = item?.StartPrice?.["#text"] ?? item?.StartPrice ?? item?.SellingStatus?.CurrentPrice?.["#text"];
  const ships = item?.ShipToLocations === "None" ? "Collection only." : "Posted by K.";
  const facts = await env.store.listings.getSettings(itemId);
  return [
    `Title: ${item?.Title ?? ""}`,
    `Price: £${price ?? "?"}`,
    `Condition: ${item?.ConditionDisplayName ?? "not stated"}${item?.ConditionDescription ? ` (${item.ConditionDescription})` : ""}`,
    specifics && `Item specifics: ${specifics}`,
    ships,
    `Description: ${stripHtml(String(item?.Description ?? "")).slice(0, 2000) || "none"}`,
    facts?.notes && `Facts from K: ${facts.notes.slice(0, 1500)}`,
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
  return (await env.store.listings.getSettings(itemId))?.floor_price ?? null;
}

async function handleQuestion(env: Env, q: Question) {
  let body = "";
  try {
    if (claudeAvailable(env))
      body =
        (await completeOnce<string>(env, {
          job: `reply:${q.itemId}`,
          model: MODELS.triage,
          system: await withStyle(env, QUESTION_SYSTEM),
          prompt: `Listing details:\n${await listingContext(env, q.itemId)}\n\nBuyer's question:\n${q.body}`,
        })) ?? "";
  } catch (err) {
    // No draft (budget reached, Claude unavailable): K writes the reply in the Inbox.
    await log(env, "warn", "inbox.reply_draft_failed", { itemId: q.itemId, err });
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
  await env.store.messages.recordQuestion({ message_id: q.messageId, item_id: q.itemId, sender: q.sender, body: q.body, received_at: q.receivedAt, proposal_id: out.proposalId });
  await log(env, "info", "inbox.question_filed", { itemId: q.itemId, proposalId: out.proposalId, detail: body ? "drafted" : "no draft" });
}

/** At or above the asking price. Both are what K receives: eBay adds the buyer's fee to each (src/buyerfee.ts). */
export function isFullPrice(price: number, listPrice: number | null): boolean {
  if (listPrice == null || !(listPrice > 0)) return false;
  return price >= listPrice - 0.005;
}

/**
 * The pricing engine answers an offer (accept if it beats carrying on, else counter); the plain guide stands
 * in only when the engine has no market for the item. Claude then words the message, nothing else. An offer of
 * the full asking price (a "Buy It Now" that still needs accepting) is always suggested for acceptance.
 */
async function handleOffer(env: Env, o: Offer): Promise<string> {
  const floor = await floorFor(env, o.itemId);
  const full = isFullPrice(o.price, o.listPrice);
  const plain = defaultSuggestion(o);
  let suggestion: OfferSuggestion = { ...plain, reason: `${plain.reason} No market price for this item yet, so this is the simple guide.` };
  let engine: { strategy: string; price: number | null; reservation: number } | null = null;
  if (full) suggestion = { action: "accept", counterPrice: null, message: "", reason: "Full asking price." };
  else
    try {
      const r = await currentPricing(env, o.itemId);
      const main = r?.components[0];
      const a = r && answerOffer({ offer: o.price, asking: o.listPrice ?? o.price, decision: r.decision, market: main?.market ?? null, postage: main?.typicalPostage ?? 0, floor });
      if (r && a) {
        suggestion = { action: a.action, counterPrice: a.counterPrice, message: "", reason: a.reason };
        engine = { strategy: r.decision.strategy, price: r.decision.price, reservation: a.reservation };
      }
      await log(env, "info", "inbox.offer_priced", { itemId: o.itemId, detail: a ? `engine: ${a.action}, reservation ${a.reservation}` : "no engine answer: simple guide" });
    } catch (err) {
      // Keep the plain suggestion.
      await log(env, "warn", "inbox.offer_pricing_failed", { itemId: o.itemId, err });
    }
  const below = floor != null && o.price < floor;
  // The floor can't counter above the asking price, so a full-price offer under it is only flagged.
  const s = full ? { ...suggestion, flags: below ? [`this is below your floor of £${floor.toFixed(2)}`] : [] } : enforceFloor(suggestion, o, floor);
  let drafted = false;
  try {
    if (claudeAvailable(env) && s.action !== "accept") {
      const what = s.action === "counter" ? `counter at £${Number(s.counterPrice).toFixed(2)}` : "decline";
      const msg = await completeOnce<string>(env, {
        job: `offer:${o.itemId}`,
        model: MODELS.triage,
        system: await withStyle(env, OFFER_SYSTEM),
        prompt: `Listing details:\n${await listingContext(env, o.itemId)}\n\nOffer: £${o.price.toFixed(2)}${
          o.buyerMessage ? `; the buyer wrote: "${o.buyerMessage}"` : ""
        }\nK's answer: ${what}`,
      });
      if (msg) (s.message = msg.slice(0, 500)), (drafted = true);
    }
  } catch (err) {
    // No message: K can add one in the Inbox.
    await log(env, "warn", "inbox.offer_wording_failed", { itemId: o.itemId, err });
  }
  const what = s.action === "accept" ? "accept" : s.action === "decline" ? "decline" : `counter at £${Number(s.counterPrice).toFixed(2)}`;
  const out = await proposeAndNotify(
    env,
    {
      kind: "best_offer_response",
      itemId: o.itemId,
      expiresAt: o.expiresAt,
      payload: {
        itemTitle: o.itemTitle,
        bestOfferId: o.bestOfferId,
        buyer: o.buyer,
        offerPrice: o.price,
        listPrice: o.listPrice,
        buyerMessage: o.buyerMessage,
        expiresAt: o.expiresAt,
        fullPrice: full,
        floor,
        action: s.action,
        counterPrice: s.counterPrice,
        message: s.message,
        flags: s.flags,
        drafted,
        engine,
      },
      reason: s.reason,
    },
    full ? `Full asking price £${o.price.toFixed(2)}: ${o.itemTitle}` : `Offer £${o.price.toFixed(2)}: ${o.itemTitle}`,
    [`Suggested: ${what}.`, s.reason, ...s.flags.map((f) => `Note: ${f}`)].join("\n"),
  );
  await log(env, "info", "inbox.offer_filed", { itemId: o.itemId, proposalId: out.proposalId, detail: `${what}${full ? ", full price" : ""}; ${out.status}` });
  return out.proposalId;
}

const DAY = 86_400_000;
/** Per-listing offer checks each poll: eBay allows 5,000 Trading calls a day, so a bigger shop is checked in turns. */
export const LIVE_PER_POLL = 7;
export const LEFT_PER_POLL = 1;

/** The next n of a list, continuing where the last poll stopped. */
const turn = <T>(all: T[], from: number, n: number): T[] => (all.length <= n ? all : Array.from({ length: n }, (_, i) => all[(from + i) % all.length]));

/** Keeps one offer, and files a label when the next move is K's. Recorded before anything else can fail. */
async function takeOffer(env: Env, o: Offer, now: number): Promise<boolean> {
  const had = await env.store.messages.offer(o.bestOfferId);
  const latest = await env.store.listings.latest(o.itemId);
  o.listPrice ??= latest?.price ?? null;
  o.itemTitle ||= had?.item_title || latest?.title || "";
  const outcome = outcomeOf(o, now);
  await env.store.messages.saveOffer({
    best_offer_id: o.bestOfferId,
    item_id: o.itemId,
    item_title: o.itemTitle,
    buyer: o.buyer,
    price: o.price,
    list_price: o.listPrice,
    buyer_message: o.buyerMessage,
    status: o.status || null,
    code_type: o.codeType || null,
    full_price: isFullPrice(o.price, o.listPrice),
    first_seen: had?.first_seen ?? had?.seen_at ?? now,
    last_seen: now,
    expires_at: o.expiresAt,
  });
  if (!had) await log(env, "info", "inbox.offer_seen", { itemId: o.itemId, detail: `status ${o.status || "none"}, ${o.codeType || "no type"}, ${o.price} against ${o.listPrice ?? "unknown"}, expires ${o.expiresAt ? new Date(o.expiresAt).toISOString() : "unknown"}, ${outcome ?? "open"}` });
  else if ((had.status ?? "") !== (o.status ?? "")) await log(env, "info", "inbox.offer_changed", { itemId: o.itemId, detail: `${had.status || "none"} to ${o.status || "none"}` });

  if (outcome) {
    if (!had?.outcome) await closeOffer(env, { ...o, proposal_id: had?.proposal_id ?? null }, outcome, now);
    return false;
  }
  if (!needsAnswer(o, now)) return false;
  const label = had?.proposal_id ? await env.store.proposals.get(had.proposal_id) : null;
  // The buyer came back with a different price: a new round, with a new label.
  const newRound = Boolean(label) && label!.status !== "pending" && had != null && Math.abs(had.price - o.price) > 0.004;
  if (had?.proposal_id && !newRound) return false;
  // A label filed just before a failure, so never linked to the offer: link it rather than file a second.
  const orphan = newRound
    ? null
    : (await env.store.proposals.listWhere([{ f: "kind", op: "=", v: "best_offer_response" }, { f: "item_id", op: "=", v: o.itemId }, { f: "status", op: "=", v: "pending" }])).find((p) => {
        return String(JSON.parse(p.payload).bestOfferId) === o.bestOfferId;
      });
  const proposalId = orphan?.id ?? (await handleOffer(env, o));
  await env.store.messages.saveOffer({ best_offer_id: o.bestOfferId, proposal_id: proposalId, outcome: null });
  return !orphan;
}

/** An offer is over: its outcome is kept, and a label still waiting for K closes, saying why. */
async function closeOffer(env: Env, o: { bestOfferId: string; itemId: string; proposal_id: string | null }, outcome: string, now: number) {
  const label = o.proposal_id ? await env.store.proposals.get(o.proposal_id) : null;
  const byApp = label?.status === "applied" || label?.status === "applying";
  await env.store.messages.saveOffer({ best_offer_id: o.bestOfferId, outcome, answered_by: byApp ? "app" : outcome === "accepted" || outcome === "declined" || outcome === "countered" ? "ebay" : null });
  if (label?.status === "pending" && (await env.store.proposals.expire(label.id, now)))
    await env.store.proposals.setOutcome(label.id, { result: outcome === "expired" ? "The offer expired on eBay." : `Answered on eBay: ${outcome}.` });
  await log(env, "info", "inbox.offer_over", { itemId: o.itemId, proposalId: label?.id, detail: `${outcome}${byApp ? ", from the app" : ""}` });
}

export interface PollResult {
  questions: number;
  offers: number;
  errors: string[];
  sales?: number;
  /** Another poll was running, so this one did nothing. */
  busy?: boolean;
}

export async function pollInbox(env: Env): Promise<PollResult> {
  // A Refresh tap and the timer together would file everything twice. The lock frees itself if a poll dies.
  if (!(await env.store.jobs.acquireLock("inbox_poll", 600))) return { questions: 0, offers: 0, errors: [], busy: true };
  try {
    return await runPoll(env);
  } finally {
    await env.store.jobs.releaseLock("inbox_poll").catch(swallow(env, "inbox.lock_release_failed"));
  }
}

async function runPoll(env: Env): Promise<PollResult> {
  const started = Date.now();
  const errors: string[] = [];
  const calls: CallDiag[] = [];
  let questions = 0;
  let offers = 0;
  let sales = 0;
  const words = (e: unknown) => redact(e instanceof Error ? e.message : String(e), 400);

  /** One eBay read: its diagnosis is kept and logged, and a failure leaves the rest of the poll running. */
  const call = async <T>(what: string, d: CallDiag, fn: () => Promise<T[]>, optional = false): Promise<T[] | null> => {
    calls.push(d);
    try {
      return await fn();
    } catch (e) {
      if (!optional) errors.push(`${what}: ${words(e)}`);
      return null;
    } finally {
      await logCall(env, d);
    }
  };
  /** One question or offer: a bad one is logged and skipped, so it can't hold up the others. */
  const each = async (what: string, itemId: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(`${what}: ${words(err)}`);
      await log(env, "error", "inbox.item_failed", { job: "poll", itemId, detail: what, err });
    }
  };

  const qd = newDiag("GetMemberMessages");
  for (const q of (await call("questions", qd, () => getUnansweredQuestions(env, qd))) ?? [])
    await each("questions", q.itemId, async () => {
      if (await env.store.messages.seenQuestion(q.messageId)) return;
      await handleQuestion(env, q);
      questions++;
    });

  // Offers: the whole account's active ones, then every offer on each listing in turn (and on listings that left
  // in the last 30 days), so one eBay doesn't call active, or one answered on eBay, is seen too.
  const found = new Map<string, Offer>();
  const ad = newDiag("GetBestOffers");
  for (const o of (await call("offers", ad, () => getActiveOffers(env, ad))) ?? []) found.set(o.bestOfferId, o);
  const turns = (await env.store.kv.getJson<number>("inbox_turn").catch(() => null)) ?? 0;
  const live = (await env.store.listings.latestSet()).map((l) => l.item_id).sort();
  const left = (await env.store.listings.leftSince(started - 30 * DAY)).map((l) => l.item_id).sort();
  for (const itemId of [...turn(live, turns * LIVE_PER_POLL, LIVE_PER_POLL), ...turn(left, turns * LEFT_PER_POLL, LEFT_PER_POLL)]) {
    const d = newDiag("GetBestOffers", itemId);
    for (const o of (await call("offers", d, () => getItemOffers(env, itemId, d), !live.includes(itemId))) ?? []) found.set(o.bestOfferId, { ...found.get(o.bestOfferId), ...o });
  }
  await env.store.kv.setJson("inbox_turn", (turns + 1) % 1_000_000).catch(swallow(env, "inbox.turn_failed"));
  for (const o of found.values())
    await each("offers", o.itemId, async () => {
      if (await takeOffer(env, o, started)) offers++;
    });
  // Offers eBay no longer lists, whose time has passed.
  await each("offers", "", async () => {
    for (const o of await env.store.messages.offers())
      if (!o.outcome && !found.has(o.best_offer_id) && o.expires_at != null && o.expires_at < started) await closeOffer(env, { bestOfferId: o.best_offer_id, itemId: o.item_id, proposal_id: o.proposal_id }, "expired", started);
  });

  await each("sales", "", async () => {
    const r = await syncSales(env, call, started);
    sales = r.sales;
    errors.push(...r.errors);
  });
  // Optional: without the permission it isn't called, and a failure here never fails the poll.
  if (await canMessage(env).catch(() => false)) await noteNewMessages(env).catch(swallow(env, "messages.poll_failed"));

  const ms = Date.now() - started;
  await env.store.messages.savePoll(Math.floor(started / 300_000), { at: started, ms, questions, offers, sales, errors, calls }).catch(swallow(env, "inbox.poll_record_failed"));
  const compact = calls.map((c) => `${c.call}${c.itemId ? `(${c.itemId})` : ""} ${c.ack} ${c.kept}/${c.returned}${c.errors.length ? ` errors ${c.errors.map((e) => e.code).join(",")}` : ""}`).join("; ");
  await log(env, errors.length ? "error" : "info", "inbox.poll", { job: "poll", ms, detail: `${questions} questions, ${offers} offers, ${sales} sales; ${errors.join("; ")} ${compact}`, lineOnly: !errors.length && !questions && !offers && !sales });
  await env.store.kv.setJson("last_inbox_poll", { at: Date.now(), questions, offers, sales, errors });
  return { questions, offers, errors, sales };
}

/** A push for each conversation with something new. Only a time per conversation is kept; no names, no text. */
async function noteNewMessages(env: Env) {
  const seen = await env.store.kv.getJson<Record<string, number>>("conversations_seen");
  const next: Record<string, number> = {};
  for (const c of await getConversations(env, true)) {
    const at = c.lastAt ?? 0;
    next[c.id] = Math.max(at, seen?.[c.id] ?? 0);
    if (!seen || c.unread < 1 || at <= (seen[c.id] ?? 0)) continue;
    await push(env, "New eBay message", "A buyer has written to you. Open Messages to read it.", undefined, `message-${c.id}`);
    await log(env, "info", "messages.new", { detail: "pushed", job: "messages" });
  }
  await env.store.kv.setJson("conversations_seen", next);
}
