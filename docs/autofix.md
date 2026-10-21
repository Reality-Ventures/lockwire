# Autofix: your agent fixes the docs, lockwire checks the fix

`lockwire autofix` runs the agent you already use — Claude Code or Codex, on your own API key — against lockwire's [work queue](agents.md#the-work-queue-your-agent-fixes-lockwire-checks), then checks what it did. lockwire supplies no model and never writes a sentence. Its jobs are the ones a generator can't do for itself:

1. **Decide whether there is anything to do.** If no claim is wrong, no agent is started, so a quiet day costs nothing.
2. **Tell the agent exactly what is wrong.** The agent gets the `fix-docs` instructions and lockwire's MCP server, which lists each broken claim with the code or value as stamped and as it is now.
3. **Check every fix.** `lockwire_resolve` refuses a fix that still doesn't hold, such as a number that still disagrees with its data or a marker pointing at nothing. After the agent stops, autofix re-checks every claim from scratch and reports what's still open.
4. **Refuse a run that went out of bounds.** If the agent changed anything that isn't documentation (code, data, config), the run is reported as `refused` and no pull request is opened.

### What the verdict is judged against

The agent can edit any file in the repository, lockwire's own files included. So autofix never judges a run by state the agent could have written. It takes snapshots before the agent starts and compares against those:

- **Which files are docs.** This comes from `lockwire.lock` and the config as they were before the run. Registering a code file as a "doc" doesn't make an edit to it in bounds.
- **`lockwire.lock`.** An anchor may change only where the ledger records lockwire changing it. Marking a claim superseded by hand, or adding an anchor by hand, is refused.
- **The ledger.** lockwire only appends to it. Every record added during the run must verify, so a line written by hand is refused, not reported as a fix.
- **Retired claims.** A claim retired during the run (superseded or waived) whose sentence is still in the doc stays open. That holds whether its marker is still there or was deleted. A wrong number that's merely no longer tracked is still wrong.
- **Git.**
  - A run that moved `HEAD` is refused, because the agent's commits would ride into the pull request.
  - So is a run that staged a non-doc file.
  - So is a run that changed `.git/config`, a hook, or `.git/info`.
- **Every file, whatever its size,** plus `.lockwire/config.json`. lockwire's cache, lock and hook log are the only things left out.

When the agent finishes or times out, everything it started is stopped before lockwire looks. A timeout sends SIGTERM and then SIGKILL to its whole process group. On Windows, the process tree is killed. A background job the agent left behind is stopped too.

These checks catch an agent that edits lockwire's state by hand to make a claim look fixed. They are not a sandbox. The ledger's hashes aren't signed, so an agent determined to forge a valid record could. The pull request's diff, `lockwire.lock` and the ledger included, is still what a reviewer reads.

## In CI: the GitHub Action

```yaml
name: lockwire autofix
on:
  push:
    branches: [main]          # after merges
  schedule:
    - cron: "0 6 * * 1-5"     # and a weekday morning sweep
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  autofix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Reality-Ventures/lockwire/autofix@v0
        with:
          agent: claude-code                      # or: codex
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # openai-api-key: ${{ secrets.OPENAI_API_KEY }}   # for codex
```

The Action installs lockwire and the agent's CLI and runs `lockwire autofix`. If the run fixed something, it commits **only** the changed docs plus `lockwire.lock` and the ledger to the `lockwire/autofix` branch (`git commit --only`, so nothing else that was staged rides along, with git hooks and fsmonitor off), then opens a pull request whose body lists each claim, what it's bound to and what the agent did. A re-run updates the same pull request. The job summary shows the same report. A refused run fails the job.

Inputs:
- **`agent`:** `claude-code` or `codex`.
- **`anthropic-api-key` / `openai-api-key`:** the key for that agent.
- **`paths`:** limit the work to these paths, space-separated.
- **`changed`:** `true` to fix only claims on files changed since `base`.
- **`base`:** the pull request's base branch.
- **`branch`:** the branch autofix pushes to.
- **`max-turns`:** a turn budget for the agent.
- **`lockwire-version`:** which lockwire to install.
- **`github-token`:** the token used to push and open the pull request.

