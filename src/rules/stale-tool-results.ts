import { fmt } from "./types.js";
import type { Rule } from "./types.js";

const MIN_TOKENS = 2000;
const MIN_AGE = 6;

export const staleToolResults: Rule = {
  id: "stale-tool-results",
  title: "Large tool results from long ago are still carried in full",
  description: `On the latest request, a tool result of ${MIN_TOKENS}+ tokens from ${MIN_AGE}+ messages back is still in context.`,
  defaultSeverity: "warn",
  check(turns) {
    const last = turns[turns.length - 1];
    if (!last) return [];
    const lastMsg = Math.max(-1, ...last.context.sections.map((s) => s.turn));
    return last.context.sections
      .filter(
        (s) => s.kind === "tool-result" && s.tokens >= MIN_TOKENS && lastMsg - s.turn >= MIN_AGE,
      )
      .map((s) => ({
        rule: staleToolResults.id,
        severity: "warn" as const,
        turn: last.n,
        tokens: s.tokens,
        message: `a ${last.context.exact ? "" : "≈"}${fmt(s.tokens)}-token ${s.name ? `${s.name} ` : ""}result from message ${s.turn + 1} is still in context at message ${lastMsg + 1} — summarise or prune it`,
      }));
  },
};
