// The Messages screen's data: who wrote what, in which order, and what of a message is shown. All names are invented.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { MESSAGE_SCOPE, toConversations, toMessages } from "../src/ebay/messages";
import { handleOffers } from "../src/offersapi";
import { memoryStore } from "../src/store";
import { preview, showable } from "../web/src/quoted";
import { seedSnapshot } from "./fixtures";

const OWN = "Sample_Shop";
const BUYER = "sample_buyer";
const msg = (id: string, from: string, to: string, at: string, body = id) => ({ messageId: id, senderUsername: from, recipientUsername: to, createdDate: at, messageBody: body });

describe("who wrote what", () => {
  const latest = (from: string, to: string) => ({ conversations: [{ conversationId: "c1", referenceId: "110000000001", unreadCount: 1, latestMessage: msg("m", from, to, "2026-01-02T10:00:00Z") }] });

  it("names the buyer whoever wrote last", () => {
    expect(toConversations(latest(BUYER, OWN), OWN)[0]).toMatchObject({ otherParty: BUYER, lastMine: false, itemId: "110000000001" });
    expect(toConversations(latest("sample_shop", BUYER), OWN)[0]).toMatchObject({ otherParty: BUYER, lastMine: true });
    expect(toConversations(latest(BUYER, OWN), "")[0].otherParty).toBe("");
  });

  it("tells the sides apart, and doesn't guess without the shop's own name", () => {
    const doc = { messages: [msg("2", "sample_shop", BUYER, "2026-01-02T10:00:00Z"), msg("1", BUYER, OWN, "2026-01-01T10:00:00Z"), msg("3", "", OWN, "2026-01-03T10:00:00Z"), msg("4", "", "", "2026-01-04T10:00:00Z")] };
    expect(toMessages(doc, OWN).map((m) => m.side)).toEqual(["buyer", "me", "buyer", "unknown"]);
    expect(new Set(toMessages(doc, "").map((m) => m.side))).toEqual(new Set(["unknown"]));
  });

  it("is oldest first whatever eBay's order, each message once", () => {
    const a = msg("a", BUYER, OWN, "2026-01-01T10:00:00Z");
    const b = msg("b", OWN, BUYER, "2026-01-02T10:00:00Z");
    for (const messages of [[a, b], [b, a], [b, a, b]]) expect(toMessages({ messages }, OWN).map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("the chat's API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds the listing and what was written here, and pages back", async () => {
    const env = { store: memoryStore(), EBAY_ENV: "production", EBAY_MARKETPLACE: "EBAY_GB", EBAY_SITE_ID: "3", WRITE_MODE: "approval", EBAY_APP_ID: "a", EBAY_CERT_ID: "b", EBAY_DEV_ID: "c" } as unknown as Env;
    await env.store.kv.saveEbayTokens({ access_token: "t", access_expires_at: Date.now() + 3_600_000, refresh_token: "r", refresh_expires_at: Date.now() + 3_600_000, scopes: MESSAGE_SCOPE });
    await env.store.kv.setJson("own_username", { name: OWN, at: Date.now() });
    await seedSnapshot(env.store, Date.now(), [{ item_id: "110000000001", title: "Board game", price: 12 }]);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: any) => {
      asked.push(String(url));
      return String(url).includes("/conversation?")
        ? Response.json({ conversations: [{ conversationId: "c1", referenceId: "110000000001", latestMessage: msg("m", BUYER, OWN, "2026-01-02T10:00:00Z") }] })
        : Response.json({ total: 3, messages: [msg("x", BUYER, OWN, "2026-01-02T10:00:00Z"), msg("y", OWN, BUYER, "2026-01-01T10:00:00Z")] });
    });
    const get = async (p: string) => (await (await handleOffers(env, "GET", p, async () => ({})))!.json()) as any;
    expect((await get("/conversations")).conversations[0]).toMatchObject({ otherParty: BUYER, itemTitle: "Board game", itemPrice: 12 });
    await handleOffers(env, "POST", "/conversations/message", async () => ({ conversationId: "c1", recipientId: BUYER, body: "Hello" }));
    await handleOffers(env, "POST", "/conversations/message", async () => ({ conversationId: "other", recipientId: BUYER, body: "Not here" }));
    const chat = await get("/conversations/c1");
    expect(chat.messages.map((m: any) => m.id)).toEqual(["y", "x"]);
    expect(chat.older).toBe(2);
    expect(chat.sends.map((s: any) => [s.body, s.status])).toEqual([["Hello", "pending"]]);
    await get("/conversations/c1/2");
    expect(asked.at(-1)).toContain("offset=2");
  });
});

describe("what's shown of a message", () => {
  const TAIL = "On Fri, 20 Nov 2026, 10:13 pm Sample Buyer, <sample@example.com> wrote:";

  it("puts an email's quoted tail behind a button, even mid-line, and hides addresses", () => {
    expect(showable(`Got it, thanks. S. ${TAIL} earlier words`)).toEqual({ body: "Got it, thanks. S.", quoted: "On Fri, 20 Nov 2026, 10:13 pm Sample Buyer, <[email hidden]> wrote: earlier words" });
    expect(showable(`Yes\n\nOn Fri, 20 Nov 2026\nSample Buyer <sample@example.com>\nwrote:\n> old`).body).toBe("Yes");
    expect(showable("Yes\n\nFrom: A\nSent: Friday\nTo: B\nold").body).toBe("Yes");
    expect(showable("Yes\n> old\n> older")).toEqual({ body: "Yes", quoted: "> old\n> older" });
    expect(preview(`Thanks  a lot ${TAIL}`)).toBe("Thanks a lot");
  });

  it("never loses what the buyer wrote", () => {
    for (const s of ["On Monday you wrote: it works. Does it?", "On Monday 3 Nov I asked you", "> quoted\nmy answer\n> more", TAIL, "> only a quote", "Sent from my phone"]) {
      const r = showable(s);
      expect(r.quoted).toBeNull();
      expect(r.body.length).toBeGreaterThan(0);
    }
    expect(showable("mail me at sample@example.com please").body).toBe("mail me at [email hidden] please");
    expect(showable("a  b\n\n\n\nc").body).toBe("a b\n\nc");
  });

  it("copes with very long and hostile text", () => {
    expect(showable("On ".repeat(10_000)).body.length).toBeGreaterThan(0);
    expect(showable('<img src=x onerror=1> javascript:alert(1)').body).toContain("<img src=x");
    expect(readFileSync("web/src/messages.tsx", "utf8")).not.toMatch(/innerHTML|dangerouslySet|href=\{m\./);
  });
});
