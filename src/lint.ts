import { contextOf } from "./context.js";
import { ALL_RULES } from "./rules/index.js";
import type { Finding, RuleId, RuleOptions, Turn } from "./rules/index.js";
import type { Exchange } from "./types.js";

export interface LintOptions extends RuleOptions {
  only?: RuleId[];
  ignore?: RuleId[];
}

export interface LintResult {
  turns: Turn[];
  findings: Finding[];
  rulesRun: RuleId[];
}

/** The context-bearing requests of a session, numbered from 1. */
export function turnsOf(exchanges: Exchange[]): Turn[] {
  const turns: Turn[] = [];
  for (const exchange of exchanges) {
    const context = contextOf(exchange);
    if (context) turns.push({ n: turns.length + 1, exchange, context });
  }
  return turns;
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;

export function lintExchanges(exchanges: Exchange[], options: LintOptions = {}): LintResult {
  const turns = turnsOf(exchanges);
  const rules = ALL_RULES.filter(
    (r) => (!options.only || options.only.includes(r.id)) && !options.ignore?.includes(r.id),
  );
  const findings = rules
    .flatMap((r) => r.check(turns, options))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.turn ?? 0) - (b.turn ?? 0),
    );
  return { turns, findings, rulesRun: rules.map((r) => r.id) };
}
