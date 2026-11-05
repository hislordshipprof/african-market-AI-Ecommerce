#!/usr/bin/env bash
# A failed Vitest run passes the gate only when the RPC timeout is its sole problem and no result is missing.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
bad=0

check() { # check <name> <expected exit> <output>
  printf '%b' "$3" > "$TMP/out"
  bash "$HERE/vitest-rpc-only.sh" "$TMP/out"
  got=$?
  if [ "$got" = "$2" ]; then echo "ok - $1"; else echo "not ok - $1 (exit $got, wanted $2)"; bad=1; fi
}

RPC='Vitest caught 1 unhandled error during the test run.\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\n'

check "all accounted for, coloured as on Windows" 0 "$RPC\033[2m Test Files \033[22m \033[1m\033[32m178 passed\033[39m\033[22m\033[90m | \033[33m2 skipped\033[39m (180)\r\n\033[2m      Tests \033[22m \033[1m\033[32m2732 passed\033[39m\033[22m | 4 skipped | 1 todo (2737)\r\n"
check "no skips" 0 "$RPC Test Files  12 passed (12)\n      Tests  85 passed (85)\n"
check "a test failed" 1 "$RPC Test Files  1 failed | 11 passed (12)\n      Tests  1 failed | 84 passed (85)\n"
check "a file failed to load" 1 "$RPC Test Files  1 failed | 11 passed (12)\n      Tests  85 passed (85)\n"
check "a result went missing" 1 "$RPC Test Files  12 passed (12)\n      Tests  84 passed (85)\n"
check "a file went missing" 1 "$RPC Test Files  11 passed (12)\n      Tests  85 passed (85)\n"
check "another unhandled error too" 1 'Vitest caught 2 unhandled errors during the test run.\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\nTypeError: boom\n Test Files  12 passed (12)\n      Tests  85 passed (85)\n'
check "no timeout at all" 1 " Test Files  12 passed (12)\n      Tests  85 passed (85)\n"
check "killed before the summary" 1 "$RPC"
check "zero tests ran" 1 "$RPC Test Files  0 passed (0)\n      Tests  0 passed (0)\n"

exit "$bad"
