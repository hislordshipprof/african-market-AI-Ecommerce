#!/usr/bin/env bash
# Tests for the per-ticket review-round cap in scripts/build-ticket.sh.
# Run: bash scripts/ticket-rounds.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/scripts/build-ticket.sh"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
eq() {
  local name="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then ok "$name"; else bad "$name (want $want, got $got)"; fi
}

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/logs"
# Same names review-ticket.sh writes: review-<n>-<stamp>.json, and <that>.second.json for the RISK peer.
touch "$T/logs/review-9-20261106-010101.json"
touch "$T/logs/review-9-20261106-020202.json"
touch "$T/logs/review-9-20261106-030303.json"
touch "$T/logs/review-9-20261106-030303.json.second.json"
touch "$T/logs/review-8-20261106-010101.json"

eq "three reviews, one second log, one other ticket" 3 "$(ticket_review_count "$T/logs" 9)"
eq "other ticket is not counted" 1 "$(ticket_review_count "$T/logs" 8)"
mkdir -p "$T/only-second"
touch "$T/only-second/review-9-20261106-010101.json.second.json"
eq "a second log alone is zero" 0 "$(ticket_review_count "$T/only-second" 9)"
eq "missing directory is zero" 0 "$(ticket_review_count "$T/missing" 9)"

eq "resume allowed at 2" yes "$(ticket_resume_allowed 2)"
eq "resume refused at 3" no "$(ticket_resume_allowed 3)"
eq "resume refused at 9" no "$(ticket_resume_allowed 9)"
eq "resume allowed at 0" yes "$(ticket_resume_allowed 0)"

eq "first build review can still cancel ci" no "$(ticket_round_is_last build 0)"
eq "second build review lets ci finish" yes "$(ticket_round_is_last build 1)"
eq "resume review lets ci finish" yes "$(ticket_round_is_last --resume 0)"
eq "resume at 2 lets ci finish" yes "$(ticket_round_is_last --resume 2)"
eq "continue with no logs can still cancel ci" no "$(ticket_round_is_last --continue 0)"

eq "first blocking review auto-fixes" autofix "$(ticket_round_after_review build 0 1)"
eq "count of 2 stops before the fix" stop "$(ticket_round_after_review build 1 2)"
eq "resume does not auto-fix" stop "$(ticket_round_after_review --resume 2 3)"
eq "resume with one log does not auto-fix" stop "$(ticket_round_after_review --resume 0 1)"
eq "a review that writes no log does not auto-fix" unrecorded "$(ticket_round_after_review build 0 0)"
eq "continue under 2 logs auto-fixes" autofix "$(ticket_round_after_review --continue 0 1)"

exit "$fail"
