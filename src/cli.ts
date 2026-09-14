#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { lintExchanges } from "./lint.js";
import { startProxy } from "./proxy.js";
import { renderFindings, renderReport, renderSummary, toJson } from "./report.js";
import { ALL_RULES, RULE_IDS } from "./rules/index.js";
import type { Finding, RuleId } from "./rules/index.js";
import { fmt } from "./rules/types.js";
import { appendExchange, DEFAULT_SESSION, readSession } from "./session.js";
import type { Exchange } from "./types.js";
import { VERSION } from "./version.js";

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_ERROR = 2;

const HELP = `
ctxlint — what are you actually sending the model?

Usage
  ctxlint wrap [options] -- <command> [args…]   Run a command through the proxy, then report
  ctxlint [options]                              Start the proxy and report live (Ctrl-C to finish)
  ctxlint report <session> [options]             Report on a recorded session
  ctxlint check <session> [options]              Lint a recorded session for CI — exit 0/1/2

Proxy options
  --port <n>              Listen on this port (default: a free one)
  --upstream <name=url>   Add or replace an upstream; repeatable (default: anthropic, openai)
  --session <file>        Where to record (default: ${DEFAULT_SESSION}); --no-record keeps nothing
  --append                Keep an existing session file instead of starting fresh

Lint options
  --budget <n>            Input tokens per request above which 'budget' fires
  --max-growth <pct>      Median growth per turn above which 'growth' fires (default 10)
  --window <n>            Context window for the growth projection (default: from the model)
  --only <ids>            Run only these rules (comma-separated)
  --ignore <ids>          Skip these rules (comma-separated)
  --strict                Exit 1 on warnings too
  --json                  Machine-readable output (stable shape, version 1)
  --sections              Also print every section of the last request, largest first
  --list-rules            Print every rule and what it checks
  -v, --version           Print the version
  -h, --help              Print this

The proxy never modifies a request or a response.
The record never contains a credential: every authorization, api-key and
cookie header is stripped before an exchange is written.
Point an SDK at it with the two variables it prints.

Exit codes
  0  nothing to report (for 'wrap': the command succeeded and nothing to report)
  1  findings remain — errors, or warnings under --strict
  2  could not run — no session, bad option, upstream unreachable
`.trimStart();

interface Parsed {
  command: "proxy" | "wrap" | "report" | "check";
  positionals: string[];
  child: string[];
  values: Record<string, string | boolean | string[] | undefined>;
}

