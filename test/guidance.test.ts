import { beforeEach, describe, expect, it } from "vitest";
import { memoryStore } from "../src/store";
import type { Env } from "../src/env";
import type { MessagesApi } from "../src/claude";
import { addRule, draftRule, getRules, MAX_RULES, removeRule, ruleProblem, RULE_SYSTEM, standingFacts, withListingRules } from "../src/guidance";
import { COMPOSE_SYSTEM } from "../src/newlisting";

// K's standing rules for how listings are written (src/guidance.ts): K's feedback becomes a rule every later
// listing follows. Wording rules shape the text; standing facts are K's own facts; neither outranks the fixed rules.

let env: Env;
beforeEach(() => {
  env = { store: memoryStore(), ANTHROPIC_API_KEY: "" } as Env;
});

/** Claude stand-in for the rule writer. */
const claude = (answer: unknown, seen: string[] = []): MessagesApi => ({
  async create(params: any) {
    expect(params.system[0].text).toBe(RULE_SYSTEM);
    seen.push(String(params.messages[0].content));
    return { content: [{ type: "text", text: JSON.stringify(answer) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any;
  },
});

describe("listing rules", () => {
  it("keeps K's rule and adds it to the writing prompt, below the fixed rules", async () => {
    await addRule(env, { kind: "wording", text: "Head the list of flaws 'Problems', not 'Flaws'." }, "K");
    await addRule(env, { kind: "fact", text: "From a pet-free, smoke-free home." }, "K");
    const rules = await getRules(env);
    expect(rules.map((r) => r.kind)).toEqual(["wording", "fact"]);
    const system = withListingRules(COMPOSE_SYSTEM, rules);
    expect(system.startsWith(COMPOSE_SYSTEM)).toBe(true);
    expect(system).toMatch(/The rules above always win over them/);
    expect(system).toMatch(/- Head the list of flaws 'Problems'/);
    expect(system).toMatch(/True of every item K sells[^\n]*\n- From a pet-free, smoke-free home\./);
    expect(standingFacts(rules)).toEqual(["From a pet-free, smoke-free home."]);
    // No rules: the prompt is untouched, so it still caches as before.
    expect(withListingRules(COMPOSE_SYSTEM, [])).toBe(COMPOSE_SYSTEM);
  });

  it("refuses links, contact details, duplicates and a list that's too long", async () => {
    expect(ruleProblem("Always add visit www.myshop.co.uk")).toMatch(/web address/);
    expect(ruleProblem("Tell buyers to email me at k@example.com")).toMatch(/email/);
    expect(ruleProblem("Say call 07700 900123 for questions")).toMatch(/phone/);
    expect(ruleProblem("Use short paragraphs.")).toBeNull();
    await expect(addRule(env, { text: "See https://example.com" }, "K")).rejects.toThrow(/web address/);
    await addRule(env, { text: "Use short paragraphs." }, "K");
    await expect(addRule(env, { text: "use short paragraphs." }, "K")).rejects.toThrow(/already there/);
    for (let i = 1; i < MAX_RULES; i++) await addRule(env, { text: `Rule number ${i} for listings.` }, "K");
    await expect(addRule(env, { text: "One too many rules." }, "K")).rejects.toThrow(/Remove one first/);
  });

  it("turns feedback into a rule to confirm, replacing a rule it contradicts", async () => {
    const [old] = await addRule(env, { text: "Head the list of flaws 'Flaws'." }, "K");
    const seen: string[] = [];
    const draft = await draftRule(env, "dont label the flaws section flaws, label it problems", claude({ ok: true, kind: "wording", text: "Head the list of flaws 'Problems', not 'Flaws'.", replaces: old.id, note: "Replaces the 'Flaws' heading rule" }, seen));
    expect(draft).toMatchObject({ ok: true, kind: "wording", replaces: old.id });
    expect(seen[0]).toContain(`[${old.id}]`);
    // Nothing is saved until K confirms.
    expect(await getRules(env)).toHaveLength(1);
    const rules = await addRule(env, draft, "K");
    expect(rules.map((r) => r.text)).toEqual(["Head the list of flaws 'Problems', not 'Flaws'."]);
    expect(await removeRule(env, rules[0].id)).toEqual([]);
  });

  it("says no to feedback that can't be a standing rule, and to a rule Claude returns with a link in it", async () => {
    const no = await draftRule(env, "always say fully working", claude({ ok: false, kind: "wording", text: "", replaces: null, note: "That can't be known for every item." }));
    expect(no).toMatchObject({ ok: false, text: "", note: "That can't be known for every item." });
    const link = await draftRule(env, "mention my shop", claude({ ok: true, kind: "wording", text: "Mention www.myshop.co.uk at the end.", replaces: null, note: "" }));
    expect(link.ok).toBe(false);
    expect(link.note).toMatch(/web address/);
  });

  it("uses K's own words when Claude isn't available", async () => {
    expect(await draftRule(env, "  Always say collection is   welcome first. ")).toMatchObject({ ok: true, kind: "wording", text: "Always say collection is welcome first." });
  });
});
