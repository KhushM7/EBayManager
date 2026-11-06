import { beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import type { MessagesApi } from "../src/claude";
import { cleanGuide, editStyle, getStyle, learnStyle, saveStyle, scrub, styleText, withStyle } from "../src/style";
import { QUESTION_SYSTEM } from "../src/inbox";
import { messageText, toAnswered } from "../src/ebay/history";
import { parseTradingResponse } from "../src/ebay/trading";

const reply = (text: string) =>
  ({
    id: "m",
    type: "message",
    role: "assistant",
    model: "x",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }) as unknown as Anthropic.Beta.BetaMessage;

let env: Env;
beforeEach(() => {
  env = { store: memoryStore(), EBAY_ENV: "production", WRITE_MODE: "off" } as Env;
});

describe("reading K's past replies", () => {
  it("pairs each answered question with K's reply and drops buyer IDs", () => {
    const doc = parseTradingResponse(
      "GetMemberMessages",
      `<GetMemberMessagesResponse><Ack>Success</Ack><MemberMessage>
        <MemberMessageExchange><Item><ItemID>1</ItemID><Title>Lamp</Title></Item>
          <Question><SenderID>buyer_x</SenderID><Body>Does it work?</Body><MessageID>q1</MessageID></Question>
          <Response>Hi, yes it works perfectly. Thanks, K</Response><MessageStatus>Answered</MessageStatus>
          <CreationDate>2026-05-01T10:00:00.000Z</CreationDate></MemberMessageExchange>
        <MemberMessageExchange><Item><ItemID>2</ItemID><Title>Mug</Title></Item>
          <Question><SenderID>buyer_y</SenderID><Body>Unanswered?</Body><MessageID>q2</MessageID></Question></MemberMessageExchange>
      </MemberMessage></GetMemberMessagesResponse>`,
    );
    const r = toAnswered(doc);
    expect(r).toEqual([{ question: "Does it work?", reply: "Hi, yes it works perfectly. Thanks, K", itemTitle: "Lamp", at: "2026-05-01T10:00:00.000Z" }]);
    expect(JSON.stringify(r)).not.toContain("buyer_x");
  });

  it("takes only what K typed from eBay's message template", () => {
    const html = `<html><body><table>eBay header</table><div id="UserInputtedText">Hi,<br>Posted today.<br/>Thanks</div><p>eBay footer &amp; links</p></body></html>`;
    expect(messageText(html)).toBe("Hi,\nPosted today.\nThanks");
  });
});

describe("the style guide", () => {
  it("removes contact details and caps lists", () => {
    expect(scrub("Email me at a.b@x.com or 07700 900123, see https://x.y")).toBe("Email me at [email] or [phone], see [link]");
    const g = cleanGuide({ habits: Array.from({ length: 20 }, (_, i) => `h${i}`) }, { replies: 0, from: null, to: null, learned: false });
    expect(g.habits).toHaveLength(8);
  });

  it("learns from past replies with one structured Claude call, without sending buyer IDs", async () => {
    const calls: any[] = [];
    const api: MessagesApi = {
      async create(p) {
        calls.push(p);
        return reply(
          JSON.stringify({
            tone: "warm and brief",
            length: "one or two sentences",
            greeting: "Hi there,",
            signOff: "Cheers, K",
            habits: ["British English", "No emoji"],
            phrasings: [{ topic: "postage", example: "I post within [n] days by Royal Mail." }],
            avoid: ["Haggling in messages"],
          }),
        );
      },
    };
    const g = await learnStyle(
      env,
      [
        { question: "Still available?", reply: "Hi there, yes it is. Cheers, K", itemTitle: "Lamp", at: "2026-03-01T00:00:00Z" },
        { question: "", reply: "Hi there, posted today. Cheers, K", itemTitle: "Mug", at: "2026-04-01T00:00:00Z" },
        { question: "dup", reply: "Hi there, posted today. Cheers, K", itemTitle: "Mug", at: "2026-04-01T00:00:00Z" },
      ],
      api,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].output_config.format.type).toBe("json_schema");
    expect(calls[0].messages[0].content).toContain("K replied: Hi there, yes it is.");
    expect(g).toMatchObject({ tone: "warm and brief", greeting: "Hi there,", signOff: "Cheers, K", source: { replies: 1, from: "2026-03-01", to: "2026-03-01", learned: true } });
  });

  it("falls back to the default guide with no replies", async () => {
    const g = await learnStyle(env, []);
    expect(g.source.learned).toBe(false);
    expect(g.tone).toBeTruthy();
  });

  it("keeps K's edits and who made them", async () => {
    await saveStyle(env, cleanGuide({ tone: "x" }, { replies: 5, from: null, to: null, learned: true }));
    const g = await editStyle(env, { signOff: "Thanks, K" }, "K");
    expect(g).toMatchObject({ tone: "x", signOff: "Thanks, K", editedBy: "K", source: { replies: 5 } });
    expect((await getStyle(env))!.signOff).toBe("Thanks, K");
  });

  it("is added to every draft prompt, after the rules", async () => {
    expect(await withStyle(env, QUESTION_SYSTEM)).toBe(QUESTION_SYSTEM);
    await saveStyle(env, cleanGuide({ tone: "warm", greeting: "Hi there,", signOff: "Cheers, K" }, { replies: 3, from: null, to: null, learned: true }));
    const s = await withStyle(env, QUESTION_SYSTEM);
    expect(s.startsWith(QUESTION_SYSTEM)).toBe(true);
    expect(s).toContain("Greeting: Hi there,. Sign-off: Cheers, K.");
    expect(s).toMatch(/rules above always win/);
    expect(styleText(null)).toBe("");
  });
});
