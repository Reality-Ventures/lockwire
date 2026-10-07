# The ledger

`.lockwire/ledger.jsonl` is an append-only, newline-delimited JSON log of every state change any anchor has ever gone through. It's what makes `lockwire history` possible, and it's the thing nothing else in the documentation-drift space has.

## Why an append-only log instead of just overwriting `lockwire.lock`

`lockwire.lock` tells you the *current* state of every anchor. It cannot tell you "this claim has broken four times in eight months — here is each commit, each actor, and each resolution," because overwriting a JSON field destroys the previous value. The ledger is that missing half: a git-for-documentation history keyed on a stable anchor id that survives renames.

## Event shape

```jsonc
{
  "v": 1,
  "id": "0M8X2FQJKL",
  "ts": "2026-09-25T14:12:03.656Z",
  "event": "anchor.drifted",
  "anchor": "k7q2m9xv",
  "tier": "sig",
  "from": "b3:91ccabc123…",
  "to": "b3:38ff456def…",
  "commit": "a71bd09",
  "actor": { "type": "ai", "tool": { "name": "claude-code" }, "session": "abc-123" },
  "hash": "b3:c42dabc987…"
}
```

### Who and which commit

- **`commit`** is the short SHA of `HEAD` when the event was recorded, or `null` outside a git repository or before the first commit. For a drift event that is the commit the working tree was based on, not the one that will eventually contain the change — `git blame` on the drifted lines answers that.
- **`actor`** is whoever ran the check that noticed. The `PostToolUse` hook runs right after an agent's edit, so for hook-detected drift that is the agent and its session (`claude-code` or `codex`); `lockwire check` from a shell records `human`, a CI job records `unknown` with tool `ci`, and a shell inside Claude Code or Codex records that agent. The MCP server records `mcp`. Events a caller doesn't attribute say `unknown` rather than guess. Neither field is proof of authorship — the ledger is tamper-evident, not a signed audit trail.

`hash` is BLAKE3 over the canonical JSON (sorted keys, no whitespace) of every other field. `lockwire ledger verify` recomputes it for every line and reports which lines, if any, don't match — see [`src/ledger.ts`](../src/ledger.ts).

<!-- lockwire src/ledger.ts#appendEvent sig id=g849y7xt -->
`appendEvent` takes the repo root and an event missing its `v`, `id`, and `hash` fields, computes those three (and fills in `commit` from `HEAD` when the caller passes `null`), appends the line, and returns the full record it wrote.

## Event vocabulary

`anchor.created` · `anchor.drifted` · `anchor.relocated` · `anchor.resolved` · `anchor.orphaned` · `anchor.acknowledged` · `waiver.granted` · `waiver.expired`

## No `prev`-hash chain, on purpose

An earlier draft of this design chained each event's hash to the previous one, the way a lot of tamper-evident logs work. That's the wrong shape for a file two branches can both append to. `git merge` on a chained log either conflicts or silently produces an invalid chain, because "previous" stops meaning anything once two branches both appended after the same base event.

lockwire's ledger merges with:

```
.lockwire/ledger.jsonl merge=union
```

in `.gitattributes` (written automatically by `lockwire init`), which tells git to use `git notes merge -s cat_sort_uniq`-style union-merge semantics: **both branches' new lines end up in the merged file, deduplicated, order not preserved.** For that to be safe, tamper-evidence has to be **order-independent** — so instead of a hash chain, `lockwire ledger verify` reports a root: `BLAKE3` over the **sorted set** of every valid event's own hash. Two ledgers holding the same events in a different order produce the same root; [`test/ledger.test.ts`](../test/ledger.test.ts) pins exactly this property. Ordering isn't lost — each event already carries its own `ts` and `commit`, which is what you actually want to sort by, not append order.

## Actors: adopting Agent Trace instead of inventing a format

Every ledger event's `actor` field is a [Agent Trace](https://agent-trace.dev/) (Cursor's open specification, v0.1.0 RFC, January 2026, backed by Cloudflare, Vercel, Google Jules, Amp, OpenCode, and git-ai) contributor object:

```ts
{ type: "human" | "ai" | "mixed" | "unknown", model_id?: "provider/model-name", tool?: { name, version }, session?: string }
```

Attribution for agent-made changes is a real, separately-hard problem, and Agent Trace already solved the "what shape should this be" question in a way multiple tools are converging on. lockwire reuses it rather than inventing a fifth incompatible actor format.

## Verifying

```bash
$ lockwire ledger verify
14 events · all hashes verify
root: b3:9f2a1c8d0e4b7f36a1c9e8d2f0b6a4c7
```

A mismatch means either a hand-edited ledger line or real corruption — either way, `ledger verify` names the exact line indices so you know what to look at.
