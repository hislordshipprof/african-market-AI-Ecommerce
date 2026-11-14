#!/usr/bin/env bash
# Full local-ci on the tip of main. Hosted CI is off, so without this nothing runs the whole suite after a merge,
# and lighter runs on tickets (scripts/ci-scope.sh) have no safety net. merge-ticket.sh starts it every
# CI_MAIN_EVERY merges (default 3). It waits in the machine-wide local-ci queue like any other run.
# Usage: scripts/ci-main.sh
# A failure opens one bug issue. .builder/ci-main-last holds the last commit a full run was started for: it is
# written up front, so merges made while this run waits in the queue don't each start another.
set -uo pipefail
{
REPO="hislordshipprof/african-market-AI-Ecommerce"
ROOT="$(git rev-parse --show-toplevel)"
LOG="$ROOT/.builder/logs/ci-main-$(date +%Y%m%d-%H%M%S).log"
git -C "$ROOT" fetch -q origin main || { echo "ci-main SETUP: fetch failed"; exit 1; }
SHA=$(git -C "$ROOT" rev-parse origin/main)
# A worktree of its own for each run, so two runs can never test each other's commit.
WT="$(dirname "$ROOT")/E-commerce-worktrees/main-ci-$$"
git -C "$ROOT" worktree add -q --detach "$WT" "$SHA" || { echo "ci-main SETUP: no worktree at $SHA"; exit 1; }
trap 'git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null || true' EXIT
echo "$SHA" > "$ROOT/.builder/ci-main-last"
cp "$ROOT/.env.local" "$WT/.env.local"
cd "$WT" || exit 1
# CI_MAIN_LAST_FILE: ci-local.sh reads it once it holds the lock. If a later ci-main.sh has written a newer commit
# there by then, this run stops without running the suite, so main runs no longer pile up in the queue.
# The exit status, not the log, says it was skipped: a failing test's output can contain the word.
. "$ROOT/scripts/ci-scope.sh"
rc=0
CI_SCOPE=full CI_DB=main E2E_PORT="${CI_MAIN_PORT:-3400}" CI_RUNNER="$(dirname "$ROOT")/E-commerce-worktrees/ci-runner" \
  CI_MAIN_LAST_FILE="$ROOT/.builder/ci-main-last" bash "$ROOT/scripts/ci-local.sh" > "$LOG" 2>&1 || rc=$?
if [ "$rc" = 0 ]; then
  echo "ci-main PASSED on $SHA"
  exit 0
fi
if [ "$rc" = "$CI_SUPERSEDED" ]; then
  echo "ci-main skipped $SHA: a newer run on main is queued"
  exit 0
fi
echo "ci-main FAILED on $SHA. Log: $LOG"
TITLE="main failed the full local-ci on ${SHA:0:7}"
if [ -z "$(gh issue list -R "$REPO" --state open --search "\"$TITLE\" in:title" --json number --jq '.[0].number // empty')" ]; then
  gh issue create -R "$REPO" --title "$TITLE" --label bug \
    --body "$(printf 'The full run on main failed. Log on the build machine: `%s`\n\n```\n%s\n```\n' "$LOG" "$(tail -30 "$LOG")")" >/dev/null || true
fi
exit 1
}
