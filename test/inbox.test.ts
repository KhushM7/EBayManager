import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import { parseTradingResponse } from "../src/ebay/trading";
import { toOffers, toQuestions, type Offer } from "../src/ebay/inbox";
import { callFor, setWritesPaused } from "../src/ebay/write";
import { defaultSuggestion, enforceFloor, pollInbox } from "../src/inbox";
import { applyApproved, createProposal, decide, editProposal, getProposal, listProposals } from "../src/proposals";

const QUESTIONS = `<GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><MemberMessage>
  <MemberMessageExchange><Item><ItemID>110591497601</ItemID><Title>White Mug</Title></Item>
    <Question><MessageType>AskSellerQuestion</MessageType><SenderID>buyer_one</SenderID><Body>Is it dishwasher safe?</Body><MessageID>m1</MessageID></Question>
    <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-11-01T10:00:00.000Z</CreationDate></MemberMessageExchange>
  <MemberMessageExchange><Item><ItemID>110591497601</ItemID><Title>White Mug</Title></Item>
    <Question><MessageType>AskSellerQuestion</MessageType><SenderID>buyer_two</SenderID><Body>Would you post to Leeds?</Body><MessageID>m2</MessageID></Question>
    <MessageStatus>Unanswered</MessageStatus><CreationDate>2026-11-01T11:00:00.000Z</CreationDate></MemberMessageExchange>
</MemberMessage></GetMemberMessagesResponse>`;

const OFFERS = `<GetBestOffersResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><ItemBestOffersArray><ItemBestOffers>
  <Item><ItemID>110591497965</ItemID><Title>Board Game</Title><BuyItNowPrice currencyID="GBP">12.0</BuyItNowPrice></Item>
  <BestOfferArray><BestOffer><BestOfferID>bo1</BestOfferID><Price currencyID="GBP">9.0</Price><Buyer><UserID>offer_buyer</UserID></Buyer>
    <BuyerMessage>Would you take 9?</BuyerMessage><ExpirationTime>2026-11-03T10:00:00.000Z</ExpirationTime><Status>Pending</Status></BestOffer></BestOfferArray>
</ItemBestOffers></ItemBestOffersArray></GetBestOffersResponse>`;

const ITEM = `<GetItemResponse><Ack>Success</Ack><Item><ItemID>1</ItemID><Title>Thing</Title><StartPrice currencyID="GBP">12.0</StartPrice></Item></GetItemResponse>`;

const offer: Offer = { bestOfferId: "bo", itemId: "1", itemTitle: "T", listPrice: 12, price: 9, buyer: "b", buyerMessage: "", expiresAt: null };

describe("reading questions and offers", () => {
  it("parses unanswered questions", () => {
    const qs = toQuestions(parseTradingResponse("GetMemberMessages", QUESTIONS));
    expect(qs.map((q) => [q.messageId, q.itemId, q.sender, q.body])).toEqual([
      ["m1", "110591497601", "buyer_one", "Is it dishwasher safe?"],
      ["m2", "110591497601", "buyer_two", "Would you post to Leeds?"],
    ]);
  });

  it("parses Best Offers with the listing price", () => {
    const [o] = toOffers(parseTradingResponse("GetBestOffers", OFFERS));
    expect(o).toMatchObject({ bestOfferId: "bo1", itemId: "110591497965", listPrice: 12, price: 9, buyer: "offer_buyer", buyerMessage: "Would you take 9?" });
  });
});

describe("reply and offer builders", () => {
  const build = (kind: any, payload: object) => callFor({ kind, item_id: "1", payload: JSON.stringify(payload) });

  it("sends a reply to the right question and buyer", () => {
    const { call, xml } = build("message", { body: "Yes, it is.", parentMessageId: "m1", recipientId: "buyer_one" });
    expect(call).toBe("AddMemberMessageRTQ");
    expect(xml).toContain("<ParentMessageID>m1</ParentMessageID><RecipientID>buyer_one</RecipientID>");
  });

  it("refuses an empty reply and a counter with no price", () => {
    expect(() => build("message", { body: "  ", parentMessageId: "m1", recipientId: "b" })).toThrow(/empty/);
    expect(() => build("best_offer_response", { bestOfferId: "bo", action: "counter", counterPrice: null })).toThrow(/price/);
  });

  it("builds accept and counter responses", () => {
    expect(build("best_offer_response", { bestOfferId: "bo", action: "accept" }).xml).toContain("<Action>Accept</Action>");
    const counter = build("best_offer_response", { bestOfferId: "bo", action: "counter", counterPrice: 10.5, message: "Meet me at £10.50?" });
    expect(counter.call).toBe("RespondToBestOffer");
    expect(counter.xml).toContain('<CounterOfferPrice currencyID="GBP">10.50</CounterOfferPrice>');
  });
});

