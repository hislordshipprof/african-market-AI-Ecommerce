#!/usr/bin/env bash
# Review half of the merge gate, sourced by merge-ticket.sh. The other half (a green local-ci status on the PR
# head) stays in merge-ticket.sh.
# Until 2026-11-09 the merge script took the verdict as an argument the caller typed, and never opened the review.
# PR #390 merged with a BLOCKING review that way. The gate now reads the review itself:
# - .builder/review-<n>.md: line 1 is exactly "VERDICT: PASS", and no line anywhere is "VERDICT: BLOCKING"
#   (the second RISK review is appended to the same file with its own verdict line);
# - .builder/review-<n>.sha: the commit the review read, written by review-ticket.sh, equals the PR head. When
#   merge-ticket.sh merged main into the reviewed commit, the file reads "<new> merged-from <reviewed>", and the
#   gate accepts it only if merge_carries_review still holds.
# Tests: bash scripts/merge-gate.test.sh

# review_verdict_ok <review.md>: 0 only for a clean PASS. Windows line endings are tolerated; nothing else is.
review_verdict_ok() {
  local file="$1" first
  [ -s "$file" ] || return 1
  first=$(head -1 "$file" | tr -d '\r')
  [ "$first" = "VERDICT: PASS" ] || return 1
  ! tr -d '\r' < "$file" | grep -qx 'VERDICT: BLOCKING'
}

# review_sha <review.sha>: the reviewed commit (first word of the file), or nothing.
review_sha() {
  local sha=""
  [ -s "$1" ] && read -r sha _ < <(tr -d '\r' < "$1")
  printf '%s' "${sha:-}"
}

# merge_carries_review <reviewed> <new> [main]: 0 when <new> is a two-parent merge whose first parent is
# <reviewed>, whose second is <main> (when given), and whose diff against that parent has the same patch-id as
# <reviewed> against its merge base with it. So the PR's code is unchanged; main holding part of it fails.
merge_carries_review() {
  local old="$1" new="$2" main="${3:-}" p1 p2 a b
  p1=$(git rev-parse -q --verify "$new^1") && p2=$(git rev-parse -q --verify "$new^2") || return 1
  ! git rev-parse -q --verify "$new^3" >/dev/null || return 1
  [ "$p1" = "$(git rev-parse -q --verify "$old^{commit}")" ] || return 1
  [ -z "$main" ] || [ "$p2" = "$(git rev-parse -q --verify "$main^{commit}")" ] || return 1
  a=$(git diff "$p2" "$new" | git patch-id --stable | cut -d' ' -f1)
  b=$(git diff "$(git merge-base "$p2" "$old")" "$old" | git patch-id --stable | cut -d' ' -f1)
  [ -n "$a" ] && [ "$a" = "$b" ]
}

# review_gate <review.md> <review.sha> <pr-head-sha> [owner-override-reason]
# Prints why the gate is shut and returns 1, or prints what it accepted and returns 0.
# The override is for an owner decision to merge with known findings (it is posted on the PR). It skips the
# verdict check only: the review must still be of this exact commit.
review_gate() {
  local file="$1" shafile="$2" head="$3" override="${4:-}" reviewed how from
  if [ ! -s "$file" ]; then
    echo "No review at $file. Run scripts/review-ticket.sh first."; return 1
  fi
  reviewed=$(review_sha "$shafile")
  if [ -z "$reviewed" ]; then
    echo "The review at $file is not tied to a commit ($shafile is missing). Run scripts/review-ticket.sh again."; return 1
  fi
  if [ "$reviewed" != "$head" ]; then
    echo "The review read $reviewed but the PR head is $head. Review the new head first."; return 1
  fi
  read -r _ how from _ < <(tr -d '\r' < "$shafile") || true
  if [ -n "${how:-}" ] && { [ "$how" != merged-from ] || ! merge_carries_review "${from:-}" "$head"; }; then
    echo "The review of ${from:-another commit} does not carry over to $head ($shafile: $how). Review the new head first."; return 1
  fi
  if review_verdict_ok "$file"; then
    echo "VERDICT: PASS on $head"; return 0
  fi
  if [ -n "$override" ]; then
    echo "Owner accepted the review as it stands on $head: $override"; return 0
  fi
  echo "The review of $head is not a clean pass (line 1: $(head -1 "$file" | tr -d '\r'))."; return 1
}
