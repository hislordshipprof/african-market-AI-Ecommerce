#!/usr/bin/env bash
# Private local Postgres for build lanes (zero Neon usage during builds).
# A user-space cluster: no admin rights, no Windows service, separate from any installed Postgres.
# Listens on localhost only. Its roles mirror hosted CI (.github/workflows/ci.yml): app_owner owns the
# databases (not a superuser), and app_runtime is NOBYPASSRLS, so row-level security is enforced like CI.
# All passwords here are test-only values for this local cluster, the same ones CI publishes.
# Usage: scripts/local-pg.sh   (idempotent: initialises once, starts if stopped)
set -euo pipefail
PGBIN="${PGBIN:-/c/Program Files/PostgreSQL/18/bin}"
LANE_PG_PORT="${LANE_PG_PORT:-5434}"
LANE_PG_DATA="${LANE_PG_DATA:-$LOCALAPPDATA/african-markets-pg/data}"
# A path that is already a unix path does not need cygpath. Windows paths still convert.
case "$LANE_PG_DATA" in
  [A-Za-z]:* | *\\*) LANE_PG_DATA="$(cygpath -u "$LANE_PG_DATA" 2>/dev/null || echo "$LANE_PG_DATA")" ;;
esac
export PGPASSWORD=postgres

# Two local-ci slots can get here at once: one initialises and starts the server, the other waits for it.
# A mutex left by a killed run is taken anyway after a minute.
STARTING="$LANE_PG_DATA.starting"
mkdir -p "$(dirname "$LANE_PG_DATA")"
for _ in $(seq 1 60); do mkdir "$STARTING" 2>/dev/null && break; sleep 1; done
trap 'rmdir "$STARTING" 2>/dev/null || true' EXIT

if [ ! -f "$LANE_PG_DATA/PG_VERSION" ]; then
  mkdir -p "$LANE_PG_DATA"
  pw="$(mktemp)"; printf 'postgres\n' > "$pw"
  "$PGBIN/initdb" -D "$LANE_PG_DATA" -U postgres --pwfile="$pw" --auth=scram-sha-256 -E UTF8 --locale=C >/dev/null
  rm -f "$pw"
  {
    echo "port = $LANE_PG_PORT"
    echo "listen_addresses = 'localhost'"
    echo "max_connections = 200"
    echo "shared_buffers = 128MB"
    echo "fsync = off"                 # throwaway test data: speed over durability
    echo "synchronous_commit = off"
    echo "full_page_writes = off"
  } >> "$LANE_PG_DATA/postgresql.conf"
  echo "local-pg: initialised $LANE_PG_DATA"
fi

if ! "$PGBIN/pg_ctl" -D "$LANE_PG_DATA" status >/dev/null 2>&1; then
  # Start fully detached (Start-Process), so the server never holds the caller's stdout/stderr pipes open.
  powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath '$(cygpath -w "$PGBIN/pg_ctl.exe")' -ArgumentList 'start','-D','\"$(cygpath -w "$LANE_PG_DATA")\"','-l','\"$(cygpath -w "$LANE_PG_DATA/server.log")\"'" </dev/null >/dev/null 2>&1
  for _ in $(seq 1 30); do "$PGBIN/pg_isready" -q -h localhost -p "$LANE_PG_PORT" && break; sleep 1; done
  "$PGBIN/pg_isready" -q -h localhost -p "$LANE_PG_PORT" || { echo "local-pg: server did not start; see $LANE_PG_DATA/server.log"; exit 1; }
  echo "local-pg: started on localhost:$LANE_PG_PORT"
fi

"$PGBIN/psql" -w -h localhost -p "$LANE_PG_PORT" -U postgres -d postgres -qtA -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_owner') THEN
    CREATE ROLE app_owner LOGIN PASSWORD 'app_owner' CREATEDB CREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'app_runtime_ci' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
SQL
echo "local-pg: ready on localhost:$LANE_PG_PORT (roles app_owner, app_runtime)"
