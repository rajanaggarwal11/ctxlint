# ctxlint

**What are you actually sending the model?** Every LLM app has a context window, and almost nobody can see it: the framework assembles it, the SDK sends it, the bill arrives. `ctxlint` is a local proxy that reads every request your app makes to Anthropic or OpenAI and lints it — wasted tokens, the same block sent twice, tool definitions nobody calls, prompt-cache misses and the exact character that caused them, secrets in the prompt, injection arriving through tool results, and how fast the context is growing.

```bash
npx ctxlint wrap -- claude -p "summarise this repo"    # any command that honours ANTHROPIC_BASE_URL / OPENAI_BASE_URL
npx ctxlint wrap -- node agent.js
npx ctxlint                                            # a proxy that reports live; point your app at it
```

**It never modifies a request or a response, and the record never contains a credential.** Not a dashboard — a linter.

Here is Claude Code doing a small task (read three files, grep, `git log`), through the proxy:

```
$ ctxlint wrap -- claude -p "Read src/proxy.ts, src/exchange.ts and src/context.ts …" --model haiku
ctxlint · proxy on http://127.0.0.1:54580 · ANTHROPIC_BASE_URL and OPENAI_BASE_URL set for: claude -p … --model haiku
  #1 HEAD anthropic/api/hello  200 not a chat request 0.3s
  #2 POST anthropic/v1/messages claude-haiku-4-5-20251001 200 966 in · 15 out 1.1s
  #3 POST anthropic/v1/messages claude-haiku-4-5-20251001 200 35,760 in (32,452 cached) · 396 out 4.2s
  #4 POST anthropic/v1/messages claude-haiku-4-5-20251001 200 46,557 in (35,750 cached) · 92 out 1.9s
  #5 POST anthropic/v1/messages claude-haiku-4-5-20251001 200 46,743 in (46,549 cached) · 522 out 6.0s

ctxlint · 4 requests · claude-haiku-4-5-20251001 · ctxlint.session.jsonl

 turn      input   cache r/w   output   system   tools   history  model
    1        966           —       15      87%      0%       13%  claude-haiku-4-5-20251001
    2     35,760    32,452 r      396      19%     73%        8%  claude-haiku-4-5-20251001
    3     46,557    35,750 r       92      15%     57%       29%  claude-haiku-4-5-20251001
    4     46,743    46,549 r      522      15%     56%       29%  claude-haiku-4-5-20251001

tools: 29 defined, 26,244 tokens on turn 4 · largest: Bash 3,218 · DesignSync 2,455 · Monitor 2,290 · Agent 2,256 · Workflow 1,497

 warn  unused-tools
  ! 27 of 29 tool definitions were never called in 4 turns — 22,302 tokens on every turn that carries them
      Agent, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, Monitor, NotebookEdit, PushNotification, … (15 more)
────────────────────────────────────────────────
1 finding: 1 warning · 89,208 tokens at stake
```

Every turn after the warm-up is 56–73% tool definitions — 29 of them, 27 of which this task never touched. Nothing here is a bug in Claude Code — it caches all of it and pays a tenth of the price — but nobody had a way to see it before.

## What it finds

| Rule                       | Severity | What it catches                                                                                                                                                                                                                                                                                           |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret-in-context`        | error    | API keys, tokens, private keys, database passwords sent to the model, and where — system prompt, message, or which tool's result. Never repeats the secret.                                                                                                                                               |
| `injection-in-tool-result` | error    | Tool results and retrieved documents that tell the model to ignore its instructions, hide something from the user, send credentials, or carry invisible characters or fake role tags. This is where injection actually arrives. Reported once per poisoned result, not once per turn it stays in context. |
| `budget`                   | warn     | Input tokens per request over `--budget`.                                                                                                                                                                                                                                                                 |
| `growth`                   | warn     | Over 6+ turns, the context grows more than `--max-growth` per turn (median, so a warm-up call does not distort it) and never shrinks — and the turn at which the window fills.                                                                                                                            |
| `duplicate-content`        | warn     | The same 200+-token block twice in one request: a file pasted twice, a tool result echoed into a message, the system prompt repeated in the first user turn.                                                                                                                                              |
| `stale-tool-results`       | warn     | A 2,000+-token tool result from 6+ messages back still carried in full.                                                                                                                                                                                                                                   |
| `unused-tools`             | warn     | Tools defined on 3+ turns that the model never called, and what their definitions cost on every turn.                                                                                                                                                                                                     |
| `no-cache`                 | warn     | Anthropic: a 4,096+-token prefix sent byte-identical across turns with no `cache_control` — and what that cost.                                                                                                                                                                                           |
| `cache-miss`               | warn     | Anthropic: `cache_control` is on and `cache_read_input_tokens` is 0 — names the section and the first character where the prefix changed (`Current time: 14:02` → `14:03`).                                                                                                                               |
| `oversized-system`         | info     | The system prompt is 60%+ of the request.                                                                                                                                                                                                                                                                 |

`ctxlint --list-rules` prints the same. Money rules are warnings; security rules are errors; `--strict` makes warnings fail the build.

## Anatomy of a Claude Code turn

`ctxlint report --sections` lists every section of the last request, largest first. The same session as above (Claude Code 2.1.270, `claude-haiku-4-5`, 2026-09-14):

```
sections of turn 4, largest first
    6,740   14%  system  [cache_control]
    3,478    7%  result Read (msg 3)
    3,218    7%  tool Bash
    2,569    5%  result Read (msg 3)
    2,455    5%  tool DesignSync
    2,431    5%  result Read (msg 3)
    2,290    5%  tool Monitor
    2,256    5%  tool Agent
    1,805    4%  user (msg 1)
    1,497    3%  tool Workflow
       …
