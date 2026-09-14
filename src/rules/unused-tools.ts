import { fmt } from "./types.js";
import type { Rule } from "./types.js";

const MIN_TURNS = 3;

export const unusedTools: Rule = {
  id: "unused-tools",
  title: "Tools are defined on every request and never called",
  description: `Tool definitions cost tokens on every turn. Over ${MIN_TURNS}+ turns, the tools the model never called, and what their definitions cost per turn.`,
  defaultSeverity: "warn",
  check(turns) {
    if (turns.length < MIN_TURNS) return [];
    const defined = new Map<string, number>();
    const called = new Set<string>();
    for (const t of turns) {
      for (const name of new Set(t.context.tools)) defined.set(name, (defined.get(name) ?? 0) + 1);
      for (const name of t.context.toolCalls) called.add(name);
    }
    const everyTurn = [...defined].filter(([, n]) => n === turns.length).map(([name]) => name);
    const unused = everyTurn.filter((name) => !called.has(name));
    if (!unused.length) return [];
    const last = turns[turns.length - 1]!;
    const perTurn = last.context.sections
      .filter((s) => s.kind === "tool-def" && s.name && unused.includes(s.name))
      .reduce((a, s) => a + s.tokens, 0);
    return [
      {
        rule: unusedTools.id,
        severity: "warn",
        tokens: perTurn * turns.length,
        message: `${unused.length} of ${everyTurn.length} tool definitions were never called in ${turns.length} turns — ${last.context.exact ? "" : "≈"}${fmt(perTurn)} tokens on every turn`,
        detail: [
          unused.slice(0, 12).join(", ") +
            (unused.length > 12 ? `, … (${unused.length - 12} more)` : ""),
        ],
      },
    ];
  },
};
