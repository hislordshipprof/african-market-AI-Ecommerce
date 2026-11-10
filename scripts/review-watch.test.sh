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
# running <pid>: still executing. A killed process that nobody has reaped yet (a zombie, seen in containers
# without an init) is not running.
running() {
  kill -0 "$1" 2>/dev/null || return 1
  [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]
}

# 1. A reviewer that writes its verdict and then hangs is stopped after the grace period, with its child.
# The watchdog's own message proves the grace path fired. A cap path would say "ran past 300s".
hang_after_verdict() { printf 'VERDICT: PASS\n' > "$T/r1.md"; sleep 300 & echo $! > "$T/child1"; wait; }
REVIEW_EXIT_GRACE_SEC=2 REVIEW_TIMEOUT_MIN=5 watch_run "$T/r1.md" hang_after_verdict >/dev/null 2>"$T/err1"
rc=$?
grep -q "verdict written 2s ago" "$T/err1" && [ "$rc" = 124 ] && ok "hung-after-verdict stopped (rc=$rc)" || bad "hung-after-verdict (rc=$rc) $(cat "$T/err1")"
sleep 1
running "$(cat "$T/child1")" && bad "child of hung reviewer still running" || ok "child of hung reviewer stopped"

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
REVIEW_TIMEOUT_MIN=0 watch_run "$T/none.md" never >/dev/null 2>"$T/err4"
rc=$?
grep -q "ran past 0s" "$T/err4" && [ "$rc" = 124 ] && ok "total cap stops a silent reviewer" || bad "total cap (rc=$rc) $(cat "$T/err4")"

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

  # 8. Prefix collision: cleaning ticket-wt27 must not touch ticket-wt275. Forward-slash and lower-case
  #    forms of the own path, and next dev's start-server.js child, are stopped.
  node -e "setTimeout(()=>{},120000)" "C:\\E-commerce-worktrees\\ticket-wt275\\node_modules\\next\\dist\\bin\\next" start -p 3997 & p275=$!
  node -e "setTimeout(()=>{},120000)" "C:/E-commerce-worktrees/ticket-wt27/node_modules/next/dist/bin/next" start -p 3996 & fwd=$!
  node -e "setTimeout(()=>{},120000)" "c:\\e-commerce-worktrees\\ticket-wt27\\node_modules\\next\\dist\\server\\lib\\start-server.js" & srv=$!
  sleep 2
  stop_worktree_servers /c/E-commerce-worktrees/ticket-wt27 >/dev/null
  sleep 1
  kill -0 "$p275" 2>/dev/null && ok "ticket-wt275 untouched by ticket-wt27 cleanup" || bad "prefix collision: ticket-wt275 was stopped"
  kill -0 "$fwd" 2>/dev/null && bad "forward-slash own path missed" || ok "forward-slash own path stopped"
  kill -0 "$srv" 2>/dev/null && bad "next dev start-server child missed" || ok "next dev start-server child stopped"
  kill "$p275" "$fwd" "$srv" 2>/dev/null; wait 2>/dev/null
fi

# 9. A reviewer still revising its report is not stopped: each change restarts the grace.
revising() {
  for i in 1 2 3 4 5; do printf 'VERDICT: PASS\nrevision %s\n' "$i" > "$T/r9.md"; sleep 1; done
}
REVIEW_EXIT_GRACE_SEC=2 REVIEW_TIMEOUT_MIN=5 watch_run "$T/r9.md" revising; rc=$?
[ "$rc" = 0 ] && grep -q 'revision 5' "$T/r9.md" && ok "revising reviewer runs to completion" || bad "revising reviewer stopped (rc=$rc)"

# 10. A non-numeric cap falls back to the default instead of stopping at once.
brief() { sleep 3; }
REVIEW_TIMEOUT_MIN=abc watch_run "$T/none10.md" brief; rc=$?
[ "$rc" = 0 ] && ok "non-numeric REVIEW_TIMEOUT_MIN falls back to the default" || bad "bad cap stopped the reviewer (rc=$rc)"

# 11. codex-review.sh: a Codex run stopped by the cap leaves a blocking note, never an empty report.
P="$T/cx/proj"; W="$T/cx/E-commerce-worktrees/ticket-1"
mkdir -p "$P/scripts" "$P/.builder" "$T/cx/bin"
cp "$ROOT/scripts/codex-review.sh" "$ROOT/scripts/review-watch.sh" "$P/scripts/"
( cd "$P" && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
git clone -q "$P" "$W"
printf '#!/bin/sh\nsleep 600\n' > "$T/cx/bin/codex"; printf '#!/bin/sh\necho issue\n' > "$T/cx/bin/gh"
chmod +x "$T/cx/bin/codex" "$T/cx/bin/gh"
( cd "$P" && PATH="$T/cx/bin:$PATH" REVIEW_TIMEOUT_MIN=0 bash scripts/codex-review.sh 1 >/dev/null 2>&1 )
grep -q '^BLOCKING: the Codex review wrote no result (exit 124, stopped by the review watchdog)' "$P/.builder/codex-review-1.md" 2>/dev/null \
  && ok "capped Codex review writes a blocking note" || bad "capped Codex review left no blocking note"

# run_capped: a session that writes no verdict (plan, build, fix, ship) is stopped at its cap, with its child.
churn() { sleep 300 & echo $! > "$T/child-capped"; wait; }
run_capped 0 churn >/dev/null 2>"$T/err-capped"; rc=$?
grep -q "agent session ran past 0s" "$T/err-capped" && [ "$rc" = 124 ] && ok "a session past its cap is stopped (rc=$rc)" || bad "capped session (rc=$rc) $(cat "$T/err-capped")"
sleep 1
running "$(cat "$T/child-capped")" && bad "child of the capped session still running" || ok "child of the capped session stopped"
finishes() { return 7; }
run_capped 5 finishes; rc=$?
[ "$rc" = 7 ] && ok "a session inside its cap keeps its own status" || bad "session inside its cap (rc=$rc)"

exit "$fail"
