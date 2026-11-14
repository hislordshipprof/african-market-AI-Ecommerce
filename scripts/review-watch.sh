#!/usr/bin/env bash
# Review watchdog, sourced by review-ticket.sh.
# On 2026-11-05 a Codex reviewer wrote its verdict and then never exited, twice. Each time the lane froze for
# hours, and a `next start` it had launched kept holding a port, which broke the next CI run. Wrapping the
# reviewer in watch_run stops it, with its whole process tree:
# - when its verdict has been written and it has not exited within REVIEW_EXIT_GRACE_SEC (default 300 s);
# - or when it runs longer than REVIEW_TIMEOUT_MIN in total (default 120 min).
# Afterwards, stop_worktree_servers stops any Next.js server still running from the ticket's worktree.

# file_mtime <file>: last write, in epoch seconds. GNU stat, then BSD stat (macOS).
file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

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
  # Non-numeric settings fall back to the defaults, so a typo never stops every reviewer at once.
  local grace="${REVIEW_EXIT_GRACE_SEC:-300}" mins="${REVIEW_TIMEOUT_MIN:-120}" poll="${REVIEW_WATCH_POLL_SEC:-15}"
  [[ "$grace" =~ ^[0-9]+$ ]] || grace=300
  [[ "$mins" =~ ^[0-9]+$ ]] || mins=120
  [[ "$poll" =~ ^[1-9][0-9]*$ ]] || poll=15
  local cap=$(( mins * 60 )) start=$SECONDS done_at="" seen="" now stopped=0 rc=0
  "$@" &
  local pid=$!
  # The job table, not kill -0, decides whether the reviewer is alive: a reaped pid reused by another
  # process must never be stopped.
  _alive() { jobs -rp | grep -qx "$pid"; }
  while _alive; do
    sleep "$poll"
    _alive || break
    if [ -s "$result" ] && head -1 "$result" | grep -qE '^\**VERDICT: '; then
      # The grace restarts whenever the file changes, so a reviewer still revising its report is left alone.
      now=$(stat -c '%Y:%s' "$result" 2>/dev/null || stat -f '%m:%z' "$result" 2>/dev/null || echo x)
      if [ "$now" != "$seen" ]; then seen="$now"; done_at=$SECONDS; fi
    fi
    if [ -n "$done_at" ] && [ $((SECONDS - done_at)) -ge "$grace" ]; then
      echo "review watchdog: verdict written ${grace}s ago but the reviewer has not exited; stopping it" >&2
      kill_tree "$pid"; stopped=1; break
    fi
    if [ $((SECONDS - start)) -ge "$cap" ]; then
      echo "review watchdog: ${WATCH_WHAT:-reviewer} ran past ${cap}s; stopping it" >&2
      kill_tree "$pid"; stopped=1; break
    fi
  done
  wait "$pid" 2>/dev/null || rc=$?
  [ "$stopped" = 1 ] && return 124
  return "$rc"
}

# run_capped <minutes> <command...>
# The same watchdog for sessions that write no verdict (plan, build, fix, ship): only the total cap applies.
# Until 2026-11-09 only reviews had a cap, and builders on fix rounds ran for 5 and 8 hours.
# Returns the command's exit status, or 124 when it was stopped at the cap.
run_capped() {
  local mins="$1"; shift
  WATCH_WHAT="${WATCH_WHAT:-agent session}" REVIEW_TIMEOUT_MIN="$mins" watch_run "" "$@"
}

# stop_worktree_servers <worktree>
# Stops `next start` / `next dev` processes whose command line contains the worktree path. Only the ticket's
# own worktree is matched, so other lanes, ci-runner and the main dev server are never touched.
stop_worktree_servers() {
  local wt="$1" wtwin
  command -v powershell >/dev/null 2>&1 || {
    pkill -f "$wt/.*next.*(start|dev)" 2>/dev/null || true
    return 0
  }
  wtwin=$(cygpath -w "$wt" 2>/dev/null || echo "$wt")
  # The path must be followed by a separator, so ticket-24 never matches ticket-246. Slashes and case are
  # normalised, so C:/… and c:\… forms match too. `next dev` forks start-server.js, which holds the port, so
  # that is matched as well, and each match is stopped with its tree (taskkill /T).
  WT_WIN="$wtwin" powershell -NoProfile -NonInteractive -Command '
    $wt = ($env:WT_WIN -replace "/", "\").TrimEnd("\").ToLowerInvariant() + "\"
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -and
        ($_.CommandLine -replace "/", "\").ToLowerInvariant().Contains($wt) -and
        ($_.CommandLine -match "next.*\s(start|dev)(\s|$)" -or $_.CommandLine -match "next[\\/]dist[\\/]server[\\/]lib[\\/]start-server\.js")
      } |
      ForEach-Object { & taskkill /PID $_.ProcessId /T /F *> $null; "stopped stray server $($_.ProcessId)" }
  ' 2>/dev/null || true
}