Outputs: `status` and `pull-request`.

For the default `GITHUB_TOKEN` to open pull requests, enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**, or pass a token with `contents: write` and `pull-requests: write` as `github-token`.

## Locally

```bash
lockwire autofix                       # Claude Code, every claim
lockwire autofix --agent codex docs/   # Codex, claims about or in docs/
lockwire autofix --changed --dry-run   # what it would run, on what
```

Exit codes: `0` means fixed, or nothing to do; `1` means some claims are still open; `2` means refused. `--summary <file>` writes the pull-request body, and `--json` prints the whole report: `status`, the tasks `before` and `after`, how many were `fixed`, each `resolution`, the `changedFiles`, the `outOfBounds` ones, and the `problems` that refused the run. The agent's own output goes to stderr.

Any other agent works through `--agent-command "<command>"`. It runs in the repository root with three environment variables:
- `LOCKWIRE_PROMPT_FILE`: the instructions.
- `LOCKWIRE_MCP_CONFIG`: a standard `{"mcpServers": {"lockwire": {...}}}` file.
- `LOCKWIRE_REPO`: the repository root.

lockwire's own tests drive autofix this way, with a scripted agent that talks to the real MCP server over stdio.

## What runs, exactly

| Agent | Command |
|---|---|
| Claude Code | `claude -p <prompt> [--bare] --mcp-config <file> --strict-mcp-config --allowedTools mcp__lockwire__* Read Edit Write Glob Grep --permission-mode acceptEdits --max-turns 40 --output-format json` |
| Codex | `codex exec --sandbox workspace-write --skip-git-repo-check <prompt>`, with `CODEX_HOME` pointing at a temporary `config.toml` that declares lockwire's MCP server (`required = true`). If you have a login, your `auth.json` is copied into it; in CI, `CODEX_API_KEY` is used instead. |

`--bare` is added when `CI` is set. Without it, Claude Code would run the repository's own `.claude/settings.json` hooks and `.mcp.json` servers, which is repository-controlled code, with your API key in the environment. Locally it's left off, because it also disables a subscription login.

## Security

- **Run it only on trusted triggers.** Use pushes to your own branches, a schedule, or a manual dispatch. Never run it on `pull_request_target` from forks. The agent reads repository content, and that content can contain text written to look like instructions.
- **Claude Code gets no shell.** Its tool list is lockwire's MCP tools plus file read and edit, with no `Bash`, so it can't run the repository's code. Codex's sandbox allows commands inside the workspace. If that's a concern, prefer Claude Code, or run Codex through `openai/codex-action`, which keeps the key out of later steps.
- **Each key reaches one step.** The Action passes an API key only to the step that runs the agent, and passes every input to scripts through `env:`, never into the script text.
- **No out-of-bounds fixes.** A run that changed anything other than docs is refused and opens no pull request, and files it flagged are never committed. See [what the verdict is judged against](#what-the-verdict-is-judged-against).

## What has and hasn't been verified

- **Verified by the test suite:**
  - The loop runs end to end with a scripted agent over real MCP stdio, through `lockwire autofix`.
  - `open-pr.sh` was run against real git with a bare remote and a fake `gh`: it commits only the right files and opens or updates one pull request.
  - The Action's YAML is linted so no input is interpolated into a script.
  - Each safety check is pinned by a test that fails without it.
- **Not run here:** a live Claude Code or Codex session, and a live run of the Action on GitHub. The flags are taken from each tool's documentation (Claude Code's `-p`, `--mcp-config`, `--allowedTools`, `--permission-mode`, `--bare`; Codex's `exec --sandbox workspace-write` and `[mcp_servers]` config). If a flag has changed, `lockwire autofix --dry-run` shows the exact command. A custom `--agent-command` is the escape hatch.
