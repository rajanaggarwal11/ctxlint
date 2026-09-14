import pc from "picocolors";
import { fmt } from "./rules/types.js";
import type { Finding, RuleId, Turn } from "./rules/index.js";
import type { LintResult } from "./lint.js";

const pad = (s: string, n: number) => s.padStart(n);
const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : "—");

export function sectionTotals(turn: Turn) {
  const t = { system: 0, tools: 0, user: 0, assistant: 0, toolResult: 0 };
  for (const s of turn.context.sections) {
    if (s.kind === "system") t.system += s.tokens;
    else if (s.kind === "tool-def") t.tools += s.tokens;
    else if (s.kind === "user") t.user += s.tokens;
    else if (s.kind === "assistant") t.assistant += s.tokens;
    else t.toolResult += s.tokens;
  }
  return t;
}

export function summarize(findings: Finding[]) {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  const info = findings.filter((f) => f.severity === "info").length;
  const tokensAtStake = findings.reduce((a, f) => a + (f.tokens ?? 0), 0);
  return { total: errors + warnings + info, errors, warnings, info, tokensAtStake };
}

/** The per-turn table: what each request was made of. */
export function renderTurns(turns: Turn[]): string {
  if (!turns.length) return `${pc.dim("no chat requests recorded")}\n`;
  const lines: string[] = [];
  lines.push(
    pc.dim(
      `${pad("turn", 5)}  ${pad("input", 9)}  ${pad("cache r/w", 10)}  ${pad("output", 7)}  ${pad("system", 7)}  ${pad("tools", 6)}  ${pad("history", 8)}  model`,
    ),
  );
  for (const t of turns) {
    const s = sectionTotals(t);
    const total = t.context.totalTokens;
    const history = s.user + s.assistant + s.toolResult;
    const u = t.context.usage;
    const cache = u.cacheRead
      ? `${fmt(u.cacheRead)} r`
      : u.cacheWrite
        ? `${fmt(u.cacheWrite)} w`
        : "—";
    lines.push(
      `${pad(String(t.n), 5)}  ${pad((t.context.exact ? "" : "≈") + fmt(total), 9)}  ${pad(cache, 10)}  ${pad(u.source === "provider" ? fmt(u.output) : "—", 7)}  ${pad(pct(s.system, total), 7)}  ${pad(pct(s.tools, total), 6)}  ${pad(pct(history, total), 8)}  ${pc.dim(t.context.model ?? "")}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function renderFindings(findings: Finding[]): string {
  if (!findings.length) return `${pc.green("✓")} No problems found.\n`;
  const out: string[] = [];
  const byRule = new Map<RuleId, Finding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  for (const [rule, fs] of byRule) {
    const sev = fs[0]!.severity;
    const badge =
      sev === "error"
        ? pc.bgRed(pc.black(" error "))
        : sev === "warn"
          ? pc.bgYellow(pc.black(" warn "))
          : pc.bgCyan(pc.black(" info "));
    out.push(`${badge} ${pc.bold(rule)}`);
    for (const f of fs) {
      const mark = sev === "error" ? pc.red("✗") : sev === "warn" ? pc.yellow("!") : pc.cyan("i");
      out.push(`  ${mark} ${f.message}`);
      for (const d of f.detail ?? []) out.push(pc.dim(`      ${d}`));
    }
    out.push("");
  }
  return out.join("\n");
}

export function renderSummary(findings: Finding[]): string {
  const s = summarize(findings);
  if (!s.total) return "";
  const parts = [
    s.errors ? pc.red(`${s.errors} error${s.errors === 1 ? "" : "s"}`) : "",
    s.warnings ? pc.yellow(`${s.warnings} warning${s.warnings === 1 ? "" : "s"}`) : "",
    s.info ? pc.cyan(`${s.info} info`) : "",
  ].filter(Boolean);
  const stake = s.tokensAtStake ? pc.dim(` · ${fmt(s.tokensAtStake)} tokens at stake`) : "";
  return `${pc.dim("─".repeat(48))}\n${pc.bold(`${s.total} finding${s.total === 1 ? "" : "s"}`)}: ${parts.join(", ")}${stake}\n`;
}

export function renderReport(result: LintResult, title: string): string {
  const models = [...new Set(result.turns.map((t) => t.context.model).filter(Boolean))];
  const head = `${pc.bold("ctxlint")}${pc.dim(` · ${result.turns.length} request${result.turns.length === 1 ? "" : "s"}${models.length ? ` · ${models.join(", ")}` : ""} · ${title}`)}\n`;
  return `${head}\n${renderTurns(result.turns)}\n${renderFindings(result.findings)}${renderSummary(result.findings)}`;
}

export function toJson(result: LintResult, session: string) {
  return {
    version: 1,
    session,
    requests: result.turns.length,
    turns: result.turns.map((t) => ({
      n: t.n,
      ...(t.context.model ? { model: t.context.model } : {}),
      kind: t.context.kind,
      input: t.context.totalTokens,
      exact: t.context.exact,
      cacheRead: t.context.usage.cacheRead,
      cacheWrite: t.context.usage.cacheWrite,
      output: t.context.usage.output,
      tools: t.context.tools.length,
      toolCalls: t.context.toolCalls,
      sections: sectionTotals(t),
    })),
    rulesRun: result.rulesRun,
    summary: summarize(result.findings),
    findings: result.findings,
  };
}