function parse(argv: string[]): Parsed {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const child = sep === -1 ? [] : argv.slice(sep + 1);
  const { values, positionals } = parseArgs({
    args: own,
    strict: false,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      upstream: { type: "string", multiple: true },
      session: { type: "string" },
      "no-record": { type: "boolean" },
      append: { type: "boolean" },
      budget: { type: "string" },
      "max-growth": { type: "string" },
      window: { type: "string" },
      only: { type: "string" },
      ignore: { type: "string" },
      strict: { type: "boolean" },
      json: { type: "boolean" },
      "list-rules": { type: "boolean" },
      sections: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  const first = positionals[0];
  const command = first === "wrap" || first === "report" || first === "check" ? first : "proxy";
  return {
    command,
    positionals: command === "proxy" ? positionals : positionals.slice(1),
    child,
    values: values as Parsed["values"],
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function rules(v: unknown, flag: string): RuleId[] | undefined {
  const s = str(v);
  if (!s) return undefined;
  const ids = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids)
    if (!RULE_IDS.includes(id as RuleId))
      throw new UsageError(`unknown rule "${id}" in ${flag}. Rules: ${RULE_IDS.join(", ")}`);
  return ids as RuleId[];
}

function int(v: unknown, flag: string): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s.replace(/[_,]/g, "").replace(/k$/i, "000"));
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} expects a number, got "${s}"`);
  return n;
}

class UsageError extends Error {}

function lintOptions(p: Parsed) {
  return {
    only: rules(p.values.only, "--only"),
    ignore: rules(p.values.ignore, "--ignore"),
    budget: int(p.values.budget, "--budget"),
    maxGrowthPct: int(p.values["max-growth"], "--max-growth"),
    window: int(p.values.window, "--window"),
  };
}

function exitFor(findings: Finding[], strict: boolean): number {
  if (findings.some((f) => f.severity === "error")) return EXIT_FINDINGS;
  if (strict && findings.some((f) => f.severity === "warn")) return EXIT_FINDINGS;
  return EXIT_OK;
}

function upstreams(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of Array.isArray(v) ? v : []) {
    const [name, ...rest] = String(item).split("=");
    const url = rest.join("=");
    if (!name || !url) throw new UsageError(`--upstream expects name=url, got "${item}"`);
    out[name] = url;
  }
  return out;
}

function listRules(): string {
  const w = Math.max(...ALL_RULES.map((r) => r.id.length));
  return (
    ALL_RULES.map(
      (r) =>
        `${pc.bold(r.id.padEnd(w))}  ${pc.dim(r.defaultSeverity.padEnd(5))}  ${r.title}\n${" ".repeat(w + 9)}${pc.dim(r.description)}`,
    ).join("\n") + "\n"
  );
}

const oneLine = (x: Exchange, n: number): string => {
  const u = x.response.usage;
  const tokens =
    x.kind === "other"
      ? pc.dim("not a chat request")
      : u.source === "provider"
        ? `${fmt(u.input)} in${u.cacheRead ? pc.dim(` (${fmt(u.cacheRead)} cached)`) : ""} · ${fmt(u.output)} out`
        : pc.dim("no usage in response");
  const status = x.error
    ? pc.red(`✗ ${x.error}`)
    : x.response.status >= 400
      ? pc.red(String(x.response.status))
      : pc.green(String(x.response.status));
  return `  ${pc.dim(`#${n}`)} ${x.method} ${x.upstream}${x.path.split("?")[0]} ${pc.dim(x.model ?? "")} ${status} ${tokens} ${pc.dim(`${(x.durationMs / 1000).toFixed(1)}s`)}`;
};

async function runProxy(p: Parsed, wrap: boolean): Promise<number> {
  const sessionPath = p.values["no-record"]
    ? undefined
    : resolve(str(p.values.session) ?? DEFAULT_SESSION);
  if (sessionPath && !p.values.append) writeFileSync(sessionPath, "");
  const exchanges: Exchange[] = [];
  const seen = new Set<string>();
  const opts = lintOptions(p);
  const out = (s: string) => process.stderr.write(s);

  const proxy = await startProxy({
    port: int(p.values.port, "--port"),
    upstreams: upstreams(p.values.upstream),
    onExchange: (x) => {
      exchanges.push(x);
      if (sessionPath) appendExchange(sessionPath, x);
      out(oneLine(x, exchanges.length) + "\n");
      // Live: only findings that are new since the last request.
      const fresh = lintExchanges(exchanges, opts).findings.filter((f) => {
        const key = `${f.rule}|${f.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length) out(renderFindings(fresh));
    },
  });

  const finish = async (): Promise<number> => {
    // The last exchange is recorded after the client has its bytes; give it a beat.
    await new Promise((r) => setTimeout(r, 250));
    await proxy.close();
    const result = lintExchanges(exchanges, opts);
    const title = sessionPath ?? "not recorded";
    if (p.values.json) process.stdout.write(JSON.stringify(toJson(result, title), null, 2) + "\n");
    else process.stdout.write("\n" + renderReport(result, title, !!p.values.sections));
    return exitFor(result.findings, !!p.values.strict);
  };

  if (wrap) {
    const [cmd, ...args] = p.child;
    if (!cmd)
      throw new UsageError("wrap needs a command after --, e.g. ctxlint wrap -- node agent.js");
    out(
      pc.dim(
        `ctxlint · proxy on ${proxy.url} · ANTHROPIC_BASE_URL and OPENAI_BASE_URL set for: ${[cmd, ...args].join(" ")}\n`,
      ),
    );
    const code = await new Promise<number>((resolveCode) => {
      const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...proxy.env } });
      child.on("error", (err) => {
        out(pc.red(`✗ could not start ${cmd}: ${err.message}\n`));
        resolveCode(EXIT_ERROR);
      });
      child.on("exit", (c, signal) => resolveCode(c ?? (signal ? 128 : EXIT_ERROR)));
    });
    const lintCode = await finish();
    return code !== 0 ? code : lintCode;
  }

  out(
    `${pc.bold("ctxlint")} ${pc.dim(`· proxy on ${proxy.url} · recording to ${sessionPath ?? "nowhere (--no-record)"}`)}\n\n` +
      `  export ANTHROPIC_BASE_URL=${proxy.env.ANTHROPIC_BASE_URL}\n  export OPENAI_BASE_URL=${proxy.env.OPENAI_BASE_URL}\n\n` +
      pc.dim("  Run your app in another shell. Ctrl-C here for the report.\n\n"),
  );
  return new Promise((resolveCode) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      finish().then(resolveCode, () => resolveCode(EXIT_ERROR));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function runOnSession(p: Parsed): number {
  const file = p.positionals[0] ?? DEFAULT_SESSION;
  const path = resolve(file);
  if (!existsSync(path))
    throw new UsageError(
      `no session file at ${file}. Record one with 'ctxlint wrap -- <command>'.`,
    );
  const result = lintExchanges(readSession(path), lintOptions(p));
  if (p.values.json) process.stdout.write(JSON.stringify(toJson(result, file), null, 2) + "\n");
  else if (p.command === "report")
    process.stdout.write(renderReport(result, file, !!p.values.sections));
  else process.stdout.write(renderFindings(result.findings) + renderSummary(result.findings));
  return exitFor(result.findings, !!p.values.strict);
}

export async function run(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
    if (p.values.help) {
      process.stdout.write(HELP);
      return EXIT_OK;
    }
    if (p.values.version) {
      process.stdout.write(`${VERSION}\n`);
      return EXIT_OK;
    }
    if (p.values["list-rules"]) {
      process.stdout.write(listRules());
      return EXIT_OK;
    }
    if (p.command === "report" || p.command === "check") return runOnSession(p);
    return await runProxy(p, p.command === "wrap");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${pc.red("✗")} ${msg}\n`);
    return EXIT_ERROR;
  }
}

/** npm installs the bin as a symlink, so both sides are resolved before comparing. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(EXIT_ERROR);
    },
  );
}
