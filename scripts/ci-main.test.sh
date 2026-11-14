#!/usr/bin/env bash
# Tests for scripts/ci-main.sh, the CI_MAIN_LAST_FILE skip in scripts/ci-local.sh, and the once-a-day live sandbox
# run (#591), in throwaway repositories with a fake gh. Run: bash scripts/ci-main.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
unset LIVE_SANDBOX

# P is the main checkout, R its origin. ci-main.sh adds its worktrees next to P, under E-commerce-worktrees/.
P="$T/proj"; R="$T/remote.git"
git init -q --bare -b main "$R"
git init -q -b main "$P"; cd "$P" || exit 1
git config user.email t@t; git config user.name t
mkdir -p scripts .builder/logs "$T/bin"
cp "$ROOT"/scripts/{ci-main,ci-local,ci-scope,ci-lock,review-watch}.sh scripts/
printf '.builder/\n.env.local\n' > .gitignore; : > .env.local
git add .; git commit -qm init; git remote add origin "$R"; git push -q origin main
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "issue create"*) echo "$*" >> "$FAKE_DIR/issues" ;;
esac
EOF
chmod +x "$T/bin/gh"
cd "$ROOT" || exit 1

# ci_main <ci-local exit> <ci-local output>: ci-main.sh with ci-local.sh replaced by a stand-in.
ci_main() {
  rm -f "$T/issues" "$T/ran-in"
  printf 'pwd > "%s/ran-in"; echo "%s"; exit %s\n' "$T" "$2" "$1" > "$P/scripts/ci-local.sh"
  (cd "$P" && PATH="$T/bin:$PATH" FAKE_DIR="$T" bash scripts/ci-main.sh) 2>&1
}
out=$(ci_main 0 "local-ci PASSED"); rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"ci-main PASSED"* ]] && ok "a green run on main passes" || bad "a green run on main passes (rc=$rc: $out)"
out=$(ci_main 3 "local-ci SUPERSEDED: a newer full run on main is queued"); rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"skipped"* ]] && [ ! -f "$T/issues" ] && ok "a superseded run is skipped, no issue" \
  || bad "a superseded run is skipped, no issue (rc=$rc: $out)"
# #413 N7: the exit status decides, not the log. A failing test can print the word.
out=$(ci_main 1 "FAIL e2e: shows local-ci SUPERSEDED on the status page"); rc=$?
[ "$rc" = 1 ] && [[ "$out" == *"ci-main FAILED"* ]] && [ -f "$T/issues" ] && ok "a failure whose log mentions SUPERSEDED is a failure" \
  || bad "a failure whose log mentions SUPERSEDED is a failure (rc=$rc: $out)"
wt=$(cat "$T/ran-in" 2>/dev/null)
[[ "$wt" == */E-commerce-worktrees/main-ci-* ]] && [ ! -e "$wt" ] && ok "ci-main runs in its own worktree and removes it" \
  || bad "ci-main runs in its own worktree and removes it (ran in '$wt')"

# ci-local.sh on main, with a newer commit already in CI_MAIN_LAST_FILE: it stops once it holds the lock, before
# any suite, and reports itself superseded.
git -C "$P" checkout -q scripts/ci-local.sh
echo newer > "$T/last"
out=$(cd "$P" && PATH="$T/bin:$PATH" FAKE_DIR="$T" CI_SCOPE=full CI_MAIN_LAST_FILE="$T/last" bash scripts/ci-local.sh 2>&1); rc=$?
[ "$rc" = 3 ] && [[ "$out" == *"local-ci SUPERSEDED: a newer full run on main is queued"* ]] && [[ "$out" != *"SETUP"* ]] \
  && ok "ci-local skips a main run that a newer one replaced" || bad "ci-local skips a main run that a newer one replaced (rc=$rc: $out)"
[ ! -d "$P/.git/ci-local.lock" ] && ok "the skipped run frees its lock" || bad "the skipped run kept its lock"

# The once-a-day live sandbox run (#591): ci-main.sh in a temp clone whose scripts/ci-local.sh only records
# LIVE_SANDBOX, so no suite runs.
gh() { :; }; export -f gh

git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/E-commerce" 2>/dev/null
R="$T/E-commerce"
git -C "$R" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$R" push -q origin HEAD:main
mkdir -p "$R/scripts" "$R/.builder/logs"
cp "$ROOT/scripts/ci-scope.sh" "$R/scripts/"
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
