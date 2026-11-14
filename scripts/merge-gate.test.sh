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
gate "an empty review does not merge" 1 '' "$A\n" "$A"
gate "the owner can accept a blocking review of the head" 0 'VERDICT: BLOCKING\nLow-stock copy.\n' "$A\n" "$A" "owner: merge as is, follow-up in #999"
gate "the owner cannot accept a review of another commit" 1 'VERDICT: BLOCKING\n' "$A\n" "$B" "owner: merge as is"

# A review carried over by merge-ticket.sh ("<new> merged-from <old>") is checked again here, in a real repository:
# new^1 is the reviewed commit and new's diff against new^2 (main) has the reviewed commit's patch.
G="$T/gate-repo"; mkdir -p "$G"; cd "$G" || exit 1
git init -q -b main; git config user.email t@t; git config user.name t
printf 'a\nb\nc\nd\ne\nf\n' > app.ts; printf '1\n' > other.txt; git add .; git commit -qm base
git checkout -qb pr; sed -i 's/^a$/A/; s/^e$/E/' app.ts; git commit -qam pr; OLD=$(git rev-parse HEAD)
git checkout -q main; printf '2\n' > other.txt; git commit -qam main1
git checkout -qb clean "$OLD"; git merge -q --no-edit main >/dev/null; CLEAN=$(git rev-parse HEAD)
git checkout -q main; sed -i 's/^a$/A/' app.ts; git commit -qam part-of-pr
git checkout -qb partial "$OLD"; git merge -q --no-edit main >/dev/null; PARTIAL=$(git rev-parse HEAD)
git checkout -qb extra "$CLEAN"; echo more >> app.ts; git commit -qam extra; EXTRA=$(git rev-parse HEAD)
gate "a clean merge of main carries the review" 0 'VERDICT: PASS\n' "$CLEAN merged-from $OLD\n" "$CLEAN"
gate "a merge where main already holds part of the PR needs a new review" 1 'VERDICT: PASS\n' "$PARTIAL merged-from $OLD\n" "$PARTIAL"
gate "a commit after the merge needs a new review" 1 'VERDICT: PASS\n' "$EXTRA merged-from $OLD\n" "$EXTRA"
gate "a carry-over from another commit needs a new review" 1 'VERDICT: PASS\n' "$CLEAN merged-from $A\n" "$CLEAN"
gate "a rebase no longer carries the review" 1 'VERDICT: PASS\n' "$CLEAN rebased-from $OLD\n" "$CLEAN"
cd "$ROOT" || exit 1

# The scripts end to end: a fake gh, and a stand-in ship session that merges, as the ship-pr skill tells it to.
P="$T/proj"; W="$T/E-commerce-worktrees"
mkdir -p "$P/scripts/ship-guard" "$P/.builder/logs" "$W/ticket-77" "$W/ticket-408" "$T/bin"
cp "$ROOT"/scripts/{merge-ticket,ship-ticket,merge-gate,review-watch,strip-ai-coauthors}.sh "$P/scripts/"
cp "$ROOT/scripts/ship-guard/gh" "$P/scripts/ship-guard/" 2>/dev/null
( cd "$P" && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
for n in 77 408; do printf 'VERDICT: PASS\n' > "$P/.builder/review-$n.md"; echo "$A" > "$P/.builder/review-$n.sha"; done
cat > "$P/scripts/agent-cli.sh" <<'EOF'
agent_run() { echo "${GH_CONFIG_DIR:-} $(ls -A "${GH_CONFIG_DIR:-/nonexistent}" 2>/dev/null | wc -l | tr -d ' ') ${GH_TOKEN:-}" > "$FAKE_DIR/session-env"; "${SESSION_GH:-gh}" pr merge 77 --squash >/dev/null 2>&1 || true; }
EOF
# With FAKE_REMOTE set, the PR is the branch FAKE_REF on that bare repository, against its main.
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
remote() { git --git-dir="$FAKE_REMOTE" "$@"; }
case "$*" in
  "auth token") echo fake-token ;;
  "pr list"*) [ -z "${FAKE_TICKET_PR:-}" ] || echo "$FAKE_TICKET_PR" ;;
  "pr merge"*) echo "$*" >> "$FAKE_DIR/merged" ;;
  "pr checks"*) echo "${FAKE_NOT_GREEN:-0}" ;;
  *"/commits --paginate --jq "*) jq -r "${@: -1}" "$FAKE_DIR/pr-commits.json" ;;
  *"--jq .merged") if [ -f "$FAKE_DIR/merged" ]; then echo true; else echo false; fi ;;
  *"--jq .state") echo "${FAKE_STATE:-open}" ;;
  *"--jq .head.sha") if [ -n "${FAKE_REMOTE:-}" ]; then remote rev-parse "$FAKE_REF"; else echo "$FAKE_HEAD"; fi ;;
  *"--jq .head.ref") echo "${FAKE_REF:-some-branch}" ;;
  *"--jq .behind_by") if [ -n "${FAKE_REMOTE:-}" ]; then remote rev-list --count "$FAKE_REF..main"; else echo 0; fi ;;
  *"/status"*) echo success ;;
  *check-runs*) echo missing ;;