describe("offer suggestions", () => {
  it("never accepts or counters below K's floor", () => {
    const accept = enforceFloor({ action: "accept", counterPrice: null, message: "", reason: "" }, offer, 10);
    expect(accept).toMatchObject({ action: "counter", counterPrice: 10 });
    expect(accept.flags).toHaveLength(1);
    expect(enforceFloor({ action: "counter", counterPrice: 9.5, message: "", reason: "" }, offer, 10).counterPrice).toBe(10);
    expect(enforceFloor({ action: "decline", counterPrice: null, message: "", reason: "" }, offer, 10).flags).toEqual([]);
  });

  it("suggests accepting close offers and meeting halfway otherwise", () => {
    expect(defaultSuggestion({ ...offer, price: 11.5 }).action).toBe("accept");
    expect(defaultSuggestion(offer)).toMatchObject({ action: "counter", counterPrice: 10.5 });
  });
});

describe("inbox poll", () => {
  let env: Env;
  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const call = (init.headers as Record<string, string>)["X-EBAY-API-CALL-NAME"];
        if (call === "AddMemberMessageRTQ") return new Response("<AddMemberMessageRTQResponse><Ack>Success</Ack></AddMemberMessageRTQResponse>");
        return new Response(call === "GetMemberMessages" ? QUESTIONS : call === "GetBestOffers" ? OFFERS : ITEM);
      }),
    );
    env = { DB: fakeD1(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", EBAY_SITE_ID: "3", NTFY_TOPIC: "", SIGNING_KEY: "k" } as Env;
    await env.DB.prepare(
      "INSERT INTO ebay_tokens (id, access_token, access_expires_at, refresh_token, refresh_expires_at, scopes) VALUES (1, 't', ?, 'r', ?, 's')",
    )
      .bind(Date.now() + 3_600_000, Date.now() + 3_600_000)
      .run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("files one proposal per question and offer, once, without superseding", async () => {
    expect(await pollInbox(env)).toEqual({ questions: 2, offers: 1, errors: [] });
    const pending = await listProposals(env);
    expect(pending.map((p) => p.kind).sort()).toEqual(["best_offer_response", "message", "message"]);
    // Without an API key the replies wait for K to write them, and the offer gets the plain suggestion.
    const offerP = pending.find((p) => p.kind === "best_offer_response")!;
    expect(JSON.parse(offerP.payload)).toMatchObject({ action: "counter", counterPrice: 10.5, drafted: false });
    expect(await pollInbox(env)).toEqual({ questions: 0, offers: 0, errors: [] });
  });

  it("lets K write the reply, then sends it on approval", async () => {
    await pollInbox(env);
    const msg = (await listProposals(env)).find((p) => p.kind === "message")!;
    expect(await decide(env, msg.id, "approve")).toMatch(/^Not approved yet: The reply is empty/);
    expect((await getProposal(env, msg.id))?.status).toBe("pending");

    expect(await editProposal(env, msg.id, { body: "Yes, it's dishwasher safe." })).toBe("Saved");
    expect(await decide(env, msg.id, "approve")).toBe("AddMemberMessageRTQ ok");
  });

  it("only lets K edit replies and offer responses", async () => {
    const p = await createProposal(env, { kind: "price", itemId: "1", payload: { newPrice: 5 } });
    expect(await editProposal(env, p.id, { body: "x" })).toMatch(/can't be edited/);
  });
});

describe("resuming writes", () => {
  it("applies what K approved while paused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<ReviseFixedPriceItemResponse><Ack>Success</Ack></ReviseFixedPriceItemResponse>`)));
    const env = { DB: fakeD1(), EBAY_ENV: "sandbox", WRITE_MODE: "approval", EBAY_SITE_ID: "3", NTFY_TOPIC: "", SIGNING_KEY: "k" } as Env;
    await env.DB.prepare(
      "INSERT INTO ebay_tokens (id, access_token, access_expires_at, refresh_token, refresh_expires_at, scopes) VALUES (1, 't', ?, 'r', ?, 's')",
    )
      .bind(Date.now() + 3_600_000, Date.now() + 3_600_000)
      .run();
    await setWritesPaused(env, true);
    const p = await createProposal(env, { kind: "price", itemId: "1", payload: { newPrice: 5 } });
    expect(await decide(env, p.id, "approve")).toMatch(/paused/);
    await setWritesPaused(env, false);
    expect((await applyApproved(env)).map((r) => r.result)).toEqual(["ReviseFixedPriceItem ok"]);
    expect((await getProposal(env, p.id))?.status).toBe("applied");
    vi.unstubAllGlobals();
  });
});
