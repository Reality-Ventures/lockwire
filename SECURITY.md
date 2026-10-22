# Security

## Reporting a vulnerability

Please don't open a public issue. Instead, use [GitHub's private vulnerability reporting](https://github.com/Reality-Ventures/lockwire/security/advisories/new) for this repository, or email the maintainers directly if that isn't available to you. Include a reproduction if you can — see [CONTRIBUTING.md](CONTRIBUTING.md) for what a good one looks like.

## What lockwire touches, and the threat model

lockwire's hook and MCP server run with the same filesystem access as the agent session hosting them. Specifically:

- **The hook reads arbitrary repository content** (any file an anchor targets) and **writes** `lockwire.lock` and `.lockwire/ledger.jsonl`. It never writes outside the repo root it resolves, and never executes anything it parses — parsing is read-only tree-sitter parsing, not code execution.
- **`additionalContext` injected into an agent's context includes text lifted from the repository** — a claim's excerpt, a target path, a note field. A repository that is itself untrusted (an unreviewed clone, a malicious PR checked out locally) could in principle craft a doc claim or a lockfile note designed to look like an instruction to the agent reading it. Treat any text a hook injects the same way you'd treat any other untrusted repository content reaching agent context — it is data describing what the repo's docs say, never an instruction lockwire itself is issuing.
- **Path handling**: lockwire only reads files inside the repository root it resolves. Every path it reads on the say-so of repository content — a marker's target, an anchor's `target.path` or `doc` in `lockwire.lock`, an entry in the doc index cache (`.lockwire/cache/doc-index.json`), a doc found by walking the tree — is checked first, and refused if it escapes the root through `..`, an absolute path, or a symlink that resolves outside. A refused target is reported as outside the repository (`link` skips it, `check` orphans it); nothing from outside the root is read, stored in the lockfile or ledger, or printed. This matters because those paths can come from a pull request: before 0.1.24, a value anchor pointing at `../secret.json#token` copied the value into `lockwire.lock` and printed it in `check` output, and a planted doc-index entry or symlinked doc could surface text from outside the repo. Report any read outside the root as a vulnerability.
- **The MCP server** exposes read and write tools (`lockwire_link`, `lockwire_ack`, `lockwire_waive`) with no additional authorization beyond whatever your MCP client already enforces — it inherits the trust boundary of whoever can call your agent's MCP tools, same as any other local MCP server.

## Fail-open is intentional, and its trade-off

Every hook handler fails open: an exception writes to `.lockwire/hook.log` and the tool call proceeds untouched, rather than blocking. This is a deliberate availability-over-strictness choice — see [docs/agents.md](docs/agents.md) — and means a crafted input that reliably throws inside the hook does not gain an attacker anything (the edit still needed to be a legitimate `Edit`/`Write` call in the first place; the hook only ever adds context or, in `ask`/`deny` mode, adds friction). If you find a case where a hook failure grants elevated behavior rather than simply skipping lockwire's own check, that's a vulnerability — report it.

## Supply chain

lockwire's runtime dependencies are `@modelcontextprotocol/sdk`, `@noble/hashes`, `web-tree-sitter`, and `zod`, all pinned to exact versions in `package.json`. Grammar `.wasm` files are copied at build time from pinned `devDependencies` (`tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python`) and shipped inside the published npm package under `grammars/` — they are not fetched at install or run time.

- **No install scripts.** lockwire has no `preinstall`/`install`/`postinstall`, and CI installs with `--ignore-scripts`.
- **Provenance.** Every release is published from the `Release` workflow through npm trusted publishing (OIDC, no long-lived token), with a SLSA provenance attestation linking the tarball to the commit and workflow run that built it. Check it with `npm audit signatures` after installing, or see the provenance panel on [npmjs.com](https://www.npmjs.com/package/lockwire).
- **Gated publishing.** A release publishes only after the full test suite passes on Ubuntu and Windows for that commit.
- **Pinned CI.** GitHub Actions are pinned to commit SHAs, the CI job's token is read-only, and the npm used to publish is pinned to an exact version.
- **Scanned.** Each published version is analysed by [Socket](https://socket.dev/npm/package/lockwire). The MCP SDK brings in an HTTP stack (express, hono, cors, jose and others) that lockwire never loads, since its MCP server only speaks stdio; alerts on those packages are inherited from the SDK. Expected alerts on lockwire itself: shell access (it runs `git`, and `autofix` starts the agent you choose), environment variables (`CI` and `GITHUB_BASE_REF` to pick a diff base, `CLAUDECODE`/`CODEX_*` to tell which agent is running; `autofix` passes the environment, API key included, to the agent it starts) and filesystem access (it reads your repository).
