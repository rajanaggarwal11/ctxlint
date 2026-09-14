import type { Context } from "../context.js";
import type { Exchange } from "../types.js";

export type Severity = "error" | "warn" | "info";

export type RuleId =
  | "budget"
  | "growth"
  | "duplicate-content"
  | "stale-tool-results"
  | "unused-tools"
  | "no-cache"
  | "cache-miss"
  | "oversized-system"
  | "secret-in-context"
  | "injection-in-tool-result";

export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** 1-based request number in the session, when the finding is about one request. */
  turn?: number;
  message: string;
  detail?: string[];
  /** Tokens at stake, when the finding is about cost. */
  tokens?: number;
}

export interface RuleOptions {
  /** Input tokens per request above which `budget` fires. Off when unset. */
  budget?: number;
  /** Average growth per turn, in percent, above which `growth` fires. Default 5. */
  maxGrowthPct?: number;
  /** Context window assumed for the growth projection. Default from the model, else 200k. */
  window?: number;
}

/** Every context-bearing request of a session, in order, with its exchange. */
export interface Turn {
  n: number;
  exchange: Exchange;
  context: Context;
}

export interface Rule {
  id: RuleId;
  title: string;
  description: string;
  defaultSeverity: Severity;
  check(turns: Turn[], options: RuleOptions): Finding[];
}

export const fmt = (n: number): string => n.toLocaleString("en-US");
