---
"ctxlint": patch
---

`--budget`, `--window` and `--max-growth` read a `k` or `m` suffix as a multiplier: `--budget 1.5k` is 1,500 tokens, not 1.5. A value that is not a number now says what it expects.