esac
EOF
chmod +x "$T/bin/gh"
# The commits API lists a merge commit with two parents; the squash body must leave it out.
cat > "$T/pr-commits.json" <<'EOF'
[{"sha":"c1","commit":{"message":"Add the feature"},"parents":[{"sha":"p0"}]},
 {"sha":"c2","commit":{"message":"Merge branch 'main' into ticket-90-x"},"parents":[{"sha":"c1"},{"sha":"m1"}]}]
EOF
in_proj() { rm -f "$T/merged"; ( cd "$P" && PATH="$T/bin:$PATH" FAKE_DIR="$T" FAKE_HEAD="$A" "$@" ) 2>&1; }

out=$(FAKE_TICKET_PR=77 FAKE_NOT_GREEN=1 in_proj bash scripts/merge-ticket.sh 77); rc=$?
if [ "$rc" = 5 ] && [ ! -f "$T/merged" ]; then ok "a ship session cannot merge the PR"; else bad "a ship session cannot merge the PR (rc=$rc, merged=$(cat "$T/merged" 2>/dev/null): $out)"; fi

# A session that gets past the guard. The merge has happened, so the scripts must say so and not "Not merged".
out=$(SESSION_GH="$T/bin/gh" FAKE_TICKET_PR=77 FAKE_NOT_GREEN=1 in_proj bash scripts/merge-ticket.sh 77); rc=$?
if [ "$rc" = 6 ] && [[ "$out" == *"merged PR #77 without a review"* ]] && [[ "$out" != *"Not merged"* ]]; then ok "merge-ticket reports a merge made by the ship session"; else bad "merge-ticket reports a merge made by the ship session (rc=$rc: $out)"; fi
out=$(SESSION_GH="$T/bin/gh" SHIP_PR=77 in_proj bash scripts/ship-ticket.sh 77); rc=$?
if [ "$rc" = 6 ] && [[ "$out" == *"merged PR #77 without a review"* ]]; then ok "ship-ticket reports a merge made by its session"; else bad "ship-ticket reports a merge made by its session (rc=$rc: $out)"; fi

# A PR whose branch is not named ticket-<n>-: found by number, and through the same gates.
out=$(in_proj bash scripts/merge-ticket.sh --pr 408); rc=$?
if [ "$rc" = 0 ] && grep -q 'pr merge 408 ' "$T/merged" 2>/dev/null; then ok "--pr merges a PR by its number"; else bad "--pr merges a PR by its number (rc=$rc: $out)"; fi
echo "$B" > "$P/.builder/review-408.sha"
out=$(in_proj bash scripts/merge-ticket.sh --pr 408); rc=$?
if [ "$rc" = 1 ] && [ ! -f "$T/merged" ]; then ok "--pr still needs a review of the PR head"; else bad "--pr still needs a review of the PR head (rc=$rc: $out)"; fi
echo "$A" > "$P/.builder/review-408.sha"
out=$(FAKE_STATE=closed in_proj bash scripts/merge-ticket.sh --pr 408); rc=$?
if [ "$rc" = 1 ] && [ ! -f "$T/merged" ]; then ok "--pr refuses a PR that is not open"; else bad "--pr refuses a PR that is not open (rc=$rc: $out)"; fi

