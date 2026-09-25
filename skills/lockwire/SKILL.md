---
name: lockwire
description: Use when editing code that CLAUDE.md, AGENTS.md, or a docs/*.md file makes claims about, or when asked to check, link, or fix documentation drift. Binds a documentation claim to a tiered fingerprint (path/signature/body/dependencies) of the code it describes, so an edit that changes what the doc asserts is caught at write time instead of silently.
---

# lockwire

lockwire keeps `CLAUDE.md`, `AGENTS.md`, and `docs/**/*.md` claims true against the code they describe. It runs as a `PreToolUse`/`PostToolUse` hook automatically — you rarely need to invoke it directly — but when you do, these are the moves.

## Before writing a new claim about code

If you're about to add a sentence like "`createSession` takes a `UserId` and returns a `Session`", bind it:

```markdown
<!-- lockwire src/auth/session.ts#createSession sig -->
`createSession` takes a `UserId` and returns a `Session` valid for 24 hours.
```

Then run:

```bash
lockwire link CLAUDE.md
```

This stamps the marker with an id and the current fingerprint. Bind `sig` for a contract claim (signature, params, return type), `body` for a behavioral claim ("retries 3x with backoff"), `deps` for an architectural claim ("delegates to the KMS client"), or `path` for a structural claim ("lives in `src/auth/`"). Most prose only needs `sig` — see [docs/concepts.md](../../docs/concepts.md).

## When the hook tells you a claim covers code you're about to edit

The `additionalContext` you see before an edit lists which docs assert what about the code. Read it. If your edit changes the asserted behavior, update the doc claim after editing, then run `lockwire link <doc>` to re-stamp it. If the claim is still true, do nothing — the fingerprint won't have moved and nothing will flag.

## When the hook tells you a claim just drifted

After an edit, if `additionalContext` says a claim drifted:

1. Open the doc, update the claim text to match the new reality.
2. Run `lockwire link <doc> --reviewed` (the `--reviewed` flag is required to re-stamp an anchor that's currently `drifted` — this is the relink gate, so a doc can't be silently re-stamped without someone actually looking at it).
3. If the claim doesn't apply anymore, run `lockwire ack <id> --resolution superseded --note "..."` instead of rewriting it.
4. If this is a known, temporary, acceptable drift, run `lockwire waive <id> --reason "..." --expires YYYY-MM-DD` rather than ignoring it — waivers are logged and expire; silence is not an option lockwire gives you.

## Checking before you commit

```bash
lockwire check              # every anchor in the repo
lockwire check --changed    # only anchors covering files this branch touched
```

Exits non-zero if anything is `drifted` or `orphaned`.

## Answering "why is this like this"

```bash
lockwire history <anchor-id | path#symbol | doc.md>
```

Prints the ledger timeline: every time this claim broke, who broke it, and how it was resolved. This is the query nothing else in the doc-drift space answers — use it before assuming a stale-looking doc is a one-off.

## Full command and MCP tool reference

See [docs/cli.md](../../docs/cli.md) and [docs/agents.md](../../docs/agents.md).
