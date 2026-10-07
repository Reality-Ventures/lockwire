# Agent integration

How lockwire wires into Claude Code, Codex, other agents via skills, and MCP.

## Claude Code plugin

`/plugin install lockwire@lockwire` installs three things at once, declared in [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json):

- [`hooks/hooks.json`](../hooks/hooks.json) — a `PreToolUse` and `PostToolUse` hook, both matching `Edit|Write`, each running `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js hook claude-pre|claude-post`
- [`.mcp.json`](../.mcp.json) — the `lockwire` MCP server, run the same way
- [`skills/lockwire/SKILL.md`](../skills/lockwire/SKILL.md) — usage guidance loaded when the agent is working with docs

### What the hook actually does

**`PreToolUse`** (before an `Edit` or `Write` lands): normalizes the touched file's path, looks up every anchor targeting it, and — if any exist — injects them as `additionalContext`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "lockwire: documentation makes claims about this code:\n- CLAUDE.md asserts \"`createSession` takes a `UserId`…\" about src/auth/session.ts#createSession [tiers: sig]\nIf this edit changes what any of these claims assert, update the doc and run `lockwire link <doc>`."
  }
}
```

**`PostToolUse`** (after the edit lands): re-fingerprints the touched file, diffs against the stored anchors, and — if any bound tier moved — reports it:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "lockwire: this edit drifted documentation claims:\n- CLAUDE.md on src/auth/session.ts#createSession is now drifted (sig)\nUpdate the doc and run `lockwire link <doc>`, or `lockwire ack`/`lockwire waive` if this is expected."
  }
}
```

No anchors touch the file → both hooks emit nothing and exit `0`. This is the common case; the hook is silent almost all the time.

### Hook modes

Set in `.lockwire/config.json`'s `hook.mode`:

| Mode | PreToolUse behavior |
|---|---|
| `advisory` (default) | Injects context only. Never blocks, never prompts. |
| `ask` | Injects context and sets `permissionDecision: "ask"` — Claude Code prompts the user to confirm. |
| `deny` | Injects context and sets `permissionDecision: "deny"` — blocks until the claim is acknowledged. |

Start with `advisory`. A tool that blocks on day one gets uninstalled on day one; `deny` is for a team that has already lived with `advisory` and wants a stricter gate for a specific repo.

### Fail-open, by contract

Every hook handler is wrapped in a try/catch. Any exception — a malformed lockfile, an unparseable file, a permissions error — is written to `.lockwire/hook.log` and the hook exits `0` with no output. **A broken hook can never break a tool call.** This is tested behavior, not a hope: [`test/hook-failopen.test.ts`](../test/hook-failopen.test.ts) runs all four adapters against a corrupt lockfile, a merge-conflicted lockfile, a corrupt `config.json` and malformed stdin, and asserts exit `0`, no output, and the error in `hook.log`. The mechanism is [`src/hook-common.ts`](../src/hook-common.ts)'s `logHookError` and both adapters' outer try/catch.

## Codex

Same two events, via `lockwire hook codex-pre|codex-post`, wired into `~/.codex/hooks.json` or `config.toml`:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "apply_patch", "hooks": [{ "type": "command", "command": "node", "args": ["<path-to-lockwire>/dist/cli.js", "hook", "codex-pre"] }] }],
    "PostToolUse": [{ "matcher": "apply_patch", "hooks": [{ "type": "command", "command": "node", "args": ["<path-to-lockwire>/dist/cli.js", "hook", "codex-post"] }] }]
  }
}
```

Codex delivers file edits as `apply_patch` calls with the patch body in `tool_input.command`; the adapter extracts the touched file path from the patch header and doesn't need to understand the patch body itself.

**A verified caveat, stated plainly.** `apply_patch` hook *emission* was broken in Codex before 0.123.0 (fixed [2026-04-23](https://github.com/openai/codex/issues/16732)) — if you're on an older Codex, upgrade. Separately, `deny` *enforcement* has had scattered, version- and platform-dependent gaps that are still being reported as of September 2026 ([openai/codex#27833](https://github.com/openai/codex/issues/27833), open). This is why lockwire defaults to `advisory` everywhere: advisory mode only needs a hook to *fire*, which is solid on any current Codex. If you set `hook.mode: "deny"` on Codex, treat it as best-effort until that issue closes — `ask` degrades to advisory automatically, since Codex hooks can deny a call but can't rewrite its input to prompt the way Claude Code does.

## Other agents, via `SKILL.md`

Any agent that reads `npx skills add`-style skills (Cursor, Gemini CLI, OpenCode, Windsurf, and others) picks up the root [`SKILL.md`](../SKILL.md), which teaches the agent to run `lockwire check`/`lockwire refs`/`lockwire link` directly rather than relying on a write-time hook. Wiring an actual `PreToolUse`-equivalent hook for a specific agent is that agent's own hook configuration format — point it at `lockwire hook claude-pre` (the payload shape is the more common one) or write a thin adapter; the core logic in [`src/hook-common.ts`](../src/hook-common.ts) is agent-agnostic and the two existing adapters are ~30 lines each.

## MCP tools

`lockwire mcp` starts a stdio MCP server exposing:

| Tool | Arguments | Purpose |
|---|---|---|
| `lockwire_claims_for` | `path`, `symbol?` | What does documentation assert about this code? Call before editing. |
| `lockwire_refs` | `path`, `symbol?` | Reverse lookup — which claims reference this code. |
| `lockwire_status` | `scope?` | Current status of every anchor, optionally glob-filtered. |
| `lockwire_verify` | `doc` | Check one document's anchors before committing it. |
| `lockwire_history` | `ref` | Ledger timeline for an anchor id, a `path#symbol`, or a doc — the query nothing else in this space has. |
| `lockwire_link` | `doc`, `reviewed?` | Scan a doc for markers and stamp fresh fingerprints. |
| `lockwire_ack` | `anchor`, `resolution`, `note?` | Record that drift was handled. |
| `lockwire_waive` | `anchor`, `reason`, `expires` | Time-boxed, logged, expiring waiver. |

`lockwire_history` is the one query that doesn't exist anywhere else in the documentation-drift space — see [docs/comparison.md](comparison.md). Every other tool we found answers "is this doc stale right now"; none answer "this claim has broken four times, here's each commit and each actor."
