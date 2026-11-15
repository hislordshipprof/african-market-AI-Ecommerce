#!/usr/bin/env bash
# A failed Vitest run passes the gate only when the RPC timeout is its sole problem and no result is missing.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
bad=0

check() { # check <name> <expected exit> <output> [vitest exit code]
  printf '%b' "$3" > "$TMP/out"
  bash "$HERE/vitest-rpc-only.sh" "$TMP/out" "${4:-1}"
  got=$?
  if [ "$got" = "$2" ]; then echo "ok - $1"; else echo "not ok - $1 (exit $got, wanted $2)"; bad=1; fi
}

RPC='⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯\n\nVitest caught 1 unhandled error during the test run.\nThis might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.\n\n⎯⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\n ❯ Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.js:53:10\n ❯ processTimers node:internal/timers:521:7\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n'
GOOD=' Test Files  12 passed (12)\n      Tests  85 passed (85)\n   Start at  16:36:39\n   Duration  524.98s (transform 6.08s)\n'
END='\n\xe2\x80\x89ELIFECYCLE\xe2\x80\x89 Test failed. See above for more details.\n'

check "all accounted for, coloured as on Windows" 0 "$RPC\033[2m Test Files \033[22m \033[1m\033[32m178 passed\033[39m\033[22m\033[90m | \033[33m2 skipped\033[39m (180)\r\n\033[2m      Tests \033[22m \033[1m\033[32m2732 passed\033[39m\033[22m | 4 skipped | 1 todo (2737)\r\n   Duration  524.98s\r\n$END"
check "no skips" 0 "$RPC$GOOD$END"
check "a test failed" 1 "$RPC Test Files  1 failed | 11 passed (12)\n      Tests  1 failed | 84 passed (85)\n   Duration  1s\n"
check "a file failed to load" 1 "$RPC Test Files  1 failed | 11 passed (12)\n      Tests  85 passed (85)\n   Duration  1s\n"
check "a result went missing" 1 "$RPC Test Files  12 passed (12)\n      Tests  84 passed (85)\n   Duration  1s\n"
check "a file went missing" 1 "$RPC Test Files  11 passed (12)\n      Tests  85 passed (85)\n   Duration  1s\n"
check "killed by the step timeout" 1 "$RPC$GOOD$END" 124
check "killed by a signal" 1 "$RPC$GOOD$END" 137
check "teardown failed after the summary" 1 "$RPC$GOOD\nStartup Error\nError: teardown failed\n$END"
check "another unhandled error too" 1 'Vitest caught 2 unhandled errors during the test run.\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\nTypeError: boom\n Test Files  12 passed (12)\n      Tests  85 passed (85)\n   Duration  1s\n'
check "a test logs the phrase to hide a second error" 1 'stdout | diagnostic test\nTimeout calling "onTaskUpdate"\nVitest caught 2 unhandled errors during the test run.\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\nTypeError: boom\n Test Files  12 passed (12)\n      Tests  85 passed (85)\n   Duration  1s\n'
check "no timeout at all" 1 "$GOOD"
check "killed before the summary" 1 "$RPC"
check "zero tests ran" 1 "$RPC Test Files  0 passed (0)\n      Tests  0 passed (0)\n   Duration  1s\n"

exit "$bad"
