# Security

`ctxlint` is a local proxy that sits between your application and Anthropic or OpenAI, and a
linter over what passes through it. Three things about it are security-relevant, and each is
tested:

- **It never modifies a request or a response.** Bytes go upstream and come back exactly as
  sent — still compressed, still streaming. A copy is decoded on the side for the record.
- **The record never contains a credential.** Every `authorization`, `x-api-key`, `api-key`,
  `cookie` and similar header is replaced with `[stripped]` before an exchange exists. The
  record does contain the _content_ of requests — that is what gets linted — and it stays on
  your machine (`ctxlint.session.jsonl`; `--no-record` keeps nothing).
- **It listens on 127.0.0.1 only**, on a free port, for the life of the command.

## Reporting

Please report privately through GitHub's
[security advisory form](https://github.com/rajanaggarwal11/ctxlint/security/advisories/new)
rather than a public issue, for anything like:

- A way the proxy could alter, drop or reorder what the model receives or what the client
  receives.
- A credential reaching the record, the terminal, or the JSON output by any path.
- A way to make the proxy forward to a host the user did not name with `--upstream`.
- A finding message that repeats a secret (`secret-in-context` is designed never to).

Everything else — a rule that misfires on your traffic, a wrong number — is an ordinary
issue, and a welcome one.
