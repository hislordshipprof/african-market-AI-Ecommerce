#!/usr/bin/env bash
# Tests for the review half of the merge gate (scripts/merge-gate.sh). Run: bash scripts/merge-gate.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/merge-gate.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
# gate <name> <want exit> <review text> <sha file text> <head> [override]
gate() {
  local name="$1" want="$2" out rc=0
  printf '%b' "$3" > "$T/review.md"
  if [ -n "$4" ]; then printf '%b' "$4" > "$T/review.sha"; else rm -f "$T/review.sha"; fi
  out=$(review_gate "$T/review.md" "$T/review.sha" "$5" "${6:-}") || rc=$?
  if [ "$rc" = "$want" ]; then ok "$name"; else bad "$name (want $want, got $rc: $out)"; fi
}
A=1111111111111111111111111111111111111111
B=2222222222222222222222222222222222222222

gate "a clean pass of the PR head merges" 0 'VERDICT: PASS\nNo findings.\n' "$A\n" "$A"
gate "a blocking review does not merge" 1 'VERDICT: BLOCKING\n1. Refund is sent twice.\n' "$A\n" "$A"
# PR #390: the review was BLOCKING and a loose match on PASS let it through.
gate "PASS further down a blocking review does not merge" 1 'VERDICT: BLOCKING\nEarlier round: VERDICT: PASS\nVERDICT: PASS\n' "$A\n" "$A"
gate "PASS with a qualifier is not a pass" 1 'VERDICT: PASS with two blocking findings\n' "$A\n" "$A"
gate "a blocking second review appended to a pass does not merge" 1 'VERDICT: PASS\n\n## Second review\n\nVERDICT: BLOCKING\nCross-store read.\n' "$A\n" "$A"
gate "a passing second review appended to a pass merges" 0 'VERDICT: PASS\n\n## Second review\n\nVERDICT: PASS\n' "$A\n" "$A"
gate "Windows line endings are still a pass" 0 'VERDICT: PASS\r\nNo findings.\r\n' "$A\r\n" "$A"
gate "a pass for an older commit does not merge the new head" 1 'VERDICT: PASS\n' "$A\n" "$B"
gate "a pass tied to no commit does not merge" 1 'VERDICT: PASS\n' "" "$A"
gate "the merge script's own clean rebase carries the review" 0 'VERDICT: PASS\n' "$B rebased-from $A\n" "$B"
gate "an empty review does not merge" 1 '' "$A\n" "$A"
gate "the owner can accept a blocking review of the head" 0 'VERDICT: BLOCKING\nLow-stock copy.\n' "$A\n" "$A" "owner: merge as is, follow-up in #999"
gate "the owner cannot accept a review of another commit" 1 'VERDICT: BLOCKING\n' "$A\n" "$B" "owner: merge as is"

exit "$fail"
