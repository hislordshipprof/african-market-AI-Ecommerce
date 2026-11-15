#!/usr/bin/env bash
# Usage: vitest-rpc-only.sh <vitest-output-file> <vitest-exit-code>
# Exit 0 only when a failed Vitest run was nothing but the worker RPC timeout ("Timeout calling onTaskUpdate").
# Vitest exited 1 by itself, not by a timeout or a signal. Its final summary is the last thing it printed, so nothing
# failed in teardown after it. Every unhandled error is that timeout. Every test and test file is passed, skipped or
# todo. Vitest 3.2.7 keeps a failed result when the RPC times out, and a lost update leaves the counts short of the
# total, so a real failure cannot satisfy these checks. Anything unproved exits 1 and stays a failure.
set -u
[ "${2:-}" = 1 ] || exit 1
OUT="$(sed 's/\x1b\[[0-9;]*m//g' "$1" | tr -d '\r')"

line_of() { printf '%s\n' "$OUT" | grep -nE "$1" | tail -1 | cut -d: -f1; }
count() { # count <summary line> <word>: that word's number on the summary line, 0 when absent.
  printf '%s\n' "$1" | grep -oE "[0-9]+ $2" | grep -oE '[0-9]+' | head -1 | grep . || echo 0
}

caught_at="$(line_of 'Vitest caught [0-9]+ unhandled error')"
files_at="$(line_of '^ *Test Files ')"
tests_at="$(line_of '^ *Tests ')"
duration_at="$(line_of '^ *Duration ')"
[ -n "$caught_at" ] && [ -n "$files_at" ] && [ -n "$tests_at" ] && [ -n "$duration_at" ] || exit 1
[ "$caught_at" -lt "$files_at" ] && [ "$files_at" -lt "$tests_at" ] && [ "$tests_at" -lt "$duration_at" ] || exit 1

# After the summary only the package manager's own closing line may follow.
if printf '%s\n' "$OUT" | tail -n "+$((duration_at + 1))" | grep -vE '^[[:space:]]*$|ELIFECYCLE' | grep -q .; then
  exit 1
fi

caught="$(printf '%s\n' "$OUT" | sed -n "${caught_at}p" | grep -oE 'caught [0-9]+' | grep -oE '[0-9]+')"
section="$(printf '%s\n' "$OUT" | sed -n "$((caught_at + 1)),$((files_at - 1))p")"
timeouts="$(printf '%s\n' "$section" | grep -cE '^Error: \[vitest-worker\]: Timeout calling "onTaskUpdate"$')"
[ "$timeouts" -gt 0 ] && [ "$timeouts" = "$caught" ] || exit 1
# Every other line of the error section must be Vitest's own wording, a rule or a stack frame.
if printf '%s\n' "$section" \
  | grep -vE '^Error: \[vitest-worker\]: Timeout calling "onTaskUpdate"$|^[[:space:]]*$|^This might cause false positive tests|^[⎯ ]*(Unhandled Errors?)?[⎯ ]*$|^ *(❯|>) ' \
  | grep -q .; then
  exit 1
fi

for at in "$files_at" "$tests_at"; do
  summary="$(printf '%s\n' "$OUT" | sed -n "${at}p")"
  want="$(printf '%s\n' "$summary" | grep -oE '\([0-9]+\)' | tr -d '()')"
  [ -n "$want" ] && [ "$want" -gt 0 ] || exit 1
  [ "$(count "$summary" failed)" = 0 ] || exit 1
  sum=$(( $(count "$summary" passed) + $(count "$summary" skipped) + $(count "$summary" todo) ))
  [ "$sum" = "$want" ] || exit 1
done
exit 0
