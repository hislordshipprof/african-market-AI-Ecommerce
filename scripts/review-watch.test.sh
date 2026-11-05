#!/usr/bin/env bash
# Tests for scripts/review-watch.sh. Run: bash scripts/review-watch.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/review-watch.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
export REVIEW_WATCH_POLL_SEC=1

# 1. A reviewer that writes its verdict and then hangs is stopped after the grace period, with its child.
hang_after_verdict() { printf 'VERDICT: PASS\n' > "$T/r1.md"; sleep 300 & echo $! > "$T/child1"; wait; }
start=$SECONDS
REVIEW_EXIT_GRACE_SEC=2 REVIEW_TIMEOUT_MIN=5 watch_run "$T/r1.md" hang_after_verdict; rc=$?
took=$((SECONDS - start))
[ "$rc" = 124 ] && [ "$took" -lt 30 ] && ok "hung-after-verdict stopped (rc=$rc, ${took}s)" || bad "hung-after-verdict (rc=$rc, ${took}s)"
sleep 1
kill -0 "$(cat "$T/child1")" 2>/dev/null && bad "child of hung reviewer still running" || ok "child of hung reviewer stopped"

# 2. A reviewer that exits normally keeps its own status and is never stopped.
quick() { printf 'VERDICT: BLOCKING\n' > "$T/r2.md"; return 3; }
REVIEW_EXIT_GRACE_SEC=2 watch_run "$T/r2.md" quick; rc=$?
[ "$rc" = 3 ] && ok "normal exit keeps status 3" || bad "normal exit status (rc=$rc)"

# 3. A reviewer still working with no verdict is left alone until the total cap.
slow() { sleep 4; printf 'VERDICT: PASS\n' > "$T/r3.md"; }
REVIEW_EXIT_GRACE_SEC=2 REVIEW_TIMEOUT_MIN=5 watch_run "$T/r3.md" slow; rc=$?
[ "$rc" = 0 ] && ok "working reviewer without verdict is not stopped" || bad "working reviewer stopped early (rc=$rc)"

# 4. The total cap stops a reviewer that never writes anything. The cap is minutes, so test a 0-minute cap.
never() { sleep 300; }
start=$SECONDS
REVIEW_TIMEOUT_MIN=0 watch_run "$T/none.md" never; rc=$?
took=$((SECONDS - start))
[ "$rc" = 124 ] && [ "$took" -lt 30 ] && ok "total cap stops a silent reviewer (${took}s)" || bad "total cap (rc=$rc, ${took}s)"

# 5. A bold verdict line (**VERDICT: PASS**) also counts as written.
bold() { printf '**VERDICT: PASS**\n' > "$T/r5.md"; sleep 300; }
REVIEW_EXIT_GRACE_SEC=2 REVIEW_TIMEOUT_MIN=5 watch_run "$T/r5.md" bold; rc=$?
[ "$rc" = 124 ] && ok "bold verdict line detected" || bad "bold verdict (rc=$rc)"

# 6. A native grandchild (node spawning node, like codex.js spawning codex.exe) is stopped too.
native() {
  printf 'VERDICT: PASS\n' > "$T/r6.md"
  node -e "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},300000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],String(c.pid));setTimeout(()=>{},300000)" "$T/gc6"
}
REVIEW_EXIT_GRACE_SEC=2 REVIEW_TIMEOUT_MIN=5 watch_run "$T/r6.md" native; rc=$?
sleep 2
gc=$(cat "$T/gc6" 2>/dev/null || echo "")
alive=$(node -e "try{process.kill(Number(process.argv[1]),0);console.log('yes')}catch{console.log('no')}" "$gc")
[ "$rc" = 124 ] && [ -n "$gc" ] && [ "$alive" = no ] && ok "native grandchild stopped (pid $gc)" || bad "native grandchild (rc=$rc, pid=$gc, alive=$alive)"

# 7. stop_worktree_servers stops a `next start` from this worktree only, never one from another worktree.
if command -v powershell >/dev/null 2>&1; then
  mine="C:\\E-commerce-worktrees\\ticket-wtest7\\node_modules\\next\\dist\\bin\\next"
  other="C:\\E-commerce-worktrees\\ticket-wother7\\node_modules\\next\\dist\\bin\\next"
  node -e "setTimeout(()=>{},120000)" "$mine" start -p 3999 & a=$!
  node -e "setTimeout(()=>{},120000)" "$other" start -p 3998 & b=$!
  sleep 2
  stop_worktree_servers /c/E-commerce-worktrees/ticket-wtest7 >/dev/null
  sleep 1
  kill -0 "$a" 2>/dev/null && bad "own worktree server still running" || ok "own worktree server stopped"
  kill -0 "$b" 2>/dev/null && ok "other worktree server untouched" || bad "other worktree server was stopped"
  kill "$b" 2>/dev/null; wait 2>/dev/null
fi

exit "$fail"
