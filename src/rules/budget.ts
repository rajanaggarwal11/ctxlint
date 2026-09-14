import { fmt } from "./types.js";
import type { Rule } from "./types.js";

export const budget: Rule = {
  id: "budget",
  title: "A request sent more input tokens than the budget allows",
  description: "Input tokens per request over --budget. Off unless a budget is set.",
  defaultSeverity: "warn",
  check(turns, options) {
    if (!options.budget) return [];
    return turns
      .filter((t) => t.context.totalTokens > options.budget!)
      .map((t) => ({
        rule: budget.id,
        severity: "warn" as const,
        turn: t.n,
        tokens: t.context.totalTokens - options.budget!,
        message: `turn ${t.n} sent ${t.context.exact ? "" : "≈"}${fmt(t.context.totalTokens)} input tokens (budget ${fmt(options.budget!)})`,
      }));
  },
};
