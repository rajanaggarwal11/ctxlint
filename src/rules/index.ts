import { budget } from "./budget.js";
import { cacheMiss } from "./cache-miss.js";
import { duplicateContent } from "./duplicate-content.js";
import { growth } from "./growth.js";
import { injectionInToolResult } from "./injection-in-tool-result.js";
import { noCache } from "./no-cache.js";
import { oversizedSystem } from "./oversized-system.js";
import { secretInContext } from "./secret-in-context.js";
import { staleToolResults } from "./stale-tool-results.js";
import { unusedTools } from "./unused-tools.js";
import type { Rule } from "./types.js";

export const ALL_RULES: Rule[] = [
  secretInContext,
  injectionInToolResult,
  budget,
  growth,
  duplicateContent,
  staleToolResults,
  unusedTools,
  noCache,
  cacheMiss,
  oversizedSystem,
];

export const RULE_IDS = ALL_RULES.map((r) => r.id);
export type { Finding, Rule, RuleId, RuleOptions, Severity, Turn } from "./types.js";
