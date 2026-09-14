import { fmt } from "./types.js";
import type { Rule } from "./types.js";

/** The general floor for a cacheable prefix; the exact minimum depends on the model. */
const MIN_PREFIX = 4096;

export const noCache: Rule = {
  id: "no-cache",
  title: "A stable prefix is re-sent every turn without prompt caching",
  description: `Anthropic: a prefix of ${MIN_PREFIX}+ tokens that is byte-identical across turns, with no cache_control anywhere in the request.`,
  defaultSeverity: "warn",
  check(turns) {
    const anthropic = turns.filter(
      (t) => t.context.kind === "anthropic-messages" && !t.context.cached,
    );
    if (anthropic.length < 2) return [];
    let repeats = 0;
    let uncached = 0;
    let prefixTokens = 0;
    for (let i = 1; i < anthropic.length; i++) {
      const a = anthropic[i - 1]!.context.sections;
      const b = anthropic[i]!.context.sections;
      let shared = 0;
      let j = 0;
      while (j < a.length && j < b.length && a[j]!.hash === b[j]!.hash) {
        shared += b[j]!.tokens;
        j++;
      }
      if (shared >= MIN_PREFIX) {
        repeats++;
        uncached += shared;
        prefixTokens = Math.max(prefixTokens, shared);
      }
    }
    if (!repeats) return [];
    const approx = anthropic.some((t) => !t.context.exact) ? "≈" : "";
    return [
      {
        rule: noCache.id,
        severity: "warn",
        tokens: uncached,
        message: `a ${approx}${fmt(prefixTokens)}-token prefix was sent unchanged on ${repeats} turn${repeats === 1 ? "" : "s"} without cache_control — ${approx}${fmt(uncached)} tokens paid at full price that a cache would have served at a tenth`,
        detail: [
          'add cache_control: { type: "ephemeral" } to the last stable block (the system prompt or the tool definitions)',
        ],
      },
    ];
  },
};
