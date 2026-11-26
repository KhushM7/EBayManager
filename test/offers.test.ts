// Reading offers, sales and messages, and what's logged on the way.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { consentScopes, FULL_SCOPES, READONLY_SCOPES } from "../src/ebay/auth";
import { needsAnswer, outcomeOf, structure, toOffers, toSoldLines } from "../src/ebay/inbox";
import { MESSAGE_SCOPE, toConversations, toMessages } from "../src/ebay/messages";
import { openOfferCount, parseTradingResponse } from "../src/ebay/trading";
import { callFor } from "../src/ebay/write";
import { forgetUser } from "../src/deletion";
import { isFullPrice, LIVE_PER_POLL, pollInbox } from "../src/inbox";
import { handleOffers } from "../src/offersapi";
import { createProposal, decide, getProposal, listProposals } from "../src/proposals";
import { listSales } from "../src/sales";
import { memoryStore } from "../src/store";
import { seedSnapshot, withEbayTokens } from "./fixtures";

const LIVE = "110000000001";
const GONE = "110000000002";
const FUTURE = "2099-01-01T00:00:00.000Z";
const BUYER = "a_buyer_name";
const TEXT = "my private words";

const one = (o: { id?: string; price?: number; status?: string; type?: string; role?: string }) =>
  `<BestOffer><BestOfferID>${o.id ?? "b1"}</BestOfferID><Price currencyID="GBP">${o.price ?? 9}</Price><Buyer><UserID>${BUYER}</UserID></Buyer><BuyerMessage>${TEXT}</BuyerMessage><ExpirationTime>${FUTURE}</ExpirationTime><Status>${o.status ?? "Pending"}</Status><BestOfferCodeType>${o.type ?? "BuyerBestOffer"}</BestOfferCodeType>${o.role ? `<Role>${o.role}</Role>` : ""}</BestOffer>`;
const item = (id: string) => `<Item><ItemID>${id}</ItemID><Title>Thing</Title><BuyItNowPrice currencyID="GBP">12.0</BuyItNowPrice></Item>`;
const account = (id: string, ...os: string[]) =>
  `<GetBestOffersResponse><Ack>Success</Ack><ItemBestOffersArray><ItemBestOffers>${item(id)}<BestOfferArray>${os.join("")}</BestOfferArray></ItemBestOffers></ItemBestOffersArray></GetBestOffersResponse>`;
const single = (id: string, ...os: string[]) => `<GetBestOffersResponse><Ack>Success</Ack><BestOfferArray>${os.join("")}</BestOfferArray>${item(id)}</GetBestOffersResponse>`;
const EMPTY = `<GetBestOffersResponse><Ack>Success</Ack></GetBestOffersResponse>`;
const sold = (inner = "") => `<GetMyeBaySellingResponse><Ack>Success</Ack><SoldList><OrderTransactionArray>${inner}</OrderTransactionArray></SoldList></GetMyeBaySellingResponse>`;
const line = (paid: boolean) =>
  `<OrderTransaction><Transaction><Buyer><UserID>${BUYER}</UserID></Buyer><Item><ItemID>${LIVE}</ItemID><Title>Thing</Title></Item><TransactionID>777</TransactionID><QuantityPurchased>1</QuantityPurchased><TransactionPrice currencyID="GBP">12.0</TransactionPrice><CreatedDate>${new Date(Date.now() + 60_000).toISOString()}</CreatedDate>${paid ? "<PaidTime>2026-01-01T00:00:00Z</PaidTime>" : "<SellerPaidStatus>NotPaid</SellerPaidStatus>"}</Transaction></OrderTransaction>`;
const NOTHING = "<GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray></ItemArray></ActiveList></GetMyeBaySellingResponse>";

/** What the stand-in eBay answers; tests change these. */
let ebay: { account: string | ((page: number) => string); item: (id: string) => string; sold: string; orders: any[]; ordersStatus: number; respond: string; message: number };
let sent: { call: string; body: string }[];
let env: Env;

