#!/usr/bin/env bash
# Builds one GitHub issue with a headless Claude Code run in its own git worktree.
# Usage: scripts/build-ticket.sh <issue-number>
# Reads: docs/agents/builder.md (brief), .env.local (keys), scripts/ticket-env.txt (keys each ticket needs).
# Writes: .builder/logs/ticket-<n>-<time>.log and .builder/report-<n>.md
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"
ROOT="$(git rev-parse --show-toplevel)"
N="${1:?usage: scripts/build-ticket.sh <issue-number>}"

cd "$ROOT"
mkdir -p .builder/logs

# 1. Issue must be open and unblocked.
state=$(gh issue view "$N" -R "$REPO" --json state --jq .state)
[ "$state" = "OPEN" ] || { echo "Issue #$N is $state"; exit 1; }
blockers=$(gh api "repos/$REPO/issues/$N/dependencies/blocked_by" --jq '[.[] | select(.state=="open") | .number] | join(",")')
[ -z "$blockers" ] || { echo "Issue #$N is blocked by open issues: $blockers"; exit 1; }

# 2. Required keys for this ticket must be present in .env.local (values never printed).
need=$(awk -v n="$N" '$1==n {for (i=2;i<=NF;i++) print $i}' scripts/ticket-env.txt)
missing=()
for k in $need; do
  grep -Eq "^$k=.+" .env.local 2>/dev/null || missing+=("$k")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Ticket #$N needs these keys in .env.local first: ${missing[*]}"
  exit 2
fi

# 3. Fresh worktree from origin/main.
slug=$(gh issue view "$N" -R "$REPO" --json title --jq .title | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g' | cut -c1-40)
BRANCH="ticket-$N-$slug"
WT="$(dirname "$ROOT")/E-commerce-worktrees/ticket-$N"
git fetch -q origin main
if [ ! -d "$WT" ]; then
  git worktree add -q -B "$BRANCH" "$WT" origin/main
fi
cp .env.local "$WT/.env.local"

REPORT="$ROOT/.builder/report-$N.md"
LOG="$ROOT/.builder/logs/ticket-$N-$(date +%Y%m%d-%H%M%S).log"

PROMPT="You are the builder. Read docs/agents/builder.md and follow it exactly.
Build GitHub issue #$N in this worktree (branch $BRANCH). Repo: $REPO.
Write your final report to: $REPORT"

# 4. Headless run with full permissions (guardrails: own worktree, test keys only, main is protected, PR review before merge).
echo "Building #$N in $WT; log: $LOG"
cd "$WT"
claude -p "$PROMPT" --dangerously-skip-permissions --output-format text > "$LOG" 2>&1 || true

echo "Run finished. Report: $REPORT"
[ -f "$REPORT" ] && cat "$REPORT" || echo "No report written; check the log."
