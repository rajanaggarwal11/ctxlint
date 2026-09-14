import { excerpt } from "./patterns.js";
import { fmt } from "./types.js";
import type { Finding, Rule } from "./types.js";

/** First index at which two strings differ, or -1 when equal. */
function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export const cacheMiss: Rule = {
  id: "cache-miss",
  title: "Prompt caching is on, and the cache missed — here is the byte that broke it",
  description:
    "Anthropic: cache_control is present but cache_read_input_tokens is 0 on a turn after the first. Names the first section, and the first character, where the prefix changed.",
  defaultSeverity: "warn",
  check(turns) {
    const findings: Finding[] = [];
    const cached = turns.filter((t) => t.context.kind === "anthropic-messages" && t.context.cached);
    for (let i = 1; i < cached.length; i++) {
      const prev = cached[i - 1]!;
      const cur = cached[i]!;
      const u = cur.context.usage;
      if (u.source !== "provider" || u.cacheRead > 0) continue;
      // The cached prefix ends at the last section that carries cache_control.
      const lastMarker = cur.context.sections.map((s) => !!s.cacheControl).lastIndexOf(true);
      const prefix = cur.context.sections.slice(0, lastMarker + 1);
      const before = prev.context.sections;
      let found = false;
      for (let j = 0; j < prefix.length; j++) {
        const now = prefix[j]!;
        const was = before[j];
        if (was && was.hash === now.hash) continue;
        found = true;
        const at = was ? firstDiff(was.text, now.text) : 0;
        const where =
          now.kind === "system"
            ? "the system prompt"
            : now.kind === "tool-def"
              ? `the definition of ${now.name ?? "a tool"}`
              : `${now.kind} message ${now.turn + 1}`;
        findings.push({
          rule: cacheMiss.id,
          severity: "warn",
          turn: cur.n,
          tokens: u.cacheWrite || prefix.reduce((a, s) => a + s.tokens, 0),
          message: `cache missed on turn ${cur.n}: ${where} differs from turn ${prev.n} at char ${fmt(at)} — move whatever changes there after the cache breakpoint`,
          detail: was
            ? [`was: "${excerpt(was.text, at, 24)}"`, `now: "${excerpt(now.text, at, 24)}"`]
            : [`section ${j + 1} did not exist on turn ${prev.n}`],
        });
        break;
      }
      if (!found) {
        findings.push({
          rule: cacheMiss.id,
          severity: "warn",
          turn: cur.n,
          tokens: u.cacheWrite,
          message: `cache missed on turn ${cur.n} with a prefix identical to turn ${prev.n} — the cache may have expired (5 minutes idle) or the prefix is under the model's minimum cacheable length`,
        });
      }
    }
    return findings;
  },
};
