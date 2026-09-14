# Contributing

Issues and pull requests welcome — especially "this rule is wrong about my server". A false
positive on a real server is the most useful report this project can get.

## Setup

```bash
pnpm install
pnpm check     # lint · typecheck · build · test
```

Tests spawn real MCP servers from `test/fixtures/` over stdio and inspect them through the
official SDK client. No mocks. Each fixture violates exactly the rules it is named for; the
clean one violates none.

## Adding a rule

One file in `src/rules/`, one line in `src/rules/index.ts`, one fixture that trips it, and
tests in `test/rules.test.ts`. State the problem, not the advice; put advice in `detail`.

## Before you call a test done

Put the bug back. Make the rule return `[]` and confirm its tests fail, then restore it. The
release notes list how many tests each rule holds up; keep that list true.

## Releasing

Changesets. `pnpm changeset` with your PR; merging to `main` opens a release PR.