```

The system prompt is 6,740 tokens and carries `cache_control`; the 29 tool definitions add 26,244; the three files the task read are 8,478 across three `Read` results. 46,549 of the 46,743 input tokens on turn 4 were served from cache.

## How it works

```
your app ──(ANTHROPIC_BASE_URL / OPENAI_BASE_URL)──▶ ctxlint :port ──▶ api.anthropic.com / api.openai.com
                                                          │
                                                          ├─ records request + response usage (credentials stripped)
                                                          ├─ lints after every request, prints what is new
                                                          └─ ctxlint.session.jsonl
```

- **The wire is untouched.** Requests go upstream exactly as received (minus hop-by-hop headers), responses come back exactly as the upstream sent them — still compressed, still chunked, still streaming. A copy of each body is decoded on the side for the record. Tests compare hashes of what was sent with what arrived.
- **Three formats, one model.** Anthropic Messages, OpenAI Chat Completions and OpenAI Responses parse to the same ordered list of sections — system, tool definitions, user, assistant, tool results — each with its turn, a hash, and its `cache_control` marker.
- **Numbers.** Totals come from the provider's own `usage` and are exact. Per-section numbers are tokenizer estimates scaled so they sum to that exact total; when a response carried no usage (an OpenAI stream without `stream_options.include_usage`), the report says `≈` and never injects the option to get it.
- **The record.** One exchange per line in `ctxlint.session.jsonl`, local, credentials replaced with `[stripped]` before the line is written. `--no-record` keeps nothing. The record does hold the content of your requests — that is what gets linted.

## In CI

Record a scenario, then check it:

```yaml
- run: npx ctxlint wrap --session agent.jsonl -- node test/agent-scenario.js
- run: npx ctxlint check agent.jsonl --budget 60k --strict
```

Exit codes are stable: `0` nothing to report · `1` findings remain (errors, or warnings under `--strict`) · `2` could not run. `--json` emits a stable shape (`version: 1`) with per-turn totals, section breakdowns, and findings.

## Options

```
ctxlint wrap [options] -- <command> [args…]   Run a command through the proxy, then report
ctxlint [options]                              Start the proxy and report live (Ctrl-C to finish)
ctxlint report <session> [--sections]          Report on a recorded session
ctxlint check <session>                        Lint a recorded session for CI — exit 0/1/2

--port <n>              --upstream <name=url>     --session <file>     --no-record     --append
--budget <n>            --max-growth <pct>        --window <n>
--only <ids>            --ignore <ids>            --strict             --json          --sections
```

`--upstream` adds or replaces a target: `--upstream openai=https://my-gateway.internal` keeps the `OPENAI_BASE_URL` the proxy prints and sends the traffic wherever you say.

## As a library

```ts
import { startProxy, lintExchanges, contextOf } from "ctxlint";

const proxy = await startProxy({ onExchange: (x) => exchanges.push(x) });
// … run your app with proxy.env …
const { findings, turns } = lintExchanges(exchanges, { budget: 40_000 });
```

`contextOf(exchange)` gives you the section model for your own analysis; `ALL_RULES` is the list, and a `Rule` is a small interface.

## Works with

Anything that honours `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`: the official SDKs in every language, Claude Code, Codex CLI, and most frameworks built on those SDKs. A client that pins its base URL, or refuses `http://` for localhost, is out of scope.

## Design notes

**Why a proxy and not an SDK plugin.** There is one SDK plugin per language per framework, and none for the tool you did not write. There is one wire.

**Why it never modifies a request.** The moment a proxy changes what the model sees, its report is about something other than your app. Estimates are labelled ≈ rather than fixed by injecting `stream_options`.

**Heuristics are labelled.** `unused-tools` will flag a tool your next task needs; `growth` is a projection from a median. They exist to make a person look, with the number in hand.

**What it does not do.** No PII detection (a regex is worse than nothing there), no judgement of whether the model _followed_ an instruction (that needs a model), no cost in currency (prices change; tokens do not).

## Requirements

Node 22.13 or newer.

## Working with me

**Want this run on your agent?** I review what production agents send — cost, caching, the paths injection takes — and hand back the numbers with the fixes. Sponsor the project, or write to me: [aggarwal11.rajan05@gmail.com](mailto:aggarwal11.rajan05@gmail.com).

## License

[MIT](./LICENSE) © Rajan Aggarwal
