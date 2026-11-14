#!/usr/bin/env bash
# Delta re-review (#616), sourced by review-ticket.sh. A re-review after a fix round or a conflict repair reads only
# what changed since the last reviewed commit, not the whole branch again. Run it from the ticket's worktree, after
# `git fetch origin main`.
#
# review_delta_prepare <last-reviewed-sha> <diff-out-file>
#   Sets DELTA_MODE to "full", "delta" or "merge" and DELTA_REASON to why. For delta and merge it writes the delta
#   diff to <diff-out-file> and sets DELTA_COMMITS (one line per commit) and DELTA_CONFLICTED (files both sides changed).
#   - delta: the commits on the branch's own line since <last>, with the changes main brought in left out.
#   - merge: the same, when the head is just a merge of main onto <last>: only the resolution.
#   A merge is shown as a combined diff (git --cc): the hunks where the result differs from every parent.
#   Full review when: REVIEW_FULL=1, <last> is empty, missing or not an ancestor of HEAD, or the delta is over
#   30% of the branch diff (changed lines).
# Tests: bash scripts/review-delta.test.sh

# diff_lines <git log -p output on stdin>: changed lines, counting only inside hunks (a combined diff has one
# +/- column per parent).
_diff_lines() {
  awk '/^COMMIT /{h=0;next} /^diff /{h=0;next} /^@@/{n=match($0,/[^@]/)-2;h=1;next} h&&substr($0,1,n)~/[-+]/{c++} END{print c+0}'
}

review_delta_prepare() {
  local last="${1:-}" out="$2" head branch delta
  DELTA_MODE=full; DELTA_REASON=""; DELTA_COMMITS=""; DELTA_CONFLICTED=""
  if [ "${REVIEW_FULL:-0}" = 1 ]; then DELTA_REASON="REVIEW_FULL=1"; return 0; fi
  if [ -z "$last" ]; then DELTA_REASON="no previous review of this ticket"; return 0; fi
  head=$(git rev-parse HEAD)
  if ! git rev-parse -q --verify "$last^{commit}" >/dev/null 2>&1 || ! git merge-base --is-ancestor "$last" "$head"; then
    DELTA_REASON="the previous reviewed commit $last is not reachable from HEAD"; return 0
  fi
  git log --first-parent --reverse --diff-merges=cc -p --format='COMMIT %h %s' "$last..$head" > "$out"
  branch=$(git diff --numstat origin/main...HEAD | awk '{s+=$1+$2} END{print s+0}')
  delta=$(_diff_lines < "$out")
  if [ "$branch" -eq 0 ] || [ $(( delta * 100 )) -gt $(( branch * 30 )) ]; then
    DELTA_REASON="the delta is $delta changed lines of the branch's $branch (over 30%)"; rm -f "$out"; return 0
  fi
  DELTA_COMMITS=$(git log --first-parent --reverse --format='- %h %s' "$last..$head")
  local m mb
  for m in $(git rev-list --first-parent --merges "$last..$head"); do
    mb=$(git merge-base "$m^1" "$m^2") || continue
    DELTA_CONFLICTED+=$(comm -12 <(git diff --name-only "$mb" "$m^1" | sort) <(git diff --name-only "$mb" "$m^2" | sort))$'\n'
  done
  DELTA_CONFLICTED=$(printf '%s' "$DELTA_CONFLICTED" | sed '/^$/d' | sort -u)
  DELTA_MODE=delta
  if [ "$(git rev-parse "$head^1" 2>/dev/null)" = "$(git rev-parse "$last")" ] && git rev-parse -q --verify "$head^2" >/dev/null \
     && ! git rev-parse -q --verify "$head^3" >/dev/null && git merge-base --is-ancestor "$head^2" origin/main; then
    DELTA_MODE=merge
  fi
  DELTA_REASON="$delta changed lines since $last, of the branch's $branch"
}

# review_delta_prompt <issue> <last> <previous-review-file> <delta-file>: the section added to the reviewer's prompt
# for a delta or merge review. The round 1 instructions above it stay as they are.
review_delta_prompt() {
  local n="$1" last="$2" prev="$3" file="$4" what
  if [ "$DELTA_MODE" = merge ]; then
    what="This head is a merge of origin/main onto the reviewed commit $last. Review only the merge resolution: the combined diff in $file (hunks where the merge result differs from both parents)"
    [ -n "$DELTA_CONFLICTED" ] && what+=" and these files that both sides changed:
$DELTA_CONFLICTED"
    what+="
Check that the resolution keeps both sides' intent and the build still holds. Anything outside the resolution counts only where the merge touches it."
  else
    what="Review the delta since the last reviewed commit $last: $file holds the diff of the commits below, with the changes main brought in left out. Anything outside the delta counts only where the delta touches it.
Commits since $last:
$DELTA_COMMITS"
    [ -n "$DELTA_CONFLICTED" ] && what+="
A merge of main resolved conflicts in:
$DELTA_CONFLICTED"
  fi
  cat <<EOF2

DELTA REVIEW (this is a re-review of #$n, not the first review). The full branch diff above is for context.
$what
Earlier review of $last (its findings are below). For each earlier blocking finding, say whether it is fixed, with evidence (the code, or a test you ran). Then review the delta for new problems.
--- earlier review ---
$(cat "$prev")
--- end of earlier review ---
EOF2
}
