# Concepts

The mental model behind lockwire: what an anchor is, why fingerprints are tiered, and where the current implementation's edges are.

## A claim is a contract against a specific state of code

A sentence like "`createSession` takes a `UserId` and returns a `Session`" is true only as long as the code it describes matches that description. Nothing in a markdown file or a git repo structurally enforces that — the sentence and the function drift independently, and nothing tells you when they've diverged. lockwire's whole design is one idea: **fingerprint the state the claim depends on, store the fingerprint next to the claim, and recompute it whenever asked.**

## Anchors

An **anchor** is the binding between a claim and a **target** — a file path, optionally narrowed to a symbol (`src/auth/session.ts#createSession`). It's stored in `lockwire.lock` at the repo root:

```jsonc
{
  "id": "k7q2m9xv",
  "doc": "CLAUDE.md",
  "claim": { "line": 3, "hash": "b3:…", "excerpt": "`createSession` takes a `UserId`…" },
  "target": { "path": "src/auth/session.ts", "symbol": "createSession" },
  "tiers": ["sig"],
  "fingerprints": { "path": "b3:…", "sig": "b3:…", "body": "b3:…", "deps": "b3:…" },
  "linked": { "at": "2026-09-25T10:00:11Z", "commit": null, "by": { "type": "human" } },
  "status": "fresh",
  "waiver": null
}
```

<!-- lockwire src/hash.ts#fingerprint sig id=e8rb5adk -->
A fingerprint is `b3:` followed by 32 lowercase hex characters — the first 128 bits of a BLAKE3 digest of the tier's normalized input.

All four fingerprints are always computed and stored, but only the tiers listed in `tiers` are checked against the claim. The other three are there so `lockwire check` can report the **noise metric** — how many anchors a single-hash tool would have flagged versus how many actually drifted.

## The four tiers

| Tier | What it hashes | Changes when | Doesn't change when |
|---|---|---|---|
| `path` | The repo-relative file path | The file moves or is renamed | Anything inside the file |
| `sig` | Symbol kind, name, parameter names and type annotations, return type, modifiers (`export`/`async`/decorators) | The contract changes | Body edits, refactors, reformatting |
| `body` | A normalized AST of the implementation — comments stripped, local identifiers alpha-renamed | Real behavior changes | Reformatting, renaming a local variable |
| `deps` | A sorted set of outbound calls and referenced imports | A dependency is added, removed, or swapped | Reordering calls, unrelated body edits |

A whole-file anchor (no `#Symbol`) binds `path` and `body` by default; a symbol anchor binds `sig` by default. Most prose only needs `sig` — that's the entire point. A doc claiming "takes a `UserId`, returns a `Session`" cares about the contract, not the implementation, and binding `sig` makes it immune to every refactor that doesn't touch the contract.

## The claim side of the binding

The fingerprint only covers half of the contract. The anchor also stores a hash of the claim sentence it was stamped against (`claim.normHash`, whitespace-insensitive), and `lockwire check` re-reads the doc and compares:

- **Sentence rewritten** → `drifted`, shown as `(claim)`. The code hasn't moved, but the claim is no longer the one anyone verified against it. Re-verify it, then `lockwire link <doc>` re-stamps it — no `--reviewed` needed when only the sentence changed.
- **Marker deleted (or the doc removed)** → `orphaned`. Use `lockwire unlink <id>` for a deliberate removal, or restore the marker and re-link.
- **Re-wrapping or reformatting** the sentence is ignored. Anchors linked before `normHash` existed fall back to the raw hash, and to the stored excerpt for short claims, so upgrading doesn't flag them; the first `check` that finds such a claim unchanged records its `normHash`, so from then on a re-wrap of even a long claim is harmless.

This still isn't a truth check: a sentence can be edited into something false while the code matches. It makes edits to a bound claim visible and forces a re-verification, nothing more.

## What counts as a symbol

