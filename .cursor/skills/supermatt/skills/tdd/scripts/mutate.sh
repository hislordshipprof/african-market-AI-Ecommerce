#!/bin/sh
# Usage: mutate.sh [-b BUILD] [-t SECONDS] TEST MUTATION...
#
# Applies each mutation on its own, runs BUILD (when given) and then TEST, and
# restores the file before the next one. A mutation file holds the target path
# on its first line, then the exact text to find, a line holding only ====, and
# the text to put in its place. Only the first match is replaced.
#
# Prints one line per mutation file: test-failed (inspect TEST's output), GREEN (TEST passed: no
# test protects that behavior), timeout (TEST ran past SECONDS and was killed),
# broken (BUILD failed, which proves nothing), or missing (the text to find is
# not in the file). SECONDS defaults to five times the unchanged run plus a
# minute. An explicit limit also bounds the unchanged TEST. Failed TEST output
# is printed on stderr with its mutation name.
# Exit 0 means every TEST failed, not that each failed for the intended assertion:
# the caller must verify that evidence before counting a mutation as red.
# Exits 1 if any mutation has another outcome. Exits 2 when BUILD or TEST
# already fails on the unchanged code, or a backup or restore fails. A failed
# restore retains and reports the backup. After a broken mutation, a hint on
# stderr names its usual cause, an unused name.
#
# TEST runs under a perl supervisor that leads a process group of its own, so
# dash, which has no job control without a terminal, gets one too. The group
# is killed whole once TEST exits. A process whose parent died, as a test
# runner's child does when the runner is killed on its own timeout, stays in
# the group, so nothing TEST started outlives it.
set -u

usage() {
  echo "usage: mutate.sh [-b BUILD] [-t SECONDS] TEST MUTATION..." >&2
  exit 2
}

build= limit=
while [ $# -gt 0 ]; do
  case $1 in
  -b) build=$2; shift 2 ;;
  -t) limit=$2; shift 2 ;;
  *) break ;;
  esac
done
case $limit in
*[!0-9]*) usage ;;
esac
[ $# -ge 2 ] || usage
if ! command -v perl > /dev/null 2>&1; then
  echo "mutate.sh: perl is required, to run TEST in a process group of its own" >&2
  exit 2
fi
test=$1
shift

# stop kills TEST's process group, where one runs.
stop() {
  if [ -n "$group" ]; then kill -KILL -"$group" 2> /dev/null; fi
  group=
}

# Restore only a target whose backup succeeded. Preserve recovery files and
# stop on failure, including when called from the exit trap.
restore_target() {
  [ -n "$target" ] || return 0
  if ! cp "$backup" "$target"; then
    echo "mutate.sh: cannot restore $target; backup retained at $backup" >&2
    trap - EXIT
    exit 2
  fi
  target=
}

# cleanup stops TEST, restores the target a mutation left changed, and removes
# the backup only after restoration succeeds.
cleanup() {
  stop
  restore_target
  rm -f "$backup" "$backup.expired" "$backup.output"
}

backup=$(mktemp) || exit 2
target= group=
trap cleanup EXIT
trap 'exit 130' INT TERM

# The supervisor: it leads the group, runs TEST as its child, and at the limit
# (none at 0) marks the timeout and kills TEST. It exits 0 when TEST passed.
supervise='
  my ($limit, $expired) = splice @ARGV, 0, 2;
  setpgrp;
  defined(my $pid = fork) or die "fork: $!";
  exec @ARGV or die "exec: $!" unless $pid;
  $SIG{ALRM} = sub { open my $mark, ">", $expired; kill "KILL", $pid };
  alarm $limit;
  waitpid $pid, 0;
  exit($? ? 1 : 0);
'

# run_test runs TEST, killed at $1 seconds unless that is 0, and sets outcome
# to pass, fail or timeout.
run_test() {
  rm -f "$backup.expired"
  perl -e "$supervise" "$1" "$backup.expired" sh -c "$test" > "$backup.output" 2>&1 &
  group=$!
  if wait "$group" 2> /dev/null; then outcome=pass; else outcome=fail; fi
  stop
  if [ -e "$backup.expired" ]; then outcome=timeout; fi
}

start=$(date +%s)
if ! { [ -z "$build" ] || sh -c "$build"; } > /dev/null 2>&1 || ! { run_test "${limit:-0}" && [ "$outcome" = pass ]; }; then
  echo "mutate.sh: BUILD or TEST fails with no mutation applied, so no red would mean anything: $test" >&2
  exit 2
fi
limit=${limit:-$((($(date +%s) - start) * 5 + 60))}

status=0
for m in "$@"; do
  mutation_target=$(head -n 1 "$m")
  if ! cp "$mutation_target" "$backup"; then
    echo "mutate.sh: cannot back up $mutation_target; no mutation applied" >&2
    exit 2
  fi
  target=$mutation_target
  if ! awk '
    FNR == NR {
      if (FNR == 1) next
      if ($0 == "====" && !sep) { sep = 1; next }
      if (sep) to = (tn++ ? to "\n" : "") $0
      else from = (fn++ ? from "\n" : "") $0
      next
    }
    { text = (n++ ? text "\n" : "") $0 }
    END {
      i = index(text, from)
      if (from == "" || !i) exit 3
      printf "%s%s%s\n", substr(text, 1, i - 1), to, substr(text, i + length(from))
    }' "$m" "$backup" > "$target"; then
    result=missing
  elif [ -n "$build" ] && ! sh -c "$build" > /dev/null 2>&1; then
    result=broken
  else
    run_test "$limit"
    case $outcome in
    pass) result=GREEN ;;
    fail)
      result=test-failed
      printf 'mutate.sh: TEST failed for %s; inspect the cause:\n' "$m" >&2
      cat "$backup.output" >&2
      ;;
    *) result=timeout ;;
    esac
  fi
  restore_target
  echo "$m $result"
  [ "$result" = test-failed ] || status=1
  [ "$result" = broken ] && broken=1
done
if [ -n "${broken-}" ]; then
  echo "mutate.sh: a broken mutation proves nothing. When the build rejects a name the mutation left unused, keep it in use: false && cond in place of a deleted cond." >&2
fi
exit $status