beforeEach(async () => {
  ebay = { account: EMPTY, item: () => EMPTY, sold: sold(), orders: [], ordersStatus: 200, respond: "<RespondToBestOfferResponse><Ack>Success</Ack></RespondToBestOfferResponse>", message: 200 };
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: RequestInit = {}) => {
      const u = String(url);
      const body = String(init.body ?? "");
      if (u.includes("/sell/fulfillment/")) return Response.json({ orders: ebay.orders }, { status: ebay.ordersStatus });
      if (u.includes("/commerce/message/")) {
        sent.push({ call: `${init.method ?? "GET"} ${new URL(u).pathname}`, body });
        return Response.json({ conversations: [] }, { status: ebay.message });
      }
      const call = (init.headers as Record<string, string>)["X-EBAY-API-CALL-NAME"];
      sent.push({ call, body });
      if (call === "GetMemberMessages") return new Response("<GetMemberMessagesResponse><Ack>Success</Ack></GetMemberMessagesResponse>");
      if (call === "GetMyeBaySelling") return new Response(body.includes("SoldList") ? ebay.sold : NOTHING);
      if (call === "RespondToBestOffer") return new Response(ebay.respond);
      if (call === "GetBestOffers") {
        const id = /<ItemID>(\d+)</.exec(body)?.[1];
        const page = Number(/<PageNumber>(\d+)/.exec(body)?.[1] ?? 1);
        return new Response(id ? ebay.item(id) : typeof ebay.account === "string" ? ebay.account : ebay.account(page));
      }
      return new Response("<GetItemResponse><Ack>Success</Ack><Item><ItemID>1</ItemID></Item></GetItemResponse>");
    }),
  );
  env = { store: memoryStore(), EBAY_ENV: "sandbox", EBAY_MARKETPLACE: "EBAY_GB", WRITE_MODE: "approval", EBAY_SITE_ID: "3", NTFY_TOPIC: "", SIGNING_KEY: "k", PUBLIC_URL: "https://app.example" } as Env;
  await withEbayTokens(env.store);
  await seedSnapshot(env.store, Date.now() - 3_600_000, [{ item_id: LIVE, price: 12 }, { item_id: GONE, price: 20 }]);
  await seedSnapshot(env.store, Date.now() - 1000, [{ item_id: LIVE, price: 12 }]);
});
afterEach(() => vi.unstubAllGlobals());

const pendingOffers = async () => (await listProposals(env)).filter((p) => p.kind === "best_offer_response");
const everything = async () => JSON.stringify([await env.store.jobs.recentEvents({ since: 0, limit: 500 }), await env.store.messages.polls()]);

describe("reading eBay's two shapes", () => {
  it("finds offers in a one-listing reply, and counts them as open", () => {
    const doc = parseTradingResponse("GetBestOffers", single(LIVE, one({})));
    expect(toOffers(doc)).toMatchObject([{ bestOfferId: "b1", itemId: LIVE, price: 9, listPrice: 12, status: "Pending" }]);
    expect(openOfferCount(doc)).toBe(1);
  });

  it("treats an unknown status as open, and knows whose move it is", () => {
    const [o] = toOffers(parseTradingResponse("GetBestOffers", single(LIVE, one({ status: "SomethingNew" }))));
    expect(needsAnswer(o)).toBe(true);
    expect(needsAnswer({ ...o, codeType: "SellerCounterOffer" })).toBe(false);
    expect(outcomeOf({ ...o, status: "Accepted" })).toBe("accepted");
    expect(outcomeOf({ ...o, expiresAt: 1 })).toBe("expired");
  });

  it("describes a reply's shape without any of its values", () => {
    const s = structure(parseTradingResponse("GetBestOffers", single(LIVE, one({}), one({ id: "b2" }))));
    expect(s).toContain("BestOfferArray/BestOfferx2");
    expect(s).not.toContain(BUYER);
    expect(s).not.toContain(TEXT);
  });

  it("reads unpaid purchases, and nothing about who bought", () => {
    const [l] = toSoldLines(parseTradingResponse("GetMyeBaySelling", sold(line(false))));
    expect(l).toMatchObject({ itemId: LIVE, paid: false, price: 12 });
    expect(JSON.stringify(l)).not.toContain(BUYER);
  });

  it("knows a full-price offer, and never takes one a buyer fee lower for it", () => {
    expect(isFullPrice(12, 12)).toBe(true);
    expect(isFullPrice(11, 12)).toBe(false);
    expect(isFullPrice(10, 12)).toBe(false);
    expect(isFullPrice(10, null)).toBe(false);
  });
});

