#!/usr/bin/env bash
# Delta re-review (#616), sourced by review-ticket.sh. A re-review after a fix round or a conflict repair reads only
# what changed since the last reviewed commit, not the whole branch again. Run it from the ticket's worktree, after
# `git fetch origin main`.
#
# review_delta_prepare <last-reviewed-sha> <diff-out-file>
#   Sets DELTA_MODE to "full", "delta" or "merge" and DELTA_REASON to why. For delta and merge it writes the delta
#   diff to <diff-out-file> and sets DELTA_COMMITS (one line per commit) and DELTA_CONFLICTED (files both sides of a
#   merge of main changed, renames included).
#   The delta is everything the branch adds relative to main now that was not in the reviewed commit unchanged: the
#   reviewed changes are replayed onto main (git merge-tree) and compared with HEAD. Files where that replay
#   conflicts show their whole branch diff.
#   - merge: the head is just a merge of main onto <last>, so the delta is the resolution.
#   Full review when: REVIEW_FULL=1, <last> is empty, missing or not an ancestor of HEAD, a merge since <last> brings
#   in a branch that is not on origin/main, the replay fails, or the delta is over 30% of the branch diff (changed
#   lines).
# Tests: bash scripts/review-delta.test.sh

# _diff_lines <a diff on stdin>: changed lines, counting only inside hunks.
_diff_lines() {
  awk '/^diff /{h=0;next} /^@@/{h=1;next} h&&/^[-+]/{c++} END{print c+0}'
}

# _merge_paths <base> <side1> <side2>: paths both sides changed, with rename detection, plus both names of any rename
# that touches one of them (a rename/rename conflict shares only the old name).
_merge_paths() {
  local both
  both=$(comm -12 <(_side_paths "$1" "$2") <(_side_paths "$1" "$3"))
  [ -n "$both" ] || return 0
  { printf '%s\n' "$both"
    { git diff -M --name-status "$1" "$2"; git diff -M --name-status "$1" "$3"; } \
      | awk -F'\t' 'NR==FNR{c[$0]=1;next} $1~/^R/ && ($2 in c || $3 in c){print $2; print $3}' <(printf '%s\n' "$both") -
  } | sort -u
}
_side_paths() { git diff -M --name-status "$1" "$2" | cut -f2- | tr '\t' '\n' | sort -u; }

review_delta_prepare() {
  local last="${1:-}" out="$2" head branch delta
  DELTA_MODE=full; DELTA_REASON=""; DELTA_COMMITS=""; DELTA_CONFLICTED=""
  if [ "${REVIEW_FULL:-0}" = 1 ]; then DELTA_REASON="REVIEW_FULL=1"; return 0; fi
  if [ -z "$last" ]; then DELTA_REASON="no previous review of this ticket"; return 0; fi
  head=$(git rev-parse HEAD)
  if ! git rev-parse -q --verify "$last^{commit}" >/dev/null 2>&1 || ! git merge-base --is-ancestor "$last" "$head"; then
    DELTA_REASON="the previous reviewed commit $last is not reachable from HEAD"; return 0
  fi
  local m p
  for m in $(git rev-list --merges "$last..$head"); do
    for p in $(git rev-list --parents -n1 "$m" | cut -d' ' -f3-); do
      git merge-base --is-ancestor "$p" origin/main && continue
      DELTA_REASON="merge $(git rev-parse --short "$m") brings in $(git rev-parse --short "$p"), which is not on origin/main"; return 0
    done
  done
  local base mbl replay tree conflicts=() x
  base=$(git merge-base origin/main HEAD); mbl=$(git merge-base origin/main "$last")
  # Exit 1 means the replay conflicted: the tree is on the first line, the conflicted paths follow up to a blank line.
  replay=$(git merge-tree --write-tree --name-only --merge-base="$mbl" "$base" "$last") && x=0 || x=$?
  if [ "$x" -gt 1 ]; then DELTA_REASON="could not replay $last onto main"; return 0; fi
  tree=${replay%%$'\n'*}
  if [ "$x" = 1 ]; then
    while IFS= read -r p; do [ -n "$p" ] || break; conflicts+=("$p"); done <<< "${replay#*$'\n'}"
  fi
  { git diff -M --no-color --no-ext-diff "$tree" "$head" -- . ${conflicts[@]+"${conflicts[@]/#/:(exclude,literal)}"}
    [ "${#conflicts[@]}" -eq 0 ] || git diff -M --no-color --no-ext-diff "$base" "$head" -- "${conflicts[@]/#/:(literal)}"
  } > "$out"
  branch=$(git diff -M --numstat origin/main...HEAD | awk '{s+=$1+$2} END{print s+0}')
  delta=$(_diff_lines < "$out")
  if [ "$branch" -eq 0 ] || [ $(( delta * 100 )) -gt $(( branch * 30 )) ]; then
    DELTA_REASON="the delta is $delta changed lines of the branch's $branch (over 30%)"; rm -f "$out"; return 0
  fi
  DELTA_COMMITS=$(git log --first-parent --reverse --format='- %h %s' "$last..$head")
  local mb
  for m in $(git rev-list --merges "$last..$head"); do
    mb=$(git merge-base "$m^1" "$m^2") || continue
    DELTA_CONFLICTED+=$(_merge_paths "$mb" "$m^1" "$m^2")$'\n'
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
    what="This head is a merge of origin/main onto the reviewed commit $last. Review only the merge resolution: $file holds every line the branch now changes relative to main that differs from the reviewed commit (files where the reviewed changes no longer apply cleanly to main show their whole branch diff)"
    [ -n "$DELTA_CONFLICTED" ] && what+=" and these files that both sides changed:
$DELTA_CONFLICTED"
    what+="
Check that the resolution keeps both sides' intent and the build still holds. Anything outside the resolution counts only where the merge touches it."
  else
    what="Review the delta since the last reviewed commit $last: $file holds every line the branch now changes relative to main that was not in $last unchanged, with the changes main brought in left out (files where the reviewed changes no longer apply cleanly to main show their whole branch diff). Anything outside the delta counts only where the delta touches it.
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
