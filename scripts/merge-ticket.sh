#!/usr/bin/env bash
# Merge a ticket's PR. Two gates, both on the PR's head commit, and the script checks both itself:
#   1. the independent review (.builder/review-<n>.md, written by review-ticket.sh) is a clean VERDICT: PASS
#      and is of that commit (.builder/review-<n>.sha). See scripts/merge-gate.sh.
#   2. local-ci (or the hosted "ci" check) is green on that commit.
# Then: squash-merge directly when the PR is up to date with main or behind without overlap; rebase and rerun a
# scoped local-ci when it rebases cleanly; otherwise scripts/ship-ticket.sh repairs the branch, which then needs
# a new review before this script will merge it.
# Usage: scripts/merge-ticket.sh <issue>
#   A second argument (the verdict line older callers passed) is accepted and ignored: the verdict is read from
#   the review file, never from the caller.
#   OWNER_ACCEPTS_BLOCKING="<the owner's reason>" merges a reviewed commit whose review is not a clean pass.
#   Only for a decision the owner made for this ticket; the reason is posted on the PR.
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"
N="${1:?usage: scripts/merge-ticket.sh <issue>}"
ROOT="$(git rev-parse --show-toplevel)"
. "$ROOT/scripts/merge-gate.sh"
REVIEW_FILE="$ROOT/.builder/review-$N.md"
REVIEW_SHA_FILE="$ROOT/.builder/review-$N.sha"

# Hosted CI is off, so a full run on main happens here, every CI_MAIN_EVERY merges. It runs detached and queues
# for the machine-wide lock, so it never holds up this merge. A failure opens a bug issue.
start_main_run_if_due() {
  local root last due
  root="$(git rev-parse --show-toplevel)"
  git -C "$root" fetch -q origin main || return 0
  last=$(cat "$root/.builder/ci-main-last" 2>/dev/null || true)
  due=$(git -C "$root" rev-list --count "${last:-origin/main~${CI_MAIN_EVERY:-3}}..origin/main" 2>/dev/null || echo "${CI_MAIN_EVERY:-3}")
  if [ "$due" -ge "${CI_MAIN_EVERY:-3}" ]; then
    nohup bash "$root/scripts/ci-main.sh" >/dev/null 2>&1 &
    echo "Started the full run on main ($due merge(s) since the last one)."
  fi
}

PR=$(gh pr list -R "$REPO" --state open --json number,headRefName --jq ".[] | select(.headRefName | startswith(\"ticket-$N-\")) | .number" | head -1)
[ -n "$PR" ] || { echo "No open PR for ticket #$N"; exit 1; }
HEAD_REF=$(gh api "repos/$REPO/pulls/$PR" --jq .head.ref)
CMP=$(gh api "repos/$REPO/compare/main...$HEAD_REF" --jq .behind_by)
HEAD_SHA=$(gh api "repos/$REPO/pulls/$PR" --jq .head.sha)
# Review gate, before anything else is spent on this PR.
VERDICT=$(review_gate "$REVIEW_FILE" "$REVIEW_SHA_FILE" "$HEAD_SHA" "${OWNER_ACCEPTS_BLOCKING:-}") \
  || { echo "Not merging #$N (PR #$PR): $VERDICT"; exit 1; }
# CI gate: a green local-ci status (scripts/ci-local.sh) or a green hosted "ci" check (run-ci label) on the PR head.
LOCAL_CI=$(gh api "repos/$REPO/commits/$HEAD_SHA/status" --jq '[.statuses[] | select(.context == "local-ci")][0].state // "missing"')
HOSTED_CI=$(gh api "repos/$REPO/commits/$HEAD_SHA/check-runs" --jq '[.check_runs[] | select(.name == "ci")][0].conclusion // "missing"')
if [ "$LOCAL_CI" != "success" ] && [ "$HOSTED_CI" != "success" ]; then
  echo "No green CI on $HEAD_SHA (local-ci: $LOCAL_CI, hosted ci: $HOSTED_CI). Run scripts/ci-local.sh in the worktree, or add the run-ci label."; exit 1
