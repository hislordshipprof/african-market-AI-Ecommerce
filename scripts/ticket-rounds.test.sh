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
# #413 N6: macOS has BSD date and stat, which take other flags.
if [ -x /usr/bin/stat ] && ! /usr/bin/stat -c %Y / >/dev/null 2>&1; then
  eq "builder minutes add up with BSD date and stat" 150 "$(PATH=/usr/bin:/bin ticket_builder_minutes "$T/time" 9)"
else ok "builder minutes with BSD date and stat (skipped: no BSD stat here)"; fi
touch "$T/time/ticket-9-notastamp.json"
eq "a log whose start time cannot be read is not counted" 150 "$(ticket_builder_minutes "$T/time" 9 2>/dev/null)"
case "$(ticket_builder_minutes "$T/time" 9 2>&1 >/dev/null)" in
  *ticket-9-notastamp.json*) ok "a log whose start time cannot be read is warned about" ;;
  *) bad "a log whose start time cannot be read is warned about" ;;
esac
rm "$T/time/ticket-9-notastamp.json"
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
agent_run() { : > "$2"; touch -d "-5 min" "$2"; return 124; }
(
  ROOT="$T/capped"; N=9; mkdir -p "$ROOT/.builder/logs"
  log="$ROOT/.builder/logs/ticket-9-$(date -d "-5 min" +%Y%m%d-%H%M%S).json"
  run_session builder "$log" "prompt" >/dev/null
  echo "rc=$? min=$(ticket_builder_minutes "$ROOT/.builder/logs" 9)"
) > "$T/capped.out"
eq "a session stopped at its cap is charged its wall minutes" "rc=124 min=5" "$(cat "$T/capped.out")"

# The orchestrator end to end (#413 N4), in a throwaway repository: a fake gh, engine, reviewer and local-ci.
P="$T/proj"; W="$T/lane"
git init -q -b main "$P"; git -C "$P" config user.email t@t; git -C "$P" config user.name t
mkdir -p "$P/scripts" "$P/.builder/logs" "$T/bin"
cp "$ROOT"/scripts/{build-ticket,review-watch}.sh "$P/scripts/"
cat > "$P/scripts/agent-cli.sh" <<'EOF'
AGENT_ENGINE=claude
agent_run() { echo "$1" >> "$FAKE_DIR/sessions"; : > "$2"; }
agent_session_id() { :; }
EOF
echo 'prepare_lane_env() { :; }' > "$P/scripts/lane-env.sh"
: > "$P/scripts/lane-env.mjs"
printf '.builder/\n' > "$P/.gitignore"
git -C "$P" add .; git -C "$P" commit -qm init; git -C "$P" remote add origin "$P"; git -C "$P" fetch -q origin
git -C "$P" worktree add -q -b ticket-9-x "$W" origin/main
printf '#!/usr/bin/env bash\ncase "$*" in *"--jq .title"*) echo "A thing" ;; esac\n' > "$T/bin/gh"; chmod +x "$T/bin/gh"
# The reviewer writes its round's log, as review-ticket.sh does, and prints the verdict.
cat > "$T/review.sh" <<'EOF'
touch "$ROOT_P/.builder/logs/review-9-$(date +%Y%m%d-%H%M%S)-$RANDOM.json"; echo "$FAKE_VERDICT" > "$ROOT_P/.builder/review-9.md"; echo "$FAKE_VERDICT"
EOF
# build <verdict> <local-ci exit> <local-ci output>: one --continue run of ticket 9.
build() {
  rm -f "$T/sessions" "$P"/.builder/logs/review-9-*
  printf 'echo "%s"; exit %s\n' "$3" "$2" > "$T/ci.sh"
  (cd "$P" && PATH="$T/bin:$PATH" FAKE_DIR="$T" ROOT_P="$P" FAKE_VERDICT="$1" WT="$W" LANE_DB=neon RISK=0 \
    REVIEW_TICKET="$T/review.sh" CI_LOCAL="$T/ci.sh" REVIEW_WATCH_POLL_SEC=1 bash scripts/build-ticket.sh 9 --continue) 2>&1
}
out=$(build "VERDICT: PASS" 1 "local-ci SETUP: HEAD is not on any remote branch. Push first."); rc=$?
[[ "$out" == *"failed in setup, not in the code. No fix round"* ]] && [ "$(wc -l < "$T/sessions")" = 1 ] \
  && ok "a passed review with a local-ci setup failure gets no fix round" || bad "a passed review with a local-ci setup failure gets no fix round (rc=$rc: $out)"
out=$(build "VERDICT: BLOCKING" 0 "local-ci PASSED"); rc=$?
[[ "$out" == *"The fix round for #9 made no commit. No second review"* ]] && [ "$(ls "$P"/.builder/logs/review-9-* | wc -l)" = 1 ] \
  && [ "$(wc -l < "$T/sessions")" = 2 ] && ok "a fix round with no commit gets no second review" || bad "a fix round with no commit gets no second review (rc=$rc: $out)"
rm -f "$P"/.builder/logs/review-9-*; for i in 1 2 3; do touch "$P/.builder/logs/review-9-2026110$i-010101.json"; done
rm -f "$T/sessions"
out=$(cd "$P" && PATH="$T/bin:$PATH" FAKE_DIR="$T" WT="$W" bash scripts/build-ticket.sh 9 --continue 2>&1); rc=$?
[ "$rc" = 1 ] && [[ "$out" == *"Refusing to run #9 (--continue): 3 review rounds already exist"* ]] && [ ! -f "$T/sessions" ] \
  && ok "a ticket with 3 review rounds is refused before any session" || bad "a ticket with 3 review rounds is refused before any session (rc=$rc: $out)"
git -C "$P" worktree remove --force "$W"

exit "$fail"
