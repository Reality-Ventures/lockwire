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

## The tiers

| Tier | What it hashes | Changes when | Doesn't change when |
|---|---|---|---|
| `path` | The repo-relative file path | The file moves or is renamed | Anything inside the file |
| `sig` | Symbol kind, name, parameter names and type annotations, return type, modifiers (`export`/`async`/decorators) | The contract changes | Body edits, refactors, reformatting |
| `body` | A normalized AST of the implementation — comments stripped, local identifiers alpha-renamed | Real behavior changes | Reformatting, renaming a local variable |
| `deps` | A sorted set of outbound calls and referenced imports | A dependency is added, removed, or swapped | Reordering calls, unrelated body edits |
| `value` | A value in a data file (a JSON key, a LaTeX macro) — see [below](#numbers-and-other-values) | The value changes **and** the sentence no longer states it | The file is re-serialised or reordered; the value moves within the precision the sentence shows |

A whole-file anchor (no `#Symbol`) binds `path` and `body` by default; a symbol anchor binds `sig` by default. Most prose only needs `sig` — that's the entire point. A doc claiming "takes a `UserId`, returns a `Session`" cares about the contract, not the implementation, and binding `sig` makes it immune to every refactor that doesn't touch the contract.

## Numbers and other values

Most of what goes stale in a research repo, a benchmark README or an ops runbook isn't a function signature — it's a number: "the lower bound is 0.18", "p99 latency is 40 ms", "we evaluate on 1,024 samples". Those numbers usually come from a file the code writes. A value anchor binds the sentence to that file:

```markdown
<!-- lockwire results/metrics.json#ci.canon.cve.lo -->
The lower bound of the canonical CVE interval is 0.18.

<!-- lockwire paper/numbers.tex#ciCanonCVELo -->
The paper reports a lower bound of 0.18.
```

- **Where the value comes from.** A JSON key (`a.b.c`, `runs[0].score`, or a JSON Pointer `/a.b/c` when a key contains dots), or a LaTeX macro defined with `\newcommand`, `\renewcommand`, `\providecommand` or `\def` — the usual way a pipeline hands numbers to a paper. Commented-out definitions (`% \renewcommand…`) don't count; a later definition replaces an earlier one, except `\providecommand`, which never replaces one; a definition left unterminated at the end of the file defines nothing. Common wrappers are unwrapped, in any combination: `\num{0.18}`, `\SI{12.5}{ms}`, `$0.18$`, `91.2\%`, `\num{91.2}\%`, `12{,}345`.
- **What is fingerprinted.** The value itself, so a pipeline that re-serialises the file or emits its keys in a different order changes nothing. A whole-file anchor on a JSON file (`results/metrics.json`, no key) is key-order-insensitive for the same reason.
- **What is checked.** Unlike any other claim, a number can be checked for *truth*: `check` compares the numbers in the sentence with the current value at the precision the sentence shows. "0.18" holds for 0.1834 and for 0.1791, and not for 0.1912; "18%" holds for 0.18; "0.183" is stricter than "0.18". So a rerun that moves the value within the stated precision is **not** drift — the sentence is still true — and one that moves it past it is flagged with both numbers: `(claim says 0.18, value is 0.1912 (was 0.1834))`. A string value (a model name, a mode) is checked by whether the sentence contains it.
- **How a sentence's numbers are read.** A unit glued to a number doesn't hide it (`12.5ms` states 12.5, `40ms` states 40, `0.18x` states 0.18). A magnitude suffix scales it, and the precision is kept in those units: `1.2B` (also `k`, `M`, `bn`, `T`, and the words thousand to trillion) holds for 1.24 billion and not for 1.26 billion. Scientific notation commits to its mantissa: `1.5e3` holds for 1523, not 1600. A hyphen or LaTeX `--` between two numbers is a range (`0.18-0.24`, `15--29`); a minus is a sign only after a space or an opening bracket (`a −0.5 shift`, `(-3)`). Digits inside identifiers (`v2`, `x86`, `0.18_lo`, `0x1F`), version strings (`1.2.3`) and ordinals (`2nd`) state nothing. A count is held to the unit however large: `5,000,000,000` doesn't hold for 5,000,000,004.
- **Values that hold several numbers.** A generated macro often packs a statistic and its interval into one string — `\newcommand{\CIDevRelevant}{21\%; 95\% CI 15--29\%}`. Such a value holds when the sentence states *every* number in it ("21% (95% CI 15–29%)" does; "22% (95% CI 15–29%)" and "21%" alone don't), each compared at the coarser of the two precisions, since the generated value is itself rounded. A sentence that states no numbers can't be checked against it and falls back to plain drift; a string with no numbers in it at all is checked by containment.
- **Stamping.** `link` refuses to bind a sentence that already states a different value, because that would record a false claim as the baseline. `ack` re-stamps the stored value but can't make a wrong sentence right; fix the sentence, or `waive` it with an expiry.
- **When there's nothing to compare.** A sentence that states no number ("the bound comes from the canonical run"), a lockfile-only anchor, or a value that isn't a number or string falls back to plain fingerprint drift: any change to the value flags it.

One sentence, one value per marker: a sentence passes if *any* number in it matches, so a range like "0.18–0.24" needs two stacked markers, one per bound, to check both.

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
- **No semantic-claim extraction.** lockwire never reads a claim's *meaning* — only whether the fingerprint of its bound target moved. "We use Redux" staying true when the code has moved to Zustand, with every file path still resolving, is invisible to lockwire by design; that's a job for an LLM-reasoning layer like [ClaudeDrift](https://github.com/marky291/claude-drift), not a hash. The one exception is a number or string bound to the value it came from (a [value anchor](#numbers-and-other-values)), which `check` compares with the sentence directly.

None of these are silent. `lockwire check`'s noise metric and the ledger both make the tool's own behavior auditable, and a false relocate, false orphan, or missed drift is exactly the kind of thing that metric is meant to surface over time.

## Why not just hash the whole symbol?

Because that's the design every predecessor shipped, and it's the reason those tools get switched off. Hash the whole function, and a docstring claiming something about the *signature* re-flags on every internal refactor. Teams get flooded with false staleness, the CI gate gets marked `continue-on-error`, and the tool stops being trusted. Tiering is the fix: a claim only re-checks the aspect it actually depends on.
