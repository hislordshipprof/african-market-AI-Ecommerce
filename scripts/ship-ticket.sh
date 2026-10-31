#!/usr/bin/env bash
# Stage B (ship): rebase on main, bounded CI repair, squash merge, close the issue.
# Run only after the coordinator's verification passed. See docs/agents/orchestration.md.
# Usage: scripts/ship-ticket.sh <issue> "<QA verdict line>"
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"
ROOT="$(git rev-parse --show-toplevel)"
N="${1:?usage: scripts/ship-ticket.sh <issue> \"<QA verdict>\"}"
VERDICT="${2:?QA verdict required}"
WT="$(dirname "$ROOT")/E-commerce-worktrees/ticket-$N"
[ -d "$WT" ] || { echo "No worktree for ticket $N"; exit 1; }
LOG="$ROOT/.builder/logs/ship-$N-$(date +%Y%m%d-%H%M%S).json"
cd "$WT"

PROMPT="/supermatt:ship-pr QA of this branch stands: $VERDICT
The coordinator has verified this PR and delegates the merge for issue #$N only. First rebase onto origin/main; if the rebase changed anything, re-run the affected QA and tests before pushing. Repair CI within ship-pr's bounds, then squash merge and confirm the issue is closed. Never push to main directly and never use --no-verify. Run headless: never ask the user."

claude -p "$PROMPT" --dangerously-skip-permissions --output-format json > "$LOG" 2>&1 || status=$?
PR=$(gh pr list -R "$REPO" --state all --search "head:ticket-$N-" --json number,state --jq '.[0] | "#\(.number) \(.state)"')
echo "Ship finished (exit ${status:-0}). PR: $PR. Log: $LOG"
exit "${status:-0}"
