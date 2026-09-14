import { SECRET_PATTERNS } from "./patterns.js";
import type { Finding, Rule } from "./types.js";

const where = (s: { kind: string; turn: number; name?: string }) =>
  s.kind === "system"
    ? "the system prompt"
    : s.kind === "tool-def"
      ? `the definition of ${s.name ?? "a tool"}`
      : s.kind === "tool-result"
        ? `a ${s.name ? `${s.name} ` : ""}tool result`
        : `a ${s.kind} message`;

export const secretInContext: Rule = {
  id: "secret-in-context",
  title: "A credential was sent to the model",
  description:
    "API keys, tokens, private keys and database passwords anywhere in the request. The finding never repeats the secret.",
  defaultSeverity: "error",
  check(turns) {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const t of turns) {
      for (const s of t.context.sections) {
        for (const { pattern, what } of SECRET_PATTERNS) {
          if (!pattern.test(s.text)) continue;
          const key = `${what}:${s.hash}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            rule: secretInContext.id,
            severity: "error",
            turn: t.n,
            message: `${what} was sent to the model in ${where(s)} on turn ${t.n}${s.turn >= 0 ? ` (message ${s.turn + 1})` : ""}`,
          });
        }
      }
    }
    return findings;
  },
};
