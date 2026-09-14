# Security policy

## Supported versions

The latest published minor version receives fixes. This project is pre-1.0, so older minors are not backported.

## Reporting a vulnerability

Please report privately through GitHub's [security advisory form](https://github.com/rajanaggarwal11/mcpcheck/security/advisories/new) rather than opening a public issue.

You should get an acknowledgement within 72 hours and an assessment within a week.

## Scope

`mcpcheck` connects to an MCP server you name, performs the `initialize` handshake and
`tools/list`, and disconnects. It never calls a tool. It spawns the command you give it and
reads that process's stderr only to explain a failed handshake.

The reports most worth making:

- A description-lint pattern that can be evaded trivially (an instruction the model would
  obey that the rule does not see), or a false positive on the official reference servers.
- Any path by which mcpcheck invokes a tool, or writes anything other than the snapshot file
  you named.
- Output that includes a credential from a connection URL.
