import { fmt } from "./types.js";
import type { Finding, Rule } from "./types.js";

const MIN_TOKENS = 200;

const where = (s: { kind: string; turn: number; name?: string }) =>
  s.kind === "system"
    ? "the system prompt"
    : s.kind === "tool-def"
      ? `the definition of ${s.name ?? "a tool"}`
      : s.kind === "tool-result"
        ? `the ${s.name ?? ""} result in message ${s.turn + 1}`
        : `${s.kind} message ${s.turn + 1}`;

export const duplicateContent: Rule = {
  id: "duplicate-content",
  title: "The same block is sent twice in one request",
  description: `A block of ${MIN_TOKENS}+ tokens that appears more than once in a single request — a file pasted twice, a tool result echoed into a message, the system prompt repeated in the first user turn.`,
  defaultSeverity: "warn",
  check(turns) {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const t of turns) {
      const byHash = new Map<string, typeof t.context.sections>();
      for (const s of t.context.sections) {
        if (s.tokens < MIN_TOKENS) continue;
        byHash.set(s.hash, [...(byHash.get(s.hash) ?? []), s]);
      }
      for (const [hash, group] of byHash) {
        if (group.length < 2 || seen.has(hash)) continue;
        seen.add(hash);
        const first = group[0]!;
        findings.push({
          rule: duplicateContent.id,
          severity: "warn",
          turn: t.n,
          tokens: first.tokens * (group.length - 1),
          message: `the same ${t.context.exact ? "" : "≈"}${fmt(first.tokens)}-token block appears ${group.length} times in turn ${t.n}: ${group.map(where).join(", ")}`,
          detail: [`"${first.text.slice(0, 80).replace(/\s+/g, " ")}…"`],
        });
      }
    }
    return findings;
  },
};