An anchor can bind to a **module-level function or class**, to a **member of a class**, and to a **class nested directly in a class body** (`Outer.Inner`, `Outer.Inner.method` — Django's `Model.Meta` is the common case). Anything declared *inside a function* — a helper, a local class, an inner arrow function — is local, not addressable, and never shadows a real symbol of the same name.

| Source | Becomes |
|---|---|
| `export function f()` / `def f()` | `f` |
| `export const f = () => …` / `const f = x => …` / `const f = function () {}` | `f` (a single parameter without parentheses counts as that parameter) |
| `class K { m() {} }` / `class K: def m(self)` | `K`, `K.m` |
| `class Outer: class Inner: def m(self)` | `Outer`, `Outer.Inner`, `Outer.Inner.m` |
| a function or class declared inside a function | nothing |
| a decorated Python function | `f`, once, with its decorators in `sig` |

TypeScript has an `export` modifier, which is part of `sig`; Python doesn't, so a Python function is never "exported" and a whole-file `sig` binding on a `.py` file sees no exports.

## How normalization actually works (v0.1)

The `body` tier walks the AST of the symbol's implementation and serializes it recursively: every node becomes `(type child child …)`, comments are dropped entirely, and identifiers that were declared as parameters or local variables (`let`/`const`/`var` in TS/JS, assignment targets and `for` loop targets in Python) are replaced with positional aliases (`$1`, `$2`, …) in first-seen order. Everything else — operators, keywords, string and number literal contents, calls to things declared outside the symbol — is kept as-is. This means:

- Reformatting (whitespace, line breaks, indentation) never changes the hash, because the serializer only ever touches actual token text and type, never raw byte ranges.
- Renaming a local variable never changes the hash, because it's aliased away.
- Renaming the *symbol itself*, or changing what it calls, or changing a string literal it returns — all real behavior-adjacent changes — do change the hash, which is correct.

## Limitations (read before relying on this in production)

Being direct about what v0.1 does not do, because a tool that hides its own edges is worse than one that states them:

- **Local-variable scope isn't real scope analysis.** Every declared name in the symbol's subtree is aliased, regardless of nested-function shadowing. A same-named local in an inner closure is treated identically to the outer one. This is a documented approximation, not a bug to report.
- **Statement reordering is not normalized.** Moving two independent statements past each other inside a function body changes the AST structure and will register as a `body` drift, even when it provably doesn't change behavior. True reorder-invariance needs dependency analysis beyond what v0.1 does.
- **Same-file rename detection only.** If a symbol is renamed within the same file, `check` looks for exactly one other symbol in that file whose signature matches once the name is ignored (and which no other anchor already binds) and auto-relinks (`anchor.relocated`, counted in `summary.relocated`). Only `sig` is re-stamped: if the rename came with a change to another bound tier, the anchor is reported `drifted` under its new name rather than silently accepted. If the symbol moved to a *different* file, lockwire reports `orphaned`, not `relocated` — a repo-wide symbol index for cross-file matching is a P1 item, not P0.
- **No cross-language `deps` resolution.** A TypeScript file calling into a Python service (or vice versa) can't be tracked as a dependency; `deps` only sees references resolvable within the same parsed file.
- **`with ... as` bindings in Python aren't tracked as locals.** A narrow, known gap in the local-declaration collector.
- **No semantic-claim extraction.** lockwire never reads a claim's *meaning* — only whether the fingerprint of its bound target moved. "We use Redux" staying true when the code has moved to Zustand, with every file path still resolving, is invisible to lockwire by design; that's a job for an LLM-reasoning layer like [ClaudeDrift](https://github.com/marky291/claude-drift), not a hash.

None of these are silent. `lockwire check`'s noise metric and the ledger both make the tool's own behavior auditable, and a false relocate, false orphan, or missed drift is exactly the kind of thing that metric is meant to surface over time.

## Why not just hash the whole symbol?

Because that's the design every predecessor shipped, and it's the reason those tools get switched off. Hash the whole function, and a docstring claiming something about the *signature* re-flags on every internal refactor. Teams get flooded with false staleness, the CI gate gets marked `continue-on-error`, and the tool stops being trusted. Tiering is the fix: a claim only re-checks the aspect it actually depends on.
