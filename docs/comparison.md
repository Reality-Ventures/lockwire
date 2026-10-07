# Comparison

Verified against each project's own repository and release history as of September 2026. Corrections welcome — open an issue with a source.

## Direct comparison

| | lockwire | fiberplane/drift | ClaudeDrift | pallaprolus/drift | agents-md-lint |
|---|---|---|---|---|---|
| Mechanism | 4 tiers per symbol (path/sig/body/deps) | 1 AST hash per anchor (XxHash3) | LLM reasoning via subagents, on demand | 1 drift score (0–1) per doc-code pair | Deterministic reference checks (paths, commands) |
| Write-time agent hook | ✅ Claude Code + Codex | ❌ | ❌ | ❌ | ❌ |
| History / ledger | ✅ append-only, tamper-evident, `history` query | ❌ | ❌ | ❌ | ❌ |
| Catches semantic drift (meaning changed, refs still resolve) | ❌ roadmap | ❌ | ✅ (its whole design) | ✅ opt-in, on-demand AI check | ❌ |
| Runs with no LLM, no network | ✅ | ✅ | ❌ | ✅ (core checks; AI check is separate and opt-in) | ✅ |
| Distribution | npm CLI, Claude Code plugin, `npx skills`, GitHub Action | Homebrew, shell installer, Claude Code/Codex skill | Claude Code plugin only | VS Code extension, npm CLI (`docs-drift`), GitHub Action | pip/pipx |
| Languages | TS, TSX, JS, Python | TS, Python, Rust, Go, Zig, Java | any (LLM reads the repo) | TS/JS, Python, Go, Rust, Java |Any (path/command checks, not language-aware) |

## fiberplane/drift

[github.com/fiberplane/drift](https://github.com/fiberplane/drift) — MIT, Zig, announced 25 March 2026, still active (last release v0.10.1, 22 June 2026). The closest thing to lockwire in mechanism, and the most mature: `drift link`/`drift check`/`drift refs`/`drift status`, a `drift.lock` TOML lockfile, git blame surfaced on stale anchors, cross-repo `origin`-qualified anchors, a relink gate (`Relink gate: refuse drift link on stale anchors unless explicitly reviewed`, which lockwire's `--reviewed` flag mirrors — a good idea, credited).

Where it stops: **one hash per anchor.** A `body` refactor invalidates a doc that only ever claimed something about a signature, which is the specific false-positive flood that tiering exists to prevent. No ledger, no history query, no write-time agent hook — detection happens at `drift check`, which is a CI-time or manual-time gate, not a write-time one. `drift refs` is real reverse lookup, which lockwire's `refs` command deliberately parallels.

## ClaudeDrift

[github.com/marky291/claude-drift](https://github.com/marky291/claude-drift) — MIT, a Claude Code plugin. Its mechanism is the opposite of lockwire's: no hashing at all, no deterministic parser. It reads `CLAUDE.md`, skills, and agents alongside the actual codebase and asks Claude's own reasoning, via subagents, whether each artifact is still true. Its README documents abandoning an earlier deterministic scanner specifically because of false positives on prose that looks like a path — "reasoning got every one right by *understanding* the artifact."

This is a real strength lockwire doesn't have: it catches **context drift** ("we use Redux" when the code moved to Zustand, with every path still resolving) and **legacy narration** (accurate but framed as migration history rather than present-tense instruction) — categories no hash can see by construction. It's on-demand and costs a model call per run, not continuous, and keeps no history. lockwire's [docs/concepts.md](concepts.md#limitations-read-before-relying-on-this-in-production) names this same gap in the other direction: hashes cannot catch semantic drift. The two are complementary, not competing — a deterministic continuous layer plus a reasoning on-demand layer, run together.

## pallaprolus/drift

[github.com/pallaprolus/drift](https://github.com/pallaprolus/drift) — MIT, TypeScript. A real three-surface product: a VS Code extension (marketplace-listed, with gutter marks and quick fixes), a CLI (`npx docs-drift`), and a GitHub Action, all sharing one engine. Checks JSDoc/docstring parameter and return-type drift, cross-checks fenced code examples in README/docs against real signatures, and — a genuinely useful signal lockwire doesn't have — uses `git blame` to flag docs that are older than the code they describe, even when nothing else looks wrong. Its one semantic-drift capability is an opt-in, on-demand AI check, explicitly never triggered automatically.

Where it stops: one drift score (0–1, with a severity band) per doc-code pair rather than tiered fingerprints, so it faces the same body-refactor-flags-a-signature-claim problem fiberplane/drift does. No write-time hook, no ledger.

## agents-md-lint (two independent projects)

Both `openintelligence-labs/agents-md-lint` and `rk-chavali/agents-md-lint` (unrelated, converged on the same name and problem independently, 2026) check whether backticked paths and shell commands referenced in `AGENTS.md`/`CLAUDE.md` actually exist — no tree-sitter, no hashing, deterministic string/filesystem checks only. Both explicitly design around false-positive avoidance (URLs, globs, `~/paths`, placeholders) as the primary constraint, the same lesson ClaudeDrift's README states from the opposite direction. Reference-level only: they can tell you a path is gone, not that a function's contract changed while its path stayed put.

## Why we aren't competing on the hash

Tiered, aspect-separated fingerprinting is the one piece of this mechanism nobody else in this list ships. That's a real technical edge, but hashing approaches are easy to copy — fiberplane/drift, in particular, already has the parser, the anchor format, and the distribution to add tiering in a quarter or two if they choose to. lockwire's durable moat is the combination the others don't have any part of: **write-time enforcement inside the agent, plus a history that survives renames.** See the [P0 test suite](../test/e2e.test.ts) for what tiering buys today, and [docs/ledger.md](ledger.md) for the history mechanism nothing else here has at all.
