#!/usr/bin/env bash
# Fast ship: squash-merge a verified PR directly when it is already up to date with main and green.
# Falls back to scripts/ship-ticket.sh (rebase + bounded CI repair) when it is behind or not green.
# Usage: scripts/merge-ticket.sh <issue> "<QA verdict line>"
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"
N="${1:?usage: scripts/merge-ticket.sh <issue> \"<QA verdict>\"}"
VERDICT="${2:?QA verdict required}"
PR=$(gh pr list -R "$REPO" --state open --json number,headRefName --jq ".[] | select(.headRefName | startswith(\"ticket-$N-\")) | .number" | head -1)
[ -n "$PR" ] || { echo "No open PR for ticket #$N"; exit 1; }
HEAD_REF=$(gh api "repos/$REPO/pulls/$PR" --jq .head.ref)
CMP=$(gh api "repos/$REPO/compare/main...$HEAD_REF" --jq .behind_by)
# Vercel previews are optional on ticket branches (they build only on "[preview]" commits); a canceled or skipped preview never blocks a merge.
PENDING_OR_FAILED=$(gh pr checks "$PR" -R "$REPO" --json name,bucket,description --jq '[.[] | select(.bucket != "pass" and .bucket != "skipping") | select((.name | startswith("Vercel")) and ((.description // "") | test("[Cc]ancel|[Ii]gnored|[Ss]kipp|[Rr]ate limit")) | not)] | length')
# Behind main but disjoint: if no file changed on main since the PR's merge base is also changed by the PR,
# merge without re-running CI (main's post-merge CI is the safety net). Owner-approved 2026-11-02.
DISJOINT=no
if [ "$CMP" != "0" ] && [ "$PENDING_OR_FAILED" = "0" ]; then
  git fetch -q origin main "$HEAD_REF" 2>/dev/null || true
  BASE=$(git merge-base origin/main "origin/$HEAD_REF" 2>/dev/null || true)
  if [ -n "$BASE" ]; then
    OVERLAP=$(comm -12 <(git diff --name-only "$BASE" origin/main | sort) <(git diff --name-only "$BASE" "origin/$HEAD_REF" | sort) | grep -vE '^scripts/ticket-env\.txt$' || true)
    [ -z "$OVERLAP" ] && DISJOINT=yes || echo "Files changed on both sides: $(echo "$OVERLAP" | tr '
' ' ')"
  fi
fi
if { [ "$CMP" = "0" ] || [ "$DISJOINT" = "yes" ]; } && [ "$PENDING_OR_FAILED" = "0" ]; then
  gh pr comment "$PR" -R "$REPO" --body "Coordinator QA verdict: $VERDICT" >/dev/null
  gh pr merge "$PR" -R "$REPO" --squash --delete-branch
  echo "Merged PR #$PR (fast path: $([ "$CMP" = "0" ] && echo "up to date with main" || echo "behind main by $CMP commit(s), no overlapping files"), all checks green)."
else
  echo "PR #$PR is $CMP commit(s) behind main or has $PENDING_OR_FAILED non-green check(s); using ship-ticket.sh."
  exec "$(dirname "$0")/ship-ticket.sh" "$N" "$VERDICT"
fi
