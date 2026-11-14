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

# Builder time: a session runs from the stamp in its log's name to the log's last write.
mkdir -p "$T/time"
mk() { touch -d "$3" "$T/time/$1-$2.json"; }
mk ticket-9 20261106-010000 "2026-11-06 02:30:00"       # build: 90 min
mk ticket-9-fix 20261106-040000 "2026-11-06 05:00:00"   # fix: 60 min
mk ticket-90 20261106-010000 "2026-11-06 09:00:00"      # another ticket
mk review-9 20261106-023000 "2026-11-06 04:00:00"       # a review is not builder time
mk plan-9 20261105-220000 "2026-11-05 22:20:00"
eq "builder minutes add up build and fix sessions only" 150 "$(ticket_builder_minutes "$T/time" 9)"
eq "a ticket with no sessions has used nothing" 0 "$(ticket_builder_minutes "$T/time" 7)"

eq "a fresh ticket gets the full session cap" 90 "$(ticket_session_cap 90 300 0)"
eq "the last session gets only what the budget has left" 30 "$(ticket_session_cap 90 300 270)"
eq "a spent budget allows no session" 0 "$(ticket_session_cap 90 300 300)"
eq "an overspent budget allows no session" 0 "$(ticket_session_cap 90 300 480)"

# Lane age runs from the plan log, not from the latest fix round.
now=$(date +%s); plan=$(date -d "2026-11-05 22:00:00" +%s)
age=$(ticket_lane_age_min "$T/time" 9)
want=$(( (now - plan) / 60 ))
[ $(( age - want )) -ge -1 ] && [ $(( age - want )) -le 1 ] && ok "lane age is measured from the plan log" || bad "lane age (want $want, got $age)"
eq "a ticket with no logs has age 0" 0 "$(ticket_lane_age_min "$T/time" 7)"

# A session stopped at its cap is charged its wall time. The engine opens its log at the start and writes
# only on exit, so a killed session leaves an empty log whose last write is its start.
. "$ROOT/scripts/review-watch.sh"
agent_run() { : > "$2"; touch -d "-5 min" "$2"; return 124; }
(
  ROOT="$T/capped"; N=9; mkdir -p "$ROOT/.builder/logs"
  log="$ROOT/.builder/logs/ticket-9-$(date -d "-5 min" +%Y%m%d-%H%M%S).json"
  run_session builder "$log" "prompt" >/dev/null
  echo "rc=$? min=$(ticket_builder_minutes "$ROOT/.builder/logs" 9)"
) > "$T/capped.out"
eq "a session stopped at its cap is charged its wall minutes" "rc=124 min=5" "$(cat "$T/capped.out")"

exit "$fail"
