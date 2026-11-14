#!/usr/bin/env bash
# Stage B (ship): merge main in and bounded CI repair, for a PR that conflicts with main or is not green.
# It never merges. The repaired head is new code, so it goes back through review and scripts/merge-ticket.sh.
# (Until 2026-11-09 the agent here also merged, with no review of what it had changed.)
# Usage: scripts/ship-ticket.sh <issue>
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"
ROOT="$(git rev-parse --show-toplevel)"
N="${1:?usage: scripts/ship-ticket.sh <issue>}"
WT="${WT:-$(dirname "$ROOT")/E-commerce-worktrees/ticket-$N}"
[ -d "$WT" ] || { echo "No worktree for ticket $N"; exit 1; }
LOG="$ROOT/.builder/logs/ship-$N-$(date +%Y%m%d-%H%M%S).json"
cd "$WT"

PROMPT="/supermatt:ship-pr for issue #$N, merge main in and repair only.
First run git merge --no-edit origin/main on this branch, resolve any conflicts and commit the merge. Never rebase and never force-push, whatever the skill says: push with a plain git push. If the merge changed anything, re-run the affected QA and tests. Then push, run scripts/ci-local.sh (the CI gate is its local-ci commit status), and repair failures within ship-pr's bounds. Do not wait for GitHub Actions; it runs only on PRs that carry the run-ci label.
DO NOT MERGE and do not close the issue, whatever the skill says: stop once the merged branch is pushed and local-ci is green on it, or once the repair bounds are used up. An independent reviewer reviews the result before the coordinator merges. Never push to main directly and never use --no-verify. Run headless: never ask the user."

. "$ROOT/scripts/agent-cli.sh"
. "$ROOT/scripts/review-watch.sh"
export REAL_GH; REAL_GH="$(command -v gh)"
PATH="$ROOT/scripts/ship-guard:$PATH" WATCH_WHAT="ship session" run_capped "${SHIP_TIMEOUT_MIN:-45}" agent_run ship "$LOG" "$PROMPT" || status=$?
[ "${status:-0}" != 124 ] || echo "Ship session for #$N was stopped at its ${SHIP_TIMEOUT_MIN:-45}-minute cap."
PR="${SHIP_PR:-$(gh pr list -R "$REPO" --state all --search "head:ticket-$N-" --json number --jq '.[0].number // empty')}"
# The guard stops the usual ways to merge. This catches any other way a session could land the PR.
if [ -n "$PR" ] && [ "$(gh api "repos/$REPO/pulls/$PR" --jq .merged)" = true ]; then
  echo "ERROR: the ship session for #$N merged PR #$PR without a review. Tell the owner."
  exit 6
fi
echo "Ship finished (exit ${status:-0}). PR: ${PR:-none}. Log: $LOG"
exit "${status:-0}"
