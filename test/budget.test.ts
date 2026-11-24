import { describe, expect, it } from "vitest";
import { CLAUDE_DAILY_BUDGET_USD, claudeDailyBudgetUsd } from "../src/rules";

describe("claudeDailyBudgetUsd", () => {
  it("keeps the code default when the setting is empty", () => {
    expect(claudeDailyBudgetUsd({})).toBe(CLAUDE_DAILY_BUDGET_USD);
    expect(claudeDailyBudgetUsd({ CLAUDE_DAILY_BUDGET_USD: " " })).toBe(CLAUDE_DAILY_BUDGET_USD);
  });

  it("switches Claude off at 0 and lowers the cap", () => {
    expect(claudeDailyBudgetUsd({ CLAUDE_DAILY_BUDGET_USD: "0" })).toBe(0);
    expect(claudeDailyBudgetUsd({ CLAUDE_DAILY_BUDGET_USD: "0.25" })).toBe(0.25);
  });

  it("never raises the cap, and treats nonsense as off", () => {
    expect(claudeDailyBudgetUsd({ CLAUDE_DAILY_BUDGET_USD: "50" })).toBe(CLAUDE_DAILY_BUDGET_USD);
    expect(claudeDailyBudgetUsd({ CLAUDE_DAILY_BUDGET_USD: "-3" })).toBe(0);
    expect(claudeDailyBudgetUsd({ CLAUDE_DAILY_BUDGET_USD: "lots" })).toBe(0);
  });
});
