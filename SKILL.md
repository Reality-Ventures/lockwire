---
name: lockwire
description: Use when editing code that CLAUDE.md, AGENTS.md, or a docs/*.md file makes claims about, or when asked to check, link, or fix documentation drift. Binds a documentation claim to a tiered fingerprint (path/signature/body/dependencies) of the code it describes, so an edit that changes what the doc asserts is caught at write time instead of silently.
---

# lockwire

Installed via `npx skills add Reality-Ventures/lockwire` — this copy is agent-agnostic. If you're inside Claude Code, prefer the full plugin (`/plugin marketplace add Reality-Ventures/lockwire`), which also wires up the write-time hook and MCP server automatically.

## What this does

`lockwire.lock` in this repo (if present) binds sentences in `CLAUDE.md`/`AGENTS.md`/`docs/**/*.md` to fingerprints of the code they describe. A fingerprint is computed per **tier** — `path`, `sig` (signature), `body`, `deps` — so a claim bound to `sig` survives a body refactor untouched, and only flags when the actual contract it asserts changes.

## Before editing code

Run `lockwire check` (or `npx lockwire check` if not installed globally) to see what documentation currently asserts about this repo. If you're about to touch a file, run `lockwire refs <path>` to see which doc claims cover it — read them before you change behavior they describe.

## After editing code

Run `lockwire check` again. If it reports `DRIFTED` anchors touching files you just changed:

1. Update the doc claim to match the new reality.
2. Run `lockwire link <doc> --reviewed` to re-stamp it (required specifically because the anchor is currently `drifted` — this gate exists so a doc can't be silently re-stamped without someone looking).
3. If the claim no longer applies, run `lockwire ack <id> --resolution superseded` instead.

## Adding a new claim

```markdown
<!-- lockwire src/auth/session.ts#createSession sig -->
`createSession` takes a `UserId` and returns a `Session` valid for 24 hours.
```

Then `lockwire link CLAUDE.md` to stamp it.

## Wiring up your agent's own hook and MCP server

This skill covers usage; wiring lockwire into your specific agent's write-time hook (Codex, Cursor, etc.) is agent-specific — see [docs/agents.md](docs/agents.md) in the repo, or run `lockwire hook codex-pre`/`lockwire mcp` directly per your agent's hook/MCP config format.

## Full reference

[docs/cli.md](docs/cli.md) · [docs/concepts.md](docs/concepts.md) · [docs/agents.md](docs/agents.md)
