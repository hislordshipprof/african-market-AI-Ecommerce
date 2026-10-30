#!/usr/bin/env bash
# Lists open ready-for-agent issues whose blockers are all closed, lowest number first.
# Usage: scripts/next-ticket.sh [--first]
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"

ready=()
for n in $(gh issue list -R "$REPO" --state open --label ready-for-agent --limit 100 --json number --jq '.[].number' | sort -n); do
  open_blockers=$(gh api "repos/$REPO/issues/$n/dependencies/blocked_by" --jq '[.[] | select(.state=="open") | .number] | join(",")')
  # Skip issues that already have an open PR from the builder.
  if gh pr list -R "$REPO" --state open --search "head:ticket-$n-" --json number --jq 'length' | grep -qv '^0$'; then
    continue
  fi
  if [ -z "$open_blockers" ]; then
    ready+=("$n")
  fi
done

if [ "${1:-}" = "--first" ]; then
  echo "${ready[0]:-}"
else
  for n in "${ready[@]}"; do
    echo "#$n $(gh issue view "$n" -R "$REPO" --json title --jq .title)"
  done
fi