fi
# Vercel previews are optional on ticket branches (they build only on "[preview]" commits); a canceled or skipped preview never blocks a merge.
PENDING_OR_FAILED=$(gh pr checks "$PR" -R "$REPO" --json name,bucket,description --jq '[.[] | select(.bucket != "pass" and .bucket != "skipping") | select((.name | startswith("Vercel")) and ((.description // "") | test("[Cc]ancel|[Ii]gnored|[Ss]kipp|[Rr]ate limit")) | not)] | length')
# Behind main but disjoint: if no file changed on main since the PR's merge base is also changed by the PR,
# merge without re-running CI (scripts/ci-main.sh, below, is the safety net). Owner-approved 2026-11-02.
DISJOINT=no
if [ "$CMP" != "0" ] && [ "$PENDING_OR_FAILED" = "0" ]; then
  git fetch -q origin main "$HEAD_REF" 2>/dev/null || true
  BASE=$(git merge-base origin/main "origin/$HEAD_REF" 2>/dev/null || true)
  if [ -n "$BASE" ]; then
    OVERLAP=$(comm -12 <(git diff --name-only "$BASE" origin/main | sort) <(git diff --name-only "$BASE" "origin/$HEAD_REF" | sort) | grep -vE '^scripts/ticket-env\.txt$' || true)
    [ -z "$OVERLAP" ] && DISJOINT=yes || echo "Files changed on both sides: $(echo "$OVERLAP" | tr '\n' ' ')"
  fi
fi
if { [ "$CMP" = "0" ] || [ "$DISJOINT" = "yes" ]; } && [ "$PENDING_OR_FAILED" = "0" ]; then
  gh pr comment "$PR" -R "$REPO" --body "Merge gate: independent review $VERDICT; CI green on the same commit." >/dev/null
  # Pinned to the commit the checks above read: a later push fails the merge instead of landing untested.
  gh pr merge "$PR" -R "$REPO" --squash --delete-branch --match-head-commit "$HEAD_SHA"
  echo "Merged PR #$PR (fast path: $([ "$CMP" = "0" ] && echo "up to date with main" || echo "behind main by $CMP commit(s), no overlapping files"), all checks green)."
  start_main_run_if_due
else
  # Behind with green CI and no conflict: rebase here and rerun only what the rebase can affect. An agent is
  # for real repairs: a ship round cost #301 over an hour on 2026-11-05.
  WT="$(dirname "$ROOT")/E-commerce-worktrees/ticket-$N"
  if [ "$CMP" != "0" ] && [ "$PENDING_OR_FAILED" = "0" ] && [ "${MERGE_REBASED:-0}" = 0 ] && [ -d "$WT" ] \
    && [ -z "$(git -C "$WT" status --porcelain --untracked-files=no -- . ':!screenshots')" ] \
    && [ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD_SHA" ]; then
    git -C "$WT" checkout -q -- screenshots 2>/dev/null || true
    git -C "$WT" fetch -q origin main
    if git -C "$WT" rebase -q origin/main; then
      # The lease names the commit that passed. A bare lease would accept whatever the fetch above just saw.
      git -C "$WT" push -q --force-with-lease="refs/heads/$HEAD_REF:$HEAD_SHA" origin "HEAD:refs/heads/$HEAD_REF" \
        || { echo "PR #$PR moved while rebasing; not overwriting it. Rerun the merge."; exit 1; }
      # The script made this commit itself: the reviewed commit replayed on main with no conflict. The review
      # carries over to it, and the file records where it came from. Any other new head needs a new review.
      printf '%s rebased-from %s\n' "$(git -C "$WT" rev-parse HEAD)" "$HEAD_SHA" > "$REVIEW_SHA_FILE"
      echo "PR #$PR rebased cleanly onto main; rerunning local-ci for what the rebase can affect."
      CI_LOG="$ROOT/.builder/logs/ci-local-$N-$(date +%Y%m%d-%H%M%S).log"
      if (cd "$WT" && CI_REBASE_OF="$HEAD_SHA" E2E_PORT="${E2E_PORT:-3950}" CI_DB=ci \
        CI_RUNNER="$(dirname "$ROOT")/E-commerce-worktrees/ci-runner" bash "$ROOT/scripts/ci-local.sh" > "$CI_LOG" 2>&1); then
        MERGE_REBASED=1 exec bash "$0" "$N"
      fi
      echo "local-ci failed after the rebase. Log: $CI_LOG"
      exit 1
    fi
    git -C "$WT" rebase --abort 2>/dev/null || true
    echo "The rebase has conflicts."
  fi
  echo "PR #$PR is $CMP commit(s) behind main or has $PENDING_OR_FAILED non-green check(s); using ship-ticket.sh to repair the branch."
  "$(dirname "$0")/ship-ticket.sh" "$N" || true
  NEW_SHA=$(gh api "repos/$REPO/pulls/$PR" --jq .head.sha)
  if [ "$NEW_SHA" = "$HEAD_SHA" ]; then
    echo "ship-ticket.sh did not change PR #$PR. Not merged; see its log."
  else
    echo "PR #$PR was repaired and its head is now $NEW_SHA. That commit has not been reviewed. Not merged."
    echo "Next: scripts/review-ticket.sh $N, then scripts/merge-ticket.sh $N."
  fi
  exit 5
fi
