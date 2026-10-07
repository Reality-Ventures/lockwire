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

- Path arguments weren't normalized: `lockwire link ./CLAUDE.md` stored the doc as `./CLAUDE.md` (never matching hooks or MCP lookups), `link guide.md` from `docs/` failed, and `check ./src/x.ts` scoped nothing and exited 0 on drift. CLI paths now resolve against the cwd and are stored repo-relative; `link` rejects a doc outside the repo. The MCP tools accept absolute and `./` paths the same way.
- Markers inside fenced code blocks (``` or ~~~, including indented ones) were treated as live bindings, so documentation examples got stamped. They are now ignored. An anchor whose marker sits inside a fence is reported as orphaned (marker removed).
- `lockwire ack --resolution` accepted any value; it now rejects anything but `updated`, `superseded` or `false-positive`.
- A function renamed *and* changed in a bound tier (say `body`) was re-stamped as fresh, hiding the change. Relocation now re-stamps only `sig` and reports any other moved bound tier as drift.
- A marker copy-pasted into a second doc silently took over the original's anchor, so the original sentence stopped being checked. If the original doc still holds the marker, the copy now gets its own id.
- `waive --expires` accepted any string, and an unparseable one never expired. It now requires a real ISO date in the future, and an unparseable expiry already in a lockfile counts as expired.
- One marker with an unsupported-language target (e.g. `main.go`) aborted the whole `link`. It is now skipped with a reason and the rest of the doc still links.
- A bound claim could be rewritten, or its marker deleted, and `check` would report `fresh` forever, because the claim hash was stored but never compared. `check` now flags an edited sentence as `drifted (claim)` and a removed marker as `orphaned`, ignoring whitespace-only changes and leaving existing anchors unflagged. Editing a doc also triggers the check for anchors bound to it (`check <doc>` and the PostToolUse hook).
- Same-file rename detection never fired for renamed functions or classes, because `sig` fingerprints include the name. Candidates are now compared under the old name, and symbols already bound by another anchor are skipped.
- `lockwire check` no longer creates an empty `lockwire.lock` in a folder that has none, and the MCP tools say so instead of returning `[]` when they are rooted at such a folder.
- A `lockwire.lock` with unresolved git merge conflicts now fails with a message that says so and how to recover, instead of a bare JSON parse error.
- Hooks now find the repository from the edited file's path (then the hook's reported `cwd`) instead of only the process cwd, so they fire when a session is started in a folder above the repo. Relative paths are resolved against the hook's `cwd`.

### Known limitations (see [docs/concepts.md](docs/concepts.md#limitations))

- Local-variable normalization does not perform real lexical scope analysis.
- Statement reordering inside a function body is not normalized away.
- Rename detection is same-file only; cross-file relocation is not attempted.
- No cross-language dependency resolution.
- No semantic-claim extraction — lockwire does not read what a claim means, only whether its bound fingerprint moved.
