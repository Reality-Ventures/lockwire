# CLI reference

Every command resolves the repo root by walking up from the current directory to the **nearest** folder that contains a `lockwire.lock` or a `.git`, falling back to the current directory. Nearest wins on purpose: a stray `lockwire.lock` in some parent folder (an old experiment, a workspace root) must not capture a new project that has its own `.git` beneath it, and a vendored or nested repository keeps its own root.

## `lockwire init`

Creates `lockwire.lock` (empty), `.lockwire/config.json` (defaults), and appends `.lockwire/ledger.jsonl merge=union` to `.gitattributes` (creating it if needed). Safe to re-run — it never overwrites an existing lockfile.

```bash
lockwire init
```

## `lockwire link <doc.md>`

Scans `<doc.md>` for `<!-- lockwire <target> [tiers] [id=<id>] -->` markers, resolves each target's fingerprints, and creates or refreshes the corresponding anchor.

- A marker with no `id=` is a **new** claim: an anchor is created, and the marker line in the doc is rewritten in place to add `id=<new-id>`.
- A marker with an `id=` **refreshes** an existing anchor's fingerprints to the current code state.
- Refreshing an anchor that is currently `drifted` requires `--reviewed` — this is the relink gate, so a stale claim can't be silently re-stamped by an automated pass without a human or agent explicitly saying "I looked at this."
  The gate applies to an anchor that is `drifted`, or `orphaned` and whose symbol has come back changed. It doesn't apply when the code still matches and only the claim sentence moved, so editing a sentence or restoring a deleted marker over unchanged code re-links freely.
- If `check` relocated the anchor to a renamed symbol, the marker still names the old one. `link` follows the anchor, rewrites the marker to the new name (keeping its tiers and id), and records the retarget in the ledger. `check` prints a note when this is pending.

```bash
lockwire link CLAUDE.md
lockwire link CLAUDE.md --reviewed
```

### `lockwire link [--reviewed]` (no doc)

Links every doc the config selects — [`docs` and `exclude`](#configuration-lockwireconfigjson) — that contains at least one marker, and prints one line per doc plus a total. Docs without markers are never read for writing, so they are left byte-for-byte alone, and a marker inside a fenced code block is an example, not a binding. Naming a doc explicitly ignores `docs`/`exclude`.

```bash
lockwire link
lockwire link --reviewed
```

### `lockwire link <doc.md> <target> [--tiers a,b]`

Creates a **lockfile-only** anchor: a whole-doc-to-code binding with no inline marker, for the case where you want a doc bound to a file without annotating a specific paragraph. `target` is `path` or `path#Symbol`. Defaults: `sig` for a symbol target, `path,body` for a file target.

```bash
lockwire link docs/auth.md src/auth/session.ts#createSession --tiers sig,deps
```

## `lockwire check [paths…] [--changed | --staged] [--base <ref>] [--no-write] [--fail-on-unlinked] [--format text|json|github]`

Recomputes fingerprints for every anchor, compares against the stored value for each bound tier, updates `lockwire.lock`, appends ledger events for any status transition, and prints a report. Exits `1` if any examined anchor is `drifted` or `orphaned`, `0` otherwise.

Scoping — anchors outside the scope aren't examined, aren't reported, and can't fail the run:

- `paths…` — anchors whose target **or doc** is one of these paths. Paths resolve against your cwd.
- `--changed` — anchors on files this branch touched: everything that differs from the merge base with the base branch (committed, uncommitted and untracked). Both sides of a rename count, so a moved file orphans its anchors. A doc edit counts too, which is how a rewritten claim gets caught. The base is `--base <ref>`, else `origin/$GITHUB_BASE_REF` in a pull-request job, else `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`. If none exists, `check` stops and says so instead of guessing.
- `--staged` — only what's staged for the next commit (for a pre-commit hook).

**Unlinked markers.** A marker only protects a claim once `lockwire link` has turned it into an anchor. `check` also reads the docs the config selects (a scoped run reads only the docs in its scope) and lists any marker that no anchor backs: one with no `id=`, an `id=` that matches no anchor, an id that really belongs to the marker in another doc (a copy-paste), or an id used twice in one doc. They are a warning, shown under "Unlinked markers" and counted in the summary line, and they don't change the exit code — unless you pass `--fail-on-unlinked`, which makes them fail the run (and turns the `github` format's `::warning` into `::error`).

```
Unlinked markers (no anchor backs them, so these claims are not being checked):
  CLAUDE.md:12  src/auth/session.ts#createSession  not linked yet
Run `lockwire link CLAUDE.md` to link them.
```

`--no-write` is a dry run: same report and exit code, but `lockwire.lock` and the ledger are left exactly as they were. Use it in CI and pre-commit so a gate never dirties the working tree.

```bash
lockwire check
lockwire check src/auth/session.ts
lockwire check --changed --no-write         # CI / before pushing
lockwire check --staged --no-write          # pre-commit
lockwire check --changed --base origin/dev
lockwire check --format json
lockwire check --format github    # ::error annotations for GitHub Actions
```

In CI, `--changed` needs history to find the merge base: use `actions/checkout` with `fetch-depth: 0`.

The text report ends with the noise line:

```
single-hash would flag 3 · lockwire flagged 1 · noise −66.7%
```

`singleHashWouldFlag` counts anchors where *any* of the four tiers changed, regardless of what's bound — an approximation of what a single-hash tool would report. `tieredFlagged` counts anchors where a *bound* tier changed. The gap between them is the false-positive reduction tiering buys you.