describe("the poll", () => {
  const refuse = (code: string) => `<GetBestOffersResponse><Ack>Failure</Ack><Errors><ShortMessage>x</ShortMessage><LongMessage>x</LongMessage><ErrorCode>${code}</ErrorCode><SeverityCode>Error</SeverityCode></Errors></GetBestOffersResponse>`;

  it("takes eBay's 'no offers' failures (seen on Sandbox) as empty, and any other as a failure", async () => {
    await seedSnapshot(env.store, Date.now(), [{ item_id: LIVE, price: 12 }]);
    for (const code of ["20138", "20140"]) {
      ebay.item = () => refuse(code);
      expect((await pollInbox(env)).errors).toEqual([]);
    }
    ebay.item = () => refuse("99999");
    expect((await pollInbox(env)).errors).toHaveLength(1);
  });

  it("finds a Pending offer that the account-wide call leaves out", async () => {
    ebay.item = (id) => (id === LIVE ? single(LIVE, one({})) : EMPTY);
    expect(await pollInbox(env)).toMatchObject({ offers: 1, errors: [] });
    expect(await pendingOffers()).toHaveLength(1);
    expect((await pollInbox(env)).offers).toBe(0);
    expect(await pendingOffers()).toHaveLength(1);
  });

  it("suggests accepting a full-price offer, and says so", async () => {
    ebay.account = account(LIVE, one({ price: 12 }));
    await pollInbox(env);
    const [p] = await pendingOffers();
    expect(JSON.parse(p.payload)).toMatchObject({ action: "accept", fullPrice: true });
    expect(p.reason).toBe("Full asking price.");
  });

  it("reads every page, and drops K's own offers as a buyer", async () => {
    ebay.account = (page) => account(LIVE, page === 1 ? one({ id: "x1", role: "Buyer" }) : one({ id: "x2", role: "Seller" })).replace("<Ack>", "<PaginationResult><TotalNumberOfPages>2</TotalNumberOfPages></PaginationResult><Ack>");
    expect((await pollInbox(env)).offers).toBe(1);
    const [poll] = await env.store.messages.polls();
    expect(poll.calls.find((c: any) => c.call === "GetBestOffers" && !c.itemId)).toMatchObject({ pages: 2, returned: 2, kept: 1, dropped: { "K's own offer as a buyer": 1 } });
  });

  it("records an offer already answered on eBay, on a listing that has gone, without a label", async () => {
    ebay.item = (id) => (id === GONE ? single(GONE, one({ status: "Accepted" })) : EMPTY);
    expect((await pollInbox(env)).offers).toBe(0);
    expect(await pendingOffers()).toHaveLength(0);
    expect(await env.store.messages.offers()).toMatchObject([{ item_id: GONE, outcome: "accepted", answered_by: "ebay" }]);
  });

  it("closes a waiting label when the offer is answered on eBay", async () => {
    ebay.account = account(LIVE, one({}));
    await pollInbox(env);
    const [p] = await pendingOffers();
    ebay.account = EMPTY;
    ebay.item = (id) => (id === LIVE ? single(LIVE, one({ status: "Declined" })) : EMPTY);
    await pollInbox(env);
    expect(await getProposal(env, p.id)).toMatchObject({ status: "expired", result: "Answered on eBay: declined." });
  });

  it("starts a new label when the buyer comes back with another price", async () => {
    ebay.account = account(LIVE, one({}));
    await pollInbox(env);
    await decide(env, (await pendingOffers())[0].id, "reject", "K");
    await pollInbox(env);
    expect(await pendingOffers()).toHaveLength(0);
    ebay.account = account(LIVE, one({ price: 10, type: "BuyerCounterOffer" }));
    await pollInbox(env);
    expect(await pendingOffers()).toHaveLength(1);
  });

  it("carries on past a bad offer, and links it next time without a second label", async () => {
    ebay.account = account(LIVE, one({ id: "bad" }), one({ id: "good" }));
    const save = env.store.messages.saveOffer;
    env.store.messages.saveOffer = async (r) => {
      if (r.best_offer_id === "bad" && r.proposal_id) throw new Error("boom");
      return save(r);
    };
    const r = await pollInbox(env);
    expect(r.errors.join()).toContain("boom");
    expect(r.offers).toBe(1);
    env.store.messages.saveOffer = save;
    await pollInbox(env);
    expect(await pendingOffers()).toHaveLength(2);
  });

  it("keeps and logs a warning and a failure, with eBay's codes", async () => {
    ebay.account = `<GetBestOffersResponse><Ack>Warning</Ack><Errors><ErrorCode>21</ErrorCode><SeverityCode>Warning</SeverityCode><ShortMessage>Careful</ShortMessage></Errors></GetBestOffersResponse>`;
    ebay.item = () => `<GetBestOffersResponse><Ack>Failure</Ack><Errors><ErrorCode>99999</ErrorCode><SeverityCode>Error</SeverityCode><ShortMessage>No</ShortMessage><LongMessage>No such thing</LongMessage></Errors></GetBestOffersResponse>`;
    const r = await pollInbox(env);
    expect(r.errors.join()).toContain("No such thing");
    const events = await env.store.jobs.recentEvents({ since: 0, limit: 500 });
    expect(events.some((e) => e.kind === "inbox.call" && e.status === "warn" && e.detail!.includes('"21"'))).toBe(true);
    expect(events.some((e) => e.kind === "inbox.call" && e.status === "error" && e.detail!.includes("99999"))).toBe(true);
  });

  it("never logs who the buyer is or what they wrote", async () => {
    ebay.account = account(LIVE, one({}));
    ebay.sold = sold(line(false));
    await pollInbox(env);
    const seen = await everything();
    expect(seen).toContain("inbox.offer_seen");
    expect(seen).toContain("offer 9 listed 12");
    expect(seen).not.toContain(BUYER);
    expect(seen).not.toContain(TEXT);
  });

  it("keeps to eBay's call limit, and two polls can't run at once", async () => {
    await seedSnapshot(env.store, Date.now(), Array.from({ length: 20 }, (_, i) => ({ item_id: `1200000000${String(i).padStart(2, "0")}`, price: 5 })));
    const [a, b] = await Promise.all([pollInbox(env), pollInbox(env)]);
    expect([a.busy, b.busy].filter(Boolean)).toHaveLength(1);
    expect(sent.filter((s) => s.call === "GetBestOffers" && s.body.includes("<ItemID>")).length).toBeLessThanOrEqual(LIVE_PER_POLL + 1);
  });
});

