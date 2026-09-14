---
"ctxlint": minor
---

First release. A byte-faithful local proxy for Anthropic and OpenAI, a record that never
contains a credential, and ten rules over what an app sends the model: budget, growth,
duplicate-content, stale-tool-results, unused-tools, no-cache, cache-miss (with the character
that broke the cache), oversized-system, secret-in-context, injection-in-tool-result.
`ctxlint wrap -- <command>`, a live proxy mode, `report`, `check` with exit codes 0/1/2,
`--json`, `--sections`. Works with anything that honours `ANTHROPIC_BASE_URL` /
`OPENAI_BASE_URL` — every official SDK, Claude Code, Codex CLI.
