#!/usr/bin/env bash
# Review watchdog, sourced by review-ticket.sh.
# On 2026-11-05 a Codex reviewer wrote its verdict and then never exited, twice. Each time the lane froze for
# hours, and a `next start` it had launched kept holding a port, which broke the next CI run. Wrapping the
# reviewer in watch_run stops it, with its whole process tree:
# - when its verdict has been written and it has not exited within REVIEW_EXIT_GRACE_SEC (default 300 s);
# - or when it runs longer than REVIEW_TIMEOUT_MIN in total (default 120 min).
# Afterwards, stop_worktree_servers stops any Next.js server still running from the ticket's worktree.

# Lists every descendant pid of a process (children first, deepest last), from ps's PID/PPID columns.
# Git Bash's ps tracks msys and native processes it started; on Linux ps -o is used.
_descendants() {
  local table
  if [ -r /proc/self/winpid ]; then
    table=$(ps -e 2>/dev/null | awk 'NR>1 {sub(/^[^0-9]*/, ""); print $1, $2}')
  else
    table=$(ps -e -o pid=,ppid= 2>/dev/null)
  fi
  local queue="$1" out="" p c
  while [ -n "$queue" ]; do
    set -- $queue; p=$1; shift; queue="$*"
    for c in $(awk -v pp="$p" '$2==pp {print $1}' <<<"$table"); do
      out="$out $c"; queue="$queue $c"
    done
  done
  echo "$out"
}

# Stops a process and all its descendants. Each process found through ps is stopped; on Windows each one's
# Windows pid also gets taskkill /T, which reaches native grandchildren (codex.exe under node) ps cannot see.
kill_tree() {
  local root="$1" p wp all
  all="$(_descendants "$root") $root"
  for p in $all; do
    if [ -r "/proc/$p/winpid" ] && command -v taskkill >/dev/null 2>&1; then
      wp=$(cat "/proc/$p/winpid" 2>/dev/null || true)
      [ -n "$wp" ] && taskkill //PID "$wp" //T //F >/dev/null 2>&1
    fi
    kill -KILL "$p" 2>/dev/null
  done
  return 0
}

# watch_run <result-file> <command...>
# Runs the command in the background and watches it. A result file whose first line is a VERDICT line counts
# as "verdict written". Returns the command's exit status, or 124 when the watchdog stopped it.
watch_run() {
  local result="$1"; shift
  local grace="${REVIEW_EXIT_GRACE_SEC:-300}" cap=$(( ${REVIEW_TIMEOUT_MIN:-120} * 60 ))
  local poll="${REVIEW_WATCH_POLL_SEC:-15}" start=$SECONDS done_at="" stopped=0 rc=0
  "$@" &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$poll"
    kill -0 "$pid" 2>/dev/null || break
    if [ -z "$done_at" ] && [ -s "$result" ] && head -1 "$result" | grep -qE '^\**VERDICT: '; then
      done_at=$SECONDS
    fi
    if [ -n "$done_at" ] && [ $((SECONDS - done_at)) -ge "$grace" ]; then
      echo "review watchdog: verdict written ${grace}s ago but the reviewer has not exited; stopping it" >&2
      kill_tree "$pid"; stopped=1; break
    fi
    if [ $((SECONDS - start)) -ge "$cap" ]; then
      echo "review watchdog: reviewer ran past ${cap}s; stopping it" >&2
      kill_tree "$pid"; stopped=1; break
    fi
  done
  wait "$pid" 2>/dev/null || rc=$?
  [ "$stopped" = 1 ] && return 124
  return "$rc"
}

# stop_worktree_servers <worktree>
# Stops `next start` / `next dev` processes whose command line contains the worktree path. Only the ticket's
# own worktree is matched, so other lanes, ci-runner and the main dev server are never touched.
stop_worktree_servers() {
  local wt="$1" wtwin
  command -v powershell >/dev/null 2>&1 || {
    pkill -f "$wt.*next.*(start|dev)" 2>/dev/null || true
    return 0
  }
  wtwin=$(cygpath -w "$wt" 2>/dev/null || echo "$wt")
  WT_WIN="$wtwin" powershell -NoProfile -NonInteractive -Command '
    $wt = $env:WT_WIN
    Get-CimInstance Win32_Process |
      Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine.Contains($wt) -and $_.CommandLine -match "next.*\s(start|dev)(\s|$)" } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; "stopped stray server $($_.ProcessId)" } catch {} }
  ' 2>/dev/null || true
}