describe("answering", () => {
  it("the gate refuses an offer that has expired", async () => {
    const p = await createProposal(env, { kind: "best_offer_response", itemId: LIVE, payload: { bestOfferId: "b", action: "accept", expiresAt: Date.now() - 1 } });
    expect(await decide(env, p.id, "approve", "K")).toContain("expired on eBay");
    expect(sent.some((s) => s.call === "RespondToBestOffer")).toBe(false);
  });

  it("a label lapses with its offer", async () => {
    const at = Date.now() + 3_600_000;
    expect((await createProposal(env, { kind: "best_offer_response", itemId: LIVE, payload: {}, expiresAt: at })).expires_at).toBe(at);
  });

  it("an acknowledged call that refuses the offer inside it is a failure, not a success", async () => {
    ebay.account = account(LIVE, one({}));
    await pollInbox(env);
    ebay.respond = "<RespondToBestOfferResponse><Ack>Success</Ack><RespondToBestOffer><BestOffer><BestOfferID>b1</BestOfferID><CallStatus>Failure</CallStatus></BestOffer></RespondToBestOffer></RespondToBestOfferResponse>";
    expect(await decide(env, (await pendingOffers())[0].id, "approve", "K")).toContain("refused the offer");
    expect(await everything()).toContain("inbox.send_failed");
  });

  it("an accepted offer is marked answered from the app", async () => {
    ebay.account = account(LIVE, one({ price: 12 }));
    await pollInbox(env);
    expect(await decide(env, (await pendingOffers())[0].id, "approve", "K")).toBe("RespondToBestOffer ok");
    expect(await env.store.messages.offers()).toMatchObject([{ outcome: "accepted", answered_by: "app" }]);
  });

  it("a fresh label can be filed after the first was rejected, never beside a waiting one", async () => {
    ebay.account = account(LIVE, one({}));
    await pollInbox(env);
    const post = (b: object) => handleOffers(env, "POST", "/offers/answer", async () => b);
    expect((await post({ bestOfferId: "b1", action: "accept" }))!.status).toBe(400);
    await decide(env, (await pendingOffers())[0].id, "reject", "K");
    expect((await post({ bestOfferId: "b1", action: "counter", counterPrice: 11 }))!.status).toBe(200);
    expect(sent.some((s) => s.call === "RespondToBestOffer")).toBe(false);
    expect(await pendingOffers()).toHaveLength(1);
  });
});

