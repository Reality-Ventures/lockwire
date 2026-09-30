# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Tiered fingerprinting (`path`, `sig`, `body`, `deps`) for TypeScript, TSX, JavaScript, and Python symbols, via tree-sitter and truncated BLAKE3.
- `lockwire.lock` anchor store, with inline markdown markers (`<!-- lockwire <target> [tiers] [id] -->`) and lockfile-only bindings.
- `.lockwire/ledger.jsonl` — an append-only, order-independent, tamper-evident event log with `git notes`-style union-merge semantics and [Agent Trace](https://agent-trace.dev/)-shaped actors.
- CLI: `init`, `link`, `check` (text/JSON/GitHub-annotation output), `status`, `refs`, `history`, `ack`, `waive`, `unlink`, `ledger verify`.
- Claude Code plugin: `PreToolUse`/`PostToolUse` hooks (fail-open, advisory by default), an MCP server (8 tools), and a skill.
- Codex hook adapter, with a documented caveat on upstream `apply_patch`/`deny` enforcement gaps.
- A same-file rename heuristic (`relocated` status) based on exact `sig`-fingerprint matching.
- Time-boxed waivers with expiry, and a relink gate requiring `--reviewed` to re-stamp a currently-drifted anchor.
- GitHub Action (`action.yml`) for merge-time enforcement.

### Fixed

- Same-file rename detection never fired for renamed functions or classes, because `sig` fingerprints include the name. Candidates are now compared under the old name, and symbols already bound by another anchor are skipped.
- `lockwire check` no longer creates an empty `lockwire.lock` in a folder that has none, and the MCP tools say so instead of returning `[]` when they are rooted at such a folder.
- A `lockwire.lock` with unresolved git merge conflicts now fails with a message that says so and how to recover, instead of a bare JSON parse error.

### Known limitations (see [docs/concepts.md](docs/concepts.md#limitations))

- Local-variable normalization does not perform real lexical scope analysis.
- Statement reordering inside a function body is not normalized away.
- Rename detection is same-file only; cross-file relocation is not attempted.
- No cross-language dependency resolution.
- No semantic-claim extraction — lockwire does not read what a claim means, only whether its bound fingerprint moved.
