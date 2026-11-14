#!/usr/bin/env bash
# Tests for the once-a-day live sandbox run in scripts/ci-main.sh (#591). Run: bash scripts/ci-main.test.sh
# Runs ci-main.sh in a temp clone whose scripts/ci-local.sh only records LIVE_SANDBOX, so no suite runs.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
unset LIVE_SANDBOX
gh() { :; }; export -f gh

git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/E-commerce" 2>/dev/null
R="$T/E-commerce"
git -C "$R" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$R" push -q origin HEAD:main
mkdir -p "$R/scripts" "$R/.builder/logs"
touch "$R/.env.local"
# The fake suite records the flag it was given; CI_FAKE_OUT makes it report a superseded run.
printf '#!/usr/bin/env bash\necho "${LIVE_SANDBOX:-unset}" >> "%s/live.log"\n[ -n "${CI_FAKE_OUT:-}" ] && { echo "$CI_FAKE_OUT"; exit 3; }\nexit 0\n' "$T" > "$R/scripts/ci-local.sh"
STAMP="$R/.git/ci-main-live-sandbox-day"
run() { (cd "$R" && bash "$ROOT/scripts/ci-main.sh" >"$T/out" 2>&1); tail -1 "$T/live.log"; }
# Started from a subdirectory, the stamp must still land in the clone's .git.
run_from_sub() { (cd "$R/scripts" && bash "$ROOT/scripts/ci-main.sh" >"$T/out" 2>&1); tail -1 "$T/live.log"; }

[ "$(run_from_sub)" = 1 ] && [ -f "$STAMP" ] && ok "the first run of the day sets LIVE_SANDBOX=1" || bad "the first run of the day did not set LIVE_SANDBOX=1"
[ "$(run)" = 0 ] && ok "a second run the same day sets LIVE_SANDBOX=0" || bad "a second run the same day was live"

echo 2001-01-01 > "$STAMP"
[ "$(run)" = 1 ] && ok "a stamp from an earlier day allows a live run" || bad "a stamp from an earlier day blocked the live run"

rm -f "$STAMP"
[ "$(CI_FAKE_OUT="local-ci SUPERSEDED" run)" = 1 ] && [ ! -f "$STAMP" ] && ok "a superseded live run gives the day back" \
  || bad "a superseded live run kept the day's stamp"
[ "$(run)" = 1 ] && [ "$(LIVE_SANDBOX=1 run)" = 0 ] && ok "the next run takes the day back; later ones are not live even if the caller set the flag" \
  || bad "the day was not taken back, or a later run was live"

exit "$fail"
