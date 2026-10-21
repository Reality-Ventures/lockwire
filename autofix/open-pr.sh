#!/usr/bin/env bash
# Commit what `lockwire autofix` changed to a branch and open (or update) one pull request for it.
#
#   LW_REPORT   the `lockwire autofix --json` report
#   LW_SUMMARY  the markdown summary (the pull request body)
#   LW_BRANCH   the branch to push (one per base: re-runs update the same pull request)
#   LW_BASE     the base branch (default: the branch that is checked out)
#   GH_TOKEN    for `gh`
#
# Only the files the report says changed, plus lockwire's own lockfile and ledger, are committed:
# never `git add -A`, and `commit --only`, so nothing else in the workspace (or already staged in the
# index) can ride along. Git runs with hooks and fsmonitor off: the agent could have written either.
set -euo pipefail

g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }

status=$(node -p 'require(process.env.LW_REPORT).status')
case "$status" in
  fixed | partial) ;;
  *) echo "lockwire autofix: $status, so no pull request"; exit 0 ;;
esac

files=()
while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < <(node -e '
  const r = require(process.env.LW_REPORT);
  for (const f of r.changedFiles) if (!r.outOfBounds.includes(f)) console.log(f);
')
for extra in lockwire.lock .lockwire/ledger.jsonl; do
  # changed or not tracked yet (a first run creates the ledger)
  if [ -e "$extra" ] && [ -n "$(g status --porcelain -- "$extra")" ]; then
    case " ${files[*]-} " in *" $extra "*) ;; *) files+=("$extra") ;; esac
  fi
done
if [ ${#files[@]} -eq 0 ]; then echo "lockwire autofix: nothing changed, so no pull request"; exit 0; fi

base="${LW_BASE:-$(g rev-parse --abbrev-ref HEAD)}"
fixed=$(node -p 'const r = require(process.env.LW_REPORT); r.fixed ?? Math.max(0, r.before.length - r.after.length)')
title="docs: lockwire autofix (${fixed} claim$([ "$fixed" = 1 ] || echo s))"

g check-ref-format --branch "$LW_BRANCH" >/dev/null
g checkout -q -B "$LW_BRANCH"
g add -- "${files[@]}"
g -c user.name="${LW_GIT_NAME:-lockwire-autofix[bot]}" -c user.email="${LW_GIT_EMAIL:-lockwire-autofix@users.noreply.github.com}" \
  commit -q --no-verify -m "$title" --only -- "${files[@]}"
g push -q --no-verify --force origin "$LW_BRANCH"

url=$(gh pr list --head "$LW_BRANCH" --base "$base" --state open --json url --jq '.[0].url // empty')
if [ -n "$url" ]; then
  gh pr edit "$url" --title "$title" --body-file "$LW_SUMMARY" >/dev/null
else
  url=$(gh pr create --head "$LW_BRANCH" --base "$base" --title "$title" --body-file "$LW_SUMMARY")
fi
echo "lockwire autofix: $url"
echo "pull-request=$url" >> "${GITHUB_OUTPUT:-/dev/null}"