# Behind main with overlapping files: merge-ticket merges main into the worktree and pushes normally. The remote
# refuses non-fast-forward pushes, so a force-push would fail these.
R="$T/remote.git"; WT="$W/ticket-90"; S="$T/seed"
cat > "$P/scripts/ci-local.sh" <<'EOF'
echo "${CI_MERGED_FROM:-} $(git rev-parse HEAD)" > "$FAKE_DIR/ci"
EOF
# lane <sed on main>: a fresh remote whose PR branch (lines a and e of a-l) and main both changed app.ts.
lane() {
  git -C "$P" worktree remove --force "$WT" 2>/dev/null; rm -rf "$R" "$S" "$WT"; git -C "$P" worktree prune
  git init -q --bare -b main "$R"; git -C "$R" config receive.denyNonFastForwards true
  git init -q -b main "$S"; cd "$S" || return 1; git config user.email t@t; git config user.name t
  printf 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n' > app.ts; git add .; git commit -qm base
  git checkout -qb ticket-90-x; sed -i 's/^a$/A/; s/^e$/E/' app.ts; git commit -qam feature
  git checkout -q main; sed -i "$1" app.ts; git commit -qam main1
  git push -q "$R" main ticket-90-x; cd "$ROOT" || return 1
  git -C "$P" remote remove origin 2>/dev/null; git -C "$P" remote add origin "$R"; git -C "$P" fetch -q origin
  git -C "$P" worktree add -q -B ticket-90-x "$WT" origin/ticket-90-x 2>/dev/null
  git -C "$WT" config user.email t@t; git -C "$WT" config user.name t
  OLD=$(git -C "$R" rev-parse ticket-90-x); echo "$OLD" > "$P/.builder/review-90.sha"
  printf 'VERDICT: PASS\n' > "$P/.builder/review-90.md"; rm -f "$T/ci"
}
on_lane() { FAKE_REMOTE="$R" FAKE_REF=ticket-90-x FAKE_TICKET_PR=90 in_proj bash scripts/merge-ticket.sh 90; }

lane 's/^l$/L/'; out=$(on_lane); rc=$?; NEW=$(git -C "$R" rev-parse ticket-90-x)
if [ "$rc" = 0 ] && [ "$(git -C "$R" rev-parse "$NEW^1" "$NEW^2" | tr '\n' ' ')" = "$OLD $(git -C "$R" rev-parse main) " ] \
  && grep -q -- "--match-head-commit $NEW" "$T/merged" 2>/dev/null; then ok "behind main: main is merged in, pushed normally, then squash-merged"
else bad "behind main: main is merged in, pushed normally, then squash-merged (rc=$rc: $out)"; fi
[ "$(cat "$P/.builder/review-90.sha")" = "$NEW merged-from $OLD" ] && ok "a clean merge carries the review over" \
  || bad "a clean merge carries the review over ($(cat "$P/.builder/review-90.sha"))"
[ "$(cat "$T/ci" 2>/dev/null)" = "$OLD $NEW" ] && ok "scoped local-ci runs on the merge" || bad "scoped local-ci runs on the merge ($(cat "$T/ci" 2>/dev/null))"
if grep -q 'Add the feature' "$T/merged" 2>/dev/null && ! grep -q "Merge branch" "$T/merged"; then ok "the squash body leaves out merge commits"
else bad "the squash body leaves out merge commits ($(cat "$T/merged" 2>/dev/null))"; fi

lane 's/^a$/A/'; out=$(on_lane); rc=$?; NEW=$(git -C "$R" rev-parse ticket-90-x)
if [ "$rc" = 5 ] && [ ! -f "$T/merged" ] && [ ! -f "$T/ci" ] && [ "$(git -C "$R" rev-parse "$NEW^1" 2>/dev/null)" = "$OLD" ] \
  && [ "$(cat "$P/.builder/review-90.sha")" = "$OLD" ]; then ok "main holding part of the PR: merged and pushed, but the head needs a new review"
else bad "main holding part of the PR: merged and pushed, but the head needs a new review (rc=$rc: $out)"; fi

