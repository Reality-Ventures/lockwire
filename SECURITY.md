# Security

## Reporting a vulnerability

Please don't open a public issue. Instead, use [GitHub's private vulnerability reporting](https://github.com/Reality-Ventures/lockwire/security/advisories/new) for this repository, or email the maintainers directly if that isn't available to you. Include a reproduction if you can — see [CONTRIBUTING.md](CONTRIBUTING.md) for what a good one looks like.

## What lockwire touches, and the threat model

lockwire's hook and MCP server run with the same filesystem access as the agent session hosting them. Specifically:

- **The hook reads arbitrary repository content** (any file an anchor targets) and **writes** `lockwire.lock` and `.lockwire/ledger.jsonl`. It never writes outside the repo root it resolves, and never executes anything it parses — parsing is read-only tree-sitter parsing, not code execution.
- **`additionalContext` injected into an agent's context includes text lifted from the repository** — a claim's excerpt, a target path, a note field. A repository that is itself untrusted (an unreviewed clone, a malicious PR checked out locally) could in principle craft a doc claim or a lockfile note designed to look like an instruction to the agent reading it. Treat any text a hook injects the same way you'd treat any other untrusted repository content reaching agent context — it is data describing what the repo's docs say, never an instruction lockwire itself is issuing.
- **Path handling**: a `target.path` in `lockwire.lock` is always resolved relative to the detected repo root; lockwire does not follow a target path outside that root. A hand-edited lockfile with a path-traversal target (`../../etc/passwd`) would currently be read as any other path lockwire is pointed at with the permissions the process already has — the same permissions the agent session hosting the hook already has over the repo tree. Report path-traversal behavior that goes further than that (e.g., writing outside the repo root) as a vulnerability.
- **The MCP server** exposes read and write tools (`lockwire_link`, `lockwire_ack`, `lockwire_waive`) with no additional authorization beyond whatever your MCP client already enforces — it inherits the trust boundary of whoever can call your agent's MCP tools, same as any other local MCP server.

## Fail-open is intentional, and its trade-off

Every hook handler fails open: an exception writes to `.lockwire/hook.log` and the tool call proceeds untouched, rather than blocking. This is a deliberate availability-over-strictness choice — see [docs/agents.md](docs/agents.md) — and means a crafted input that reliably throws inside the hook does not gain an attacker anything (the edit still needed to be a legitimate `Edit`/`Write` call in the first place; the hook only ever adds context or, in `ask`/`deny` mode, adds friction). If you find a case where a hook failure grants elevated behavior rather than simply skipping lockwire's own check, that's a vulnerability — report it.

## Supply chain

lockwire's runtime dependencies are `@modelcontextprotocol/sdk`, `@noble/hashes`, `web-tree-sitter`, and `zod`, all pinned to exact versions in `package.json`. Grammar `.wasm` files are copied at build time from pinned `devDependencies` (`tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python`) and shipped inside the published npm package under `grammars/` — they are not fetched at install or run time.
