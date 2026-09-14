import { INSTRUCTION_PATTERNS, INVISIBLE, excerpt } from "./patterns.js";
import type { Finding, Rule } from "./types.js";

export const injectionInToolResult: Rule = {
  id: "injection-in-tool-result",
  title: "A tool result carries instructions for the model",
  description:
    "Tool results and retrieved documents that tell the model to ignore its instructions, hide something from the user, send credentials, or carry invisible characters or fake role tags. This is where injection actually arrives.",
  defaultSeverity: "error",
  check(turns) {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const t of turns) {
      for (const s of t.context.sections) {
        if (s.kind !== "tool-result") continue;
        const label = `a ${s.name ? `${s.name} ` : ""}tool result on turn ${t.n} (message ${s.turn + 1})`;
        for (const { pattern, why } of INSTRUCTION_PATTERNS) {
          const m = pattern.exec(s.text);
          if (!m) continue;
          const key = `${why}:${s.hash}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            rule: injectionInToolResult.id,
            severity: "error",
            turn: t.n,
            message: `${label} ${why}`,
            detail: [`"${excerpt(s.text, m.index, m[0].length)}"`],
          });
        }
        const inv = INVISIBLE.exec(s.text);
        if (inv) {
          const key = `invisible:${s.hash}`;
          if (!seen.has(key)) {
            seen.add(key);
            const cp = inv[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
            findings.push({
              rule: injectionInToolResult.id,
              severity: "error",
              turn: t.n,
              message: `${label} contains an invisible character (U+${cp}) at offset ${inv.index} — text a human reviewer cannot see`,
            });
          }
        }
      }
    }
    return findings;
  },
};