lane 's/^a$/Z/'; out=$(on_lane); rc=$?
if [ "$rc" = 5 ] && [ ! -f "$T/merged" ] && [ "$(git -C "$R" rev-parse ticket-90-x)" = "$OLD" ] && [ "$(git -C "$WT" rev-parse HEAD)" = "$OLD" ] \
  && [ -z "$(git -C "$WT" status --porcelain --untracked-files=no)" ] && [ "$(cat "$P/.builder/review-90.sha")" = "$OLD" ] \
  && [[ "$out" == *"ship-ticket"* ]]; then ok "a conflict aborts the merge and hands the PR to ship-ticket"
else bad "a conflict aborts the merge and hands the PR to ship-ticket (rc=$rc: $out)"; fi
git -C "$P" worktree remove --force "$WT"

guard() { ( REAL_GH="$T/bin/gh" PATH="$T/bin:$PATH" FAKE_DIR="$T" bash "$P/scripts/ship-guard/gh" "$@" ) >/dev/null 2>&1; }
rm -f "$T/merged"
guard pr -R o/r merge 7 && bad "guard let pr -R merge through" || ok "guard refuses pr merge after a flag"
guard api -X PUT repos/o/r/pulls/7/merge && bad "guard let the merge API through" || ok "guard refuses the merge API"
guard pr checks 7 && ok "guard passes other gh calls" || bad "guard blocked pr checks"
# #413 N1: gh takes its repo flag before the command too, so "pr" is not always the first argument.
guard -R o/r pr merge 7 && bad "guard let -R pr merge through" || ok "guard refuses -R before pr merge"
guard --repo o/r pr merge 7 && bad "guard let --repo pr merge through" || ok "guard refuses --repo before pr merge"
guard --repo=o/r pr merge 7 && bad "guard let --repo= pr merge through" || ok "guard refuses --repo= before pr merge"
guard -R o/r api -X PUT repos/o/r/pulls/7/merge && bad "guard let -R api merge through" || ok "guard refuses the merge API after a flag"
# An alias the session defines expands inside the real gh, past the guard.
guard alias set m 'pr merge' && bad "guard let an alias be set" || ok "guard refuses gh alias"
guard -R o/r pr view 7 && ok "guard passes pr view after a flag" || bad "guard blocked pr view after a flag"
# The session's gh reads an empty config dir (no saved aliases), signed in through GH_TOKEN; the dir goes after.
rm -f "$T/session-env"; SHIP_PR=77 in_proj bash scripts/ship-ticket.sh 77 >/dev/null
read -r cfg files tok < "$T/session-env" 2>/dev/null
if [ -n "${cfg:-}" ] && [ "${files:-}" = 0 ] && [ "${tok:-}" = fake-token ] && [ ! -e "$cfg" ]; then ok "a ship session's gh has no saved aliases and keeps its login"
else bad "a ship session's gh has no saved aliases and keeps its login ($(cat "$T/session-env" 2>/dev/null))"; fi

# A login shell puts Homebrew's gh ahead of the guard, so a Claude ship session also needs the tool itself denied.
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "$CLAUDE_ARGS"\n' > "$T/bin/claude"; chmod +x "$T/bin/claude"
# Runs with no profile set (macOS bash 3.2 errors on an empty array under set -u), and clears the args file so a
# crash before claude starts fails both checks instead of passing the second one.
denied() { rm -f "$T/args"; ( unset AGENT_CLAUDE_CONFIG_DIR; AGENT_ENGINE=claude REVIEW_ENGINE=claude CLAUDE_ARGS="$T/args" PATH="$T/bin:$PATH"; export AGENT_ENGINE REVIEW_ENGINE CLAUDE_ARGS PATH; . "$ROOT/scripts/agent-cli.sh"; agent_run "$1" "$T/log" prompt ); grep -qx 'Bash(gh pr merge:\*)' "$T/args"; }
denied ship && ok "a Claude ship session has gh pr merge denied" || bad "a Claude ship session has gh pr merge denied"
denied review && bad "a review session had gh pr merge denied" || { [ -s "$T/args" ] && ok "other Claude sessions are unchanged" || bad "a review session never started claude"; }

exit "$fail"
