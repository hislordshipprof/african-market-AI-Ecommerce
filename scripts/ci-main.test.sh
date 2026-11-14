#!/usr/bin/env bash
# Tests for scripts/ci-main.sh and the CI_MAIN_LAST_FILE skip in scripts/ci-local.sh, in a throwaway repository
# with a fake gh. Run: bash scripts/ci-main.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

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
  rm -f "$T/issues"
  printf 'echo "%s"; exit %s\n' "$2" "$1" > "$P/scripts/ci-local.sh"
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
[ -z "$(ls "$T/E-commerce-worktrees" 2>/dev/null | grep main-ci-)" ] && ok "ci-main removes its worktree" || bad "ci-main left a worktree"

# ci-local.sh on main, with a newer commit already in CI_MAIN_LAST_FILE: it stops once it holds the lock, before
# any suite, and reports itself superseded.
git -C "$P" checkout -q scripts/ci-local.sh
echo newer > "$T/last"
out=$(cd "$P" && PATH="$T/bin:$PATH" FAKE_DIR="$T" CI_SCOPE=full CI_MAIN_LAST_FILE="$T/last" bash scripts/ci-local.sh 2>&1); rc=$?
[ "$rc" = 3 ] && [[ "$out" == *"local-ci SUPERSEDED: a newer full run on main is queued"* ]] && [[ "$out" != *"SETUP"* ]] \
  && ok "ci-local skips a main run that a newer one replaced" || bad "ci-local skips a main run that a newer one replaced (rc=$rc: $out)"
[ ! -d "$P/.git/ci-local.lock" ] && ok "the skipped run frees its lock" || bad "the skipped run kept its lock"

exit "$fail"
