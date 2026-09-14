import { fmt } from "./types.js";
import type { Rule } from "./types.js";

const SHARE = 0.6;
const MIN_TOKENS = 2000;

export const oversizedSystem: Rule = {
  id: "oversized-system",
  title: "The system prompt is most of the request",
  description: `On the latest request, the system prompt is ${SHARE * 100}%+ of the input and ${MIN_TOKENS}+ tokens.`,
  defaultSeverity: "info",
  check(turns) {
    const last = turns[turns.length - 1];
    if (!last) return [];
    const system = last.context.sections
      .filter((s) => s.kind === "system")
      .reduce((a, s) => a + s.tokens, 0);
    const total = last.context.totalTokens || 1;
    if (system < MIN_TOKENS || system / total < SHARE) return [];
    return [
      {
        rule: oversizedSystem.id,
        severity: "info",
        turn: last.n,
        tokens: system,
        message: `the system prompt is ${Math.round((system / total) * 100)}% of the request (${last.context.exact ? "" : "≈"}${fmt(system)} of ${fmt(total)} tokens)`,
      },
    ];
  },
};
