# Contributing

Issues and pull requests welcome — especially "this rule is wrong about my app's requests".
A false positive on real traffic is the most useful report this project can get; there is an
issue template for it.

## Working here

```bash
pnpm install
pnpm check      # lint, typecheck, build, test — must be green before a PR
```

Tests run the real proxy against an in-process fake upstream (`test/helpers/upstream.ts`)
that speaks Anthropic Messages, OpenAI Chat Completions and OpenAI Responses, streamed and
whole, and compare hashes of what was sent with what arrived. Rules are tested on sessions
built with `test/helpers/session.ts`.

## Adding or changing a rule

A rule is one file in `src/rules/`, registered in `src/rules/index.ts`. Every rule ships with:

- a fixture that trips it and one that does not, in `test/rules.test.ts`;
- a message a person can act on — say _where_ and _how many tokens_, never repeat a secret;
- proof the test can fail: put the bug back, watch the test go red, restore it.

Per-section token numbers are estimates calibrated to the provider's total; a rule that
depends on exact per-section counts should say ≈ in its message when `context.exact` is
false.

Commits carry no co-author trailers. Changesets: `pnpm changeset` for anything user-visible.
