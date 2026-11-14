#!/usr/bin/env bash
# Tests for scripts/local-pg.sh with fake Postgres tools. Run: bash scripts/local-pg.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# Fakes: the server counts as running once a start has finished; a start takes a second and is counted.
F="$T/bin"; mkdir -p "$F" "$T/data"; touch "$T/data/PG_VERSION"
fake() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$F/$1"; chmod +x "$F/$1"; }
fake pg_ctl "[ -f '$T/running' ]"
fake pg_isready "[ -f '$T/running' ]"
fake psql 'cat >/dev/null'
fake cygpath 'echo "$2"'
fake powershell "sleep 1; echo start >> '$T/starts'; touch '$T/running'"
run() { PGBIN="$F" PATH="$F:$PATH" LANE_PG_DATA="$T/data" bash "$ROOT/scripts/local-pg.sh" >/dev/null 2>&1; }

# Two local-ci slots reach their database step together while the server is down: one starts it, both go on.
run & a=$!; run & b=$!
wait "$a"; ra=$?; wait "$b"; rb=$?
[ "$ra" = 0 ] && [ "$rb" = 0 ] && ok "both runs find the server ready" || bad "a run failed ($ra, $rb)"
[ "$(wc -l < "$T/starts" 2>/dev/null | tr -d ' ')" = 1 ] && ok "the server is started once" \
  || bad "the server was started $(wc -l < "$T/starts" | tr -d ' ') times"

# Already running: nothing is started.
run && [ "$(wc -l < "$T/starts" | tr -d ' ')" = 1 ] && ok "a running server is not started again" || bad "a running server was started again"

exit "$fail"