describe("sales", () => {
  const order = (id: string, createdAt: number, status = "NOT_STARTED") => ({
    orderId: id,
    creationDate: new Date(createdAt).toISOString(),
    orderFulfillmentStatus: status,
    buyer: { username: BUYER },
    lineItems: [{ legacyItemId: LIVE, title: "Thing", quantity: 1, lineItemCost: { value: "10.00" } }],
  });

  it("says nothing about orders from before, then tells K once about a new one", async () => {
    const before = Date.now() - 60_000;
    const after = Date.now() + 5000;
    ebay.orders = [order("old", before)];
    expect((await pollInbox(env)).sales).toBe(0);
    ebay.orders = [order("old", before), order("new", after)];
    expect((await pollInbox(env)).sales).toBe(1);
    expect((await pollInbox(env)).sales).toBe(0);
    const dispatch = async () => (await env.store.todos.list("open")).filter((t) => t.code === "dispatch");
    expect(await dispatch()).toHaveLength(1);
    ebay.orders = [order("new", after, "FULFILLED")];
    await pollInbox(env);
    expect(await dispatch()).toHaveLength(0);
    const all = await listSales(env);
    expect(all.map((s) => s.id).sort()).toEqual(["new", "old"]);
    expect(JSON.stringify(all)).not.toContain(BUYER);
  });

  it("shows a purchase nobody has paid for, until it's paid", async () => {
    await pollInbox(env);
    // Polls are minutes apart; here both could fall in one millisecond and look like the first run.
    await env.store.kv.setJson("sales_since", { at: Date.now() - 1000 });
    ebay.sold = sold(line(false));
    expect((await pollInbox(env)).sales).toBe(1);
    expect((await listSales(env))[0]).toMatchObject({ state: "unpaid", price: 12 });
    const codes = async () => (await env.store.todos.list("open")).map((t) => t.code);
    expect(await codes()).toContain("awaiting_payment");
    ebay.sold = sold(line(true));
    await pollInbox(env);
    expect((await listSales(env)).filter((s) => s.state === "unpaid")).toHaveLength(0);
    expect(await codes()).not.toContain("awaiting_payment");
  });

  it("a failure reading orders doesn't stop the offers", async () => {
    ebay.account = account(LIVE, one({}));
    ebay.ordersStatus = 400;
    const r = await pollInbox(env);
    expect(r.offers).toBe(1);
    expect(r.errors.join()).toContain("orders");
  });
});

describe("messages", () => {
  const allow = () =>
    env.store.kv.saveEbayTokens({ access_token: "t", access_expires_at: Date.now() + 3_600_000, refresh_token: "r", refresh_expires_at: Date.now() + 3_600_000, scopes: [...FULL_SCOPES, MESSAGE_SCOPE].join(" ") });

  it("asks for the permission only when chosen or already held", async () => {
    expect(await consentScopes(env, false, false)).toEqual(FULL_SCOPES);
    expect(await consentScopes(env, false, true)).toContain(MESSAGE_SCOPE);
    expect(await consentScopes(env, true, true)).toBe(READONLY_SCOPES);
    await allow();
    expect(await consentScopes(env, false, false)).toContain(MESSAGE_SCOPE);
  });

  it("isn't called without the permission, and a refusal never fails the poll", async () => {
    await pollInbox(env);
    expect(sent.some((s) => s.call.includes("/commerce/message/"))).toBe(false);
    await allow();
    ebay.message = 403;
    expect((await pollInbox(env)).errors).toEqual([]);
    expect(await everything()).toContain("messages.failed");
    expect((await handleOffers(env, "GET", "/conversations", async () => ({})))!.status).toBe(502);
  });

  it("a message a person wrote goes only through approval and the gate", async () => {
    const post = (b: object) => handleOffers(env, "POST", "/conversations/message", async () => b);
    expect((await post({ recipientId: BUYER, body: "Hi" }))!.status).toBe(403);
    await allow();
    const { id } = (await (await post({ recipientId: BUYER, itemId: LIVE, body: "Hi" }))!.json()) as any;
    expect(sent.some((s) => s.call.startsWith("POST /commerce/message/"))).toBe(false);
    expect(await decide(env, id, "approve", "K")).toBe("sendMessage ok");
    const out = JSON.parse(sent.find((s) => s.call === "POST /commerce/message/v1/send_message")!.body);
    expect(out).toEqual({ otherPartyUsername: BUYER, messageText: "Hi", reference: { referenceType: "LISTING", referenceId: LIVE } });
    expect(() => callFor({ kind: "new_message", item_id: null, payload: JSON.stringify({ recipientId: BUYER, body: " " }) })).toThrow(/empty/);
  });

  it("a deleted eBay account is scrubbed from offers and messages", async () => {
    ebay.account = account(LIVE, one({}));
    await pollInbox(env);
    await createProposal(env, { kind: "new_message", itemId: LIVE, payload: { recipientId: BUYER, body: TEXT } });
    await forgetUser(env, BUYER);
    expect(await env.store.messages.offers()).toEqual([]);
    for (const q of await env.store.proposals.listWhere([])) expect(q.payload).not.toContain(BUYER);
  });
});
