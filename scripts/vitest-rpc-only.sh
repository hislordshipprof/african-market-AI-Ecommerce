#!/usr/bin/env bash
# Usage: vitest-rpc-only.sh <vitest-output-file>
# Exit 0 only when a failed Vitest run was nothing but the worker RPC timeout ("Timeout calling onTaskUpdate"):
# every unhandled error is that timeout, and every test and test file is accounted for as passed, skipped or todo.
# A lost result would leave the counts short of the total, so anything unproved exits 1 and stays a failure.
set -u
OUT="$(sed 's/\x1b\[[0-9;]*m//g' "$1" | tr -d '\r')"

count() { # count <summary label> <word>: that word's number on the summary line, 0 when absent.
  printf '%s\n' "$OUT" | grep -E "^ *$1 " | tail -1 | grep -oE "[0-9]+ $2" | grep -oE '[0-9]+' | head -1 | grep . || echo 0
}
total() { # total <summary label>: the bracketed total on the summary line.
  printf '%s\n' "$OUT" | grep -E "^ *$1 " | tail -1 | grep -oE '\([0-9]+\)' | tr -d '()'
}

timeouts="$(printf '%s\n' "$OUT" | grep -c 'Timeout calling "onTaskUpdate"')"
[ "$timeouts" -gt 0 ] || exit 1

caught="$(printf '%s\n' "$OUT" | grep -oE 'Vitest caught [0-9]+ unhandled error' | tail -1 | grep -oE '[0-9]+')"
[ "${caught:-0}" = "$timeouts" ] || exit 1

for label in "Test Files" "Tests"; do
  want="$(total "$label")"
  [ -n "$want" ] && [ "$want" -gt 0 ] || exit 1
  [ "$(count "$label" failed)" = 0 ] || exit 1
  sum=$(( $(count "$label" passed) + $(count "$label" skipped) + $(count "$label" todo) ))
  [ "$sum" = "$want" ] || exit 1
done
exit 0
