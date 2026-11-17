#!/usr/bin/env bash
# Tests for scripts/scale-check/run.sh: the #578 seed reaches only a local database, never Neon.
# Run: bash scripts/scale-check.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
# CI exports the lane DATABASE_URL; each case must see only the URLs its env file sets.
unset DATABASE_URL DIRECT_URL
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

F="$T/bin"; mkdir -p "$F"
printf '#!/usr/bin/env bash\necho "$@" >> "%s/psql-calls"\n' "$T" > "$F/psql"; chmod +x "$F/psql"
printf '#!/usr/bin/env bash\necho "$DATABASE_URL $@" >> "%s/npx-calls"\n' "$T" > "$F/npx"; chmod +x "$F/npx"
seed() {
  printf 'DIRECT_URL=%s\n' "$1" > "$T/env"
  rm -f "$T/psql-calls"
  PATH="$F:$PATH" SCALE_CHECK_ENV_FILE="$T/env" bash "$ROOT/scripts/scale-check/run.sh" seed >/dev/null 2>&1
}

seed "postgresql://app_owner:pw@ep-cool-river-123.us-east-2.aws.neon.tech/neondb?sslmode=require"
[ $? -ne 0 ] && [ ! -f "$T/psql-calls" ] && ok "a Neon URL is refused before psql runs" || bad "a Neon URL reached psql"

seed "postgresql://localhost:pw@ep-cool-river-123.neon.tech/neondb"
[ $? -ne 0 ] && [ ! -f "$T/psql-calls" ] && ok "'localhost' as the user name does not pass the check" || bad "a Neon host with user 'localhost' reached psql"

seed ""
[ $? -ne 0 ] && [ ! -f "$T/psql-calls" ] && ok "no database URL is refused" || bad "an empty URL reached psql"

seed "postgresql://app_owner:pw@localhost/lane_t578?host=ep-cool-river-123.neon.tech"
[ $? -ne 0 ] && [ ! -f "$T/psql-calls" ] && ok "a host query parameter cannot point psql past the check" || bad "a ?host= Neon URL reached psql"

# measure connects through DATABASE_URL, so a local DIRECT_URL must not let a Neon DATABASE_URL through.
printf 'DIRECT_URL=%s\nDATABASE_URL=%s\n' "postgresql://app_owner:pw@localhost:5434/lane_t578" \
  "postgresql://app_owner:pw@ep-cool-river-123.us-east-2.aws.neon.tech/neondb?sslmode=require" > "$T/env"
rm -f "$T/npx-calls"
PATH="$F:$PATH" SCALE_CHECK_ENV_FILE="$T/env" bash "$ROOT/scripts/scale-check/run.sh" measure >/dev/null 2>&1
[ $? -ne 0 ] && [ ! -f "$T/npx-calls" ] && ok "a Neon DATABASE_URL beside a local DIRECT_URL is refused" || bad "measure ran with a Neon DATABASE_URL"

printf 'DIRECT_URL=%s\n' "postgresql://app_owner:pw@localhost:5434/lane_t578" > "$T/env"
rm -f "$T/npx-calls"
PATH="$F:$PATH" SCALE_CHECK_ENV_FILE="$T/env" bash "$ROOT/scripts/scale-check/run.sh" measure >/dev/null 2>&1
[ $? -eq 0 ] && grep -q "^postgresql://app_owner:pw@localhost:5434/lane_t578 " "$T/npx-calls" \
  && ok "measure connects to the database the check passed" || bad "measure did not get the checked URL"

seed "postgresql://app_owner:pw@localhost:5434/lane_t578"
[ $? -eq 0 ] && grep -q "seed.sql" "$T/psql-calls" && ok "the local lane database is seeded" || bad "the local lane database was refused"

exit "$fail"
