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

# The scripts end to end: a fake gh, and a stand-in ship session that merges, as the ship-pr skill tells it to.
P="$T/proj"; W="$T/E-commerce-worktrees"
mkdir -p "$P/scripts/ship-guard" "$P/.builder/logs" "$W/ticket-77" "$W/ticket-408" "$T/bin"
cp "$ROOT"/scripts/{merge-ticket,ship-ticket,merge-gate,review-watch,strip-ai-coauthors}.sh "$P/scripts/"
cp "$ROOT/scripts/ship-guard/gh" "$P/scripts/ship-guard/" 2>/dev/null
( cd "$P" && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
for n in 77 408; do printf 'VERDICT: PASS\n' > "$P/.builder/review-$n.md"; echo "$A" > "$P/.builder/review-$n.sha"; done
cat > "$P/scripts/agent-cli.sh" <<'EOF'
agent_run() { "${SESSION_GH:-gh}" pr merge 77 --squash >/dev/null 2>&1 || true; }
EOF
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "pr list"*) [ -z "${FAKE_TICKET_PR:-}" ] || echo "$FAKE_TICKET_PR" ;;
  "pr merge"*) echo "$*" >> "$FAKE_DIR/merged" ;;
  "pr checks"*) echo "${FAKE_NOT_GREEN:-0}" ;;
  *"--jq .merged") if [ -f "$FAKE_DIR/merged" ]; then echo true; else echo false; fi ;;
  *"--jq .state") echo "${FAKE_STATE:-open}" ;;
  *"--jq .head.sha") echo "$FAKE_HEAD" ;;
  *"--jq .head.ref") echo some-branch ;;
  *"--jq .behind_by") echo 0 ;;
  *"/status"*) echo success ;;
  *check-runs*) echo missing ;;
esac
EOF
chmod +x "$T/bin/gh"
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

guard() { ( REAL_GH="$T/bin/gh" PATH="$T/bin:$PATH" FAKE_DIR="$T" bash "$P/scripts/ship-guard/gh" "$@" ) >/dev/null 2>&1; }
rm -f "$T/merged"
guard pr -R o/r merge 7 && bad "guard let pr -R merge through" || ok "guard refuses pr merge after a flag"
guard api -X PUT repos/o/r/pulls/7/merge && bad "guard let the merge API through" || ok "guard refuses the merge API"
guard pr checks 7 && ok "guard passes other gh calls" || bad "guard blocked pr checks"

# A login shell puts Homebrew's gh ahead of the guard, so a Claude ship session also needs the tool itself denied.
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "$CLAUDE_ARGS"\n' > "$T/bin/claude"; chmod +x "$T/bin/claude"
# Runs with no profile set (macOS bash 3.2 errors on an empty array under set -u), and clears the args file so a
# crash before claude starts fails both checks instead of passing the second one.
denied() { rm -f "$T/args"; ( unset AGENT_CLAUDE_CONFIG_DIR; AGENT_ENGINE=claude REVIEW_ENGINE=claude CLAUDE_ARGS="$T/args" PATH="$T/bin:$PATH"; export AGENT_ENGINE REVIEW_ENGINE CLAUDE_ARGS PATH; . "$ROOT/scripts/agent-cli.sh"; agent_run "$1" "$T/log" prompt ); grep -qx 'Bash(gh pr merge:\*)' "$T/args"; }
denied ship && ok "a Claude ship session has gh pr merge denied" || bad "a Claude ship session has gh pr merge denied"
denied review && bad "a review session had gh pr merge denied" || { [ -s "$T/args" ] && ok "other Claude sessions are unchanged" || bad "a review session never started claude"; }

exit "$fail"