`claimChanged` is true when the claim sentence was edited (status `drifted`, `driftedTiers` empty) or its marker was removed (status `orphaned`). A path-scoped run lists only the anchors it examined, and `summary` counts only those. The JSON output follows schema `lockwire.check.v1`:

```json
{
  "schema": "lockwire.check.v1",
  "tool": { "name": "lockwire", "version": "0.1.0" },
  "repo": null,
  "checkedAt": "2026-09-25T10:00:00Z",
  "summary": {
    "anchors": 41, "fresh": 38, "drifted": 2, "relocated": 0, "orphaned": 1, "waived": 0, "superseded": 0,
    "unlinked": 1,
    "noise": { "singleHashWouldFlag": 14, "tieredFlagged": 3, "reductionPercent": 78.6 }
  },
  "anchors": [
    { "id": "k7q2m9xv", "doc": "CLAUDE.md", "line": 3, "target": "src/auth/session.ts#createSession",
      "status": "drifted", "driftedTiers": ["sig"], "claimChanged": false,
      "excerpt": "`createSession` takes a `UserId`…" }
  ],
  "unlinked": [
    { "doc": "CLAUDE.md", "line": 12, "target": "src/auth/session.ts#createSession", "reason": "not linked yet" }
  ]
}
```

## Configuration: `.lockwire/config.json`

`lockwire init` writes the defaults. Every key does something; a key that isn't listed here isn't read.

| Key | Default | Effect |
|---|---|---|
| `docs` | `["**/*.md"]` | Globs of the docs that `lockwire link` (with no argument) scans for markers. |
| `exclude` | `["node_modules/**", "dist/**", "**/CHANGELOG.md"]` | Globs that scan skips. `.git`, `node_modules` and `.lockwire` are always skipped. |
| `normalizeLocals` | `true` | Alias local variables in the `body` fingerprint, so renaming a local isn't drift. Changing it changes every `body` fingerprint, so re-link afterwards. |
| `hook.mode` | `"advisory"` | What the `PreToolUse` hook does: `advisory`, `ask` or `deny` — see [agents.md](agents.md#hook-modes). |
| `hook.maxClaimsInContext` | `8` | The most claims the hooks inject for one edit; the rest are summarised as "…and N more". |

## `lockwire status [--scope <glob>] [--json]`

Lists every anchor's current status. `--scope` filters by a glob matched against the target path or the doc path (e.g. `src/auth/**`).

## `lockwire refs <path>[#symbol]`

Reverse lookup: which claims cover this file or symbol.

```bash
lockwire refs src/auth/session.ts
lockwire refs src/auth/session.ts#createSession
```

## `lockwire history <anchor-id | path#symbol | doc.md>`

Prints the ledger timeline for an anchor, every anchor targeting a symbol, or every anchor bound to a doc — whichever the argument resolves to. See [docs/ledger.md](ledger.md) for the event vocabulary.

```bash
lockwire history k7q2m9xv
lockwire history src/auth/session.ts#createSession
lockwire history CLAUDE.md
```

## `lockwire ack <id> --resolution updated|superseded|false-positive [--note "..."]`

Records that drift was handled and logs an `anchor.acknowledged` event. `updated` and `false-positive` re-stamp the anchor to the current state — the code fingerprints **and** the claim sentence as it now reads in the doc, so an expected claim edit stops being flagged — and set status back to `fresh`. If the target no longer exists there is nothing to re-stamp, so they refuse and point you at `superseded` or `unlink`. `superseded` marks the anchor `superseded` (the claim no longer applies, and future `check` runs skip it) without touching fingerprints.

```bash
lockwire ack k7q2m9xv --resolution updated --note "doc rewritten to match the new signature"
```

## `lockwire waive <id> --reason "..." --expires <date>`

A time-boxed, logged waiver — sets status to `waived` and logs `waiver.granted`. `--expires` must be a real ISO date in the future (`2026-10-15`, or a full timestamp; a bare date means 00:00 UTC that day); anything else is rejected. `check` skips a waived anchor until the expiry passes. At that point the waiver is dropped, `waiver.expired` is logged, and the anchor is re-evaluated from the code like any other: fresh if nothing moved while it was waived, drifted (with the tiers that moved) if something did. There is no permanent suppression in lockwire; every waiver has an expiry, and a stored expiry that doesn't parse counts as already expired.

```bash
lockwire waive k7q2m9xv --reason "signature change ships with the v2 API next sprint" --expires 2026-10-15
```

## `lockwire unlink <id>`

Removes an anchor from `lockwire.lock` entirely. Use this when a claim itself is deleted from the doc, not when it's merely stale — for stale-but-still-relevant claims, prefer `ack --resolution superseded`, which keeps the history.

## `lockwire ledger verify`

Recomputes every ledger event's hash and reports any that don't match, plus a BLAKE3 root over the set of valid hashes (order-independent by design — see [docs/ledger.md](ledger.md)).

```bash
lockwire ledger verify
```

## `lockwire hook claude-pre|claude-post|codex-pre|codex-post`

Reads a hook payload as JSON on stdin, writes a hook response as JSON on stdout. Not meant to be run by hand — see [docs/agents.md](agents.md) for the exact payloads and how they're wired into `hooks/hooks.json`.

## `lockwire mcp`

Starts the MCP server over stdio. Not meant to be run by hand — see [docs/agents.md](agents.md#mcp-tools) for the tool list and how `.mcp.json` wires it in.
