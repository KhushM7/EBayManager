import { beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import type { MessagesApi } from "../src/claude";
import { costUsd } from "../src/claude";
import { lookupSpecs, sameSource, specsFor, verifySpecs } from "../src/specs";
import { auditListing, repeatsTitle } from "../src/firstday";

const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2 } };
const msg = (stop: string, content: any[]) => ({ id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, usage }) as unknown as Anthropic.Beta.BetaMessage;

const searchResult = (urls: string[]) => ({
  type: "web_search_tool_result",
  tool_use_id: "s1",
  content: urls.map((url) => ({ type: "web_search_result", url, title: "Page", encrypted_content: "x" })),
});
const record = (input: object) => ({ type: "tool_use", id: "t1", name: "record_specs", input });

const DYSON = { ItemID: "178245985136", Title: "Dyson Cinetic Big Ball Animal Vacuum Cleaner with Tools - Spares or Repair", Description: "Dyson Cinetic Big Ball Animal Vacuum Cleaner with Tools - Spares or Repair" };

let env: Env;
beforeEach(() => {
  env = { DB: fakeD1(), EBAY_ENV: "production", WRITE_MODE: "off" } as Env;
});

describe("verifying published specs", () => {
  const searched = ["https://www.dyson.co.uk/vacuum-cleaners/cinetic-big-ball-animal?x=1", "https://retailer.example/p/123"];

  it("keeps a spec only if its source is a page the search returned", () => {
    const v = verifySpecs(
      {
        exact: true,
        product: "Dyson Cinetic Big Ball Animal",
        note: "Model named in the title.",
        specs: [
          { name: "Item Weight", value: "7.88 kg", source: "https://dyson.co.uk/vacuum-cleaners/cinetic-big-ball-animal/", sourceTitle: "Dyson" },
          { name: "Item Height", value: "1074 mm", source: "https://made-up.example/specs", sourceTitle: "Invented" },
          { name: "Item Weight", value: "8 kg", source: "https://retailer.example/p/123", sourceTitle: "Duplicate name" },
        ],
      },
      searched,
    );
    expect(v.specs).toEqual([{ name: "Item Weight", value: "7.88 kg", source: "https://dyson.co.uk/vacuum-cleaners/cinetic-big-ball-animal/", sourceTitle: "Dyson" }]);
    expect(v.dropped).toBe(2);
  });

  it("keeps nothing unless the product is exactly identified", () => {
    const v = verifySpecs(
      { exact: false, product: "", note: "The brand and model of the lights aren't stated.", specs: [{ name: "Diameter", value: "50 cm", source: searched[1], sourceTitle: "x" }] },
      searched,
    );
    expect(v).toMatchObject({ exact: false, product: null, specs: [], dropped: 1 });
  });

  it("compares URLs by host and path only", () => {
    expect(sameSource("https://www.a.com/x/?q=1#f")).toBe(sameSource("https://a.com/x"));
    expect(sameSource("javascript:alert(1)")).toBeNull();
  });
});

describe("looking up specs", () => {
  it("searches, carries on after a pause, records verified specs, and logs the search cost", async () => {
    const calls: any[] = [];
    const responses = [
      msg("pause_turn", [searchResult(["https://www.dyson.co.uk/cinetic"])]),
      msg("tool_use", [
        record({
          exact: true,
          product: "Dyson Cinetic Big Ball Animal",
          note: "Model in the title.",
          specs: [
            { name: "Item Weight", value: "7.88 kg", source: "https://www.dyson.co.uk/cinetic", sourceTitle: "Dyson" },
            { name: "Item Height", value: "1074 mm", source: "https://nowhere.example", sourceTitle: "?" },
          ],
        }),
      ]),
    ];
    const api: MessagesApi = {
      async create(p) {
        calls.push(structuredClone(p));
        return responses[calls.length - 1];
      },
    };
    const r = await lookupSpecs(env, DYSON, ["Item Weight", "Item Height"], api);
    expect(calls).toHaveLength(2);
    expect(calls[0].tools.map((t: any) => t.type ?? t.name)).toEqual(["web_search_20260209", "record_specs"]);
    expect(calls[1].messages.at(-1).role).toBe("assistant"); // the paused turn sent back
    expect(r).toMatchObject({ exact: true, product: "Dyson Cinetic Big Ball Animal", dropped: 1 });
    expect(r.specs.map((s) => s.name)).toEqual(["Item Weight"]);
    const logged = await env.DB.prepare("SELECT job, cost_usd FROM claude_usage").all<any>();
    expect(logged.results).toHaveLength(2);
    expect(logged.results[0].job).toBe("specs:178245985136");
    expect(costUsd("claude-sonnet-5-5", usage as any)).toBeCloseTo(0.002 + 0.002 + 0.02, 5);
  });

  it("stores a lookup per title and reuses it", async () => {
    let n = 0;
    const api: MessagesApi = {
      async create() {
        n++;
        return msg("tool_use", [searchResult(["https://a.example/p"]), record({ exact: true, product: "P", note: "", specs: [{ name: "MPN", value: "123", source: "https://a.example/p", sourceTitle: "A" }] })]);
      },
    };
    const env2 = { ...env, ANTHROPIC_API_KEY: "k" } as Env;
    await specsFor(env2, { ...DYSON, PrimaryCategory: undefined }, api);
    const again = await specsFor(env2, { ...DYSON, PrimaryCategory: undefined }, api);
    expect(n).toBe(1);
    expect(again!.specs[0]).toMatchObject({ name: "MPN", value: "123" });
  });
});

describe("the audit with published specs", () => {
  it("treats a description that only repeats the title as no description", () => {
    expect(repeatsTitle(DYSON.Description, DYSON.Title)).toBe(true);
    expect(repeatsTitle("Powers on but the brush bar doesn't spin. Comes with two tools, no charger.", DYSON.Title)).toBe(false);
    const a = auditListing({ ...DYSON, ConditionID: "7000" }, { now: Date.now() });
    expect(a.findings.find((f) => f.title === "No description")!.detail).toMatch(/only repeats the title/);
    expect(a.findings.map((f) => f.title)).not.toContain("Thin description");
  });

  it("sends specifics found online to Claude and only the rest to K", () => {
    const published = {
      itemId: "1", title: "", at: 0, exact: true, product: "Techlink Arena AA110B", note: "", dropped: 0, costUsd: 0,
      specs: [
        { name: "Item Width", value: "110 cm", source: "https://techlink.example/aa110b", sourceTitle: "Techlink" },
        { name: "Item Weight", value: "21 kg", source: "https://techlink.example/aa110b", sourceTitle: "Techlink" },
      ],
    };
    const a = auditListing(
      { ItemID: "1", Title: "Techlink Arena AA110B TV Stand Piano Black Glass Shelf Up to 55 Inch TVs" },
      { aspects: [{ name: "Item Width", required: false }, { name: "Item Weight", required: false }, { name: "Item Depth", required: false }], published },
    );
    expect(a.findings.find((f) => f.fix === "claude" && /published specs/.test(f.title))!.detail).toMatch(/Item Width, Item Weight/);
    const measure = a.findings.find((f) => f.title === "Measurements missing")!;
    expect(measure.detail).toMatch(/^Item Depth\. Not published for the Techlink Arena AA110B/);
    expect(a.published!.specs).toHaveLength(2);
  });
});
