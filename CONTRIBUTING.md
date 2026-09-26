# Contributing

## Setup

```bash
git clone https://github.com/Reality-Ventures/lockwire.git
cd lockwire
npm install --ignore-scripts --legacy-peer-deps
npm run build
npm test
```

`--ignore-scripts` skips the native `node-gyp-build` install step the tree-sitter grammar packages carry for their (unused) native bindings — lockwire only uses their bundled `.wasm` files via `web-tree-sitter`, copied into `grammars/` by `npm run grammars` (part of `npm run build`). `--legacy-peer-deps` works around an npm dependency-resolution issue with `web-tree-sitter`'s peer declarations; it does not indicate a real conflict.

## Before opening a PR

```bash
npm run typecheck
npm run lint
npm run build
npm test
node dist/cli.js check   # lockwire checking its own docs — the repo dogfoods itself
```

CI (`.github/workflows/ci.yml`) runs all of this on Ubuntu and Windows.

## Releasing

Bump `version` in `package.json`, push a `vX.Y.Z` tag. `.github/workflows/release.yml` builds, tests, and publishes to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) — no stored token. One-time npmjs.com setup: package Settings → Trusted Publisher → GitHub Actions → org `Reality-Ventures`, repo `lockwire`, workflow `release.yml`.

## Where things live

| Path | What |
|---|---|
| `src/extract.ts` | tree-sitter → tiered symbol extraction (the core mechanism) |
| `src/actions.ts` | `link`/`check`/`ack`/`waive`/`refs`/`status`/`history` — the verbs, shared by the CLI, hooks, and MCP server |
| `src/hook-claude.ts`, `src/hook-codex.ts` | per-agent hook adapters — thin, fail-open wrappers over `src/hook-common.ts` |
| `src/mcp-server.ts` | the MCP tool surface |
| `src/ledger.ts` | append-only event log, hashing, verification |
| `test/*.test.ts` | vitest — `test/e2e.test.ts` is the P0 falsification demo; run it first when touching `extract.ts` |

## Adding a language

1. Add its tree-sitter grammar package to `devDependencies` and copy step in `scripts/grammars.mjs`.
2. Add it to `LangId` and `GRAMMAR_FILE` in `src/grammar.ts`, and `langForPath`.
3. Add its declaration node types to `DECLARATION_TYPES` in `src/extract.ts`, and its parameter-extraction shape if it differs from the TS/Python ones already there.
4. Add fixtures to `test/extract.test.ts` mirroring the existing TS/Python/TSX cases — at minimum: a body-only edit that shouldn't move `sig`, and a real signature change that should.

## Filing an issue

Say what you expected `check`/`link`/a hook to do, what it actually did, and — if it's a false positive or false negative — the smallest code+doc pair that reproduces it. A reproducible false positive is the single most valuable kind of issue this project can receive; tiering exists specifically to minimize them, and any that get through are bugs, not expected behavior.

## Suggested GitHub topics

`documentation` `docs-as-code` `claude-code` `claude-code-plugin` `codex` `mcp` `mcp-server` `tree-sitter` `developer-tools` `ai-agents` `context-engineering` `agents-md` `documentation-drift`
