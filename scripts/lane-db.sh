#!/usr/bin/env bash
# Give one build lane a fresh database on the private local Postgres (scripts/local-pg.sh), like CI's test_db:
# drop + create lane_<name>, add pg_trgm, migrate, seed, then point <env-file> at it.
# DATABASE_URL, DIRECT_URL and APP_RUNTIME_PASSWORD are replaced. DATABASE_URL_UNPOOLED and
# SEED_PRUNE_R2 are removed so a copied Neon URL or prune opt-in cannot ride along. Values never print.
# Usage: scripts/lane-db.sh <name> <env-file>     e.g. scripts/lane-db.sh t69 ../E-commerce-worktrees/ticket-69/.env.local
# Run from the worktree whose migrations should be applied.
set -euo pipefail
NAME="$1"; ENV_FILE="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/c/Program Files/PostgreSQL/18/bin}"
LANE_PG_PORT="${LANE_PG_PORT:-5434}"
DB="lane_$(echo "$NAME" | tr -c 'a-zA-Z0-9_\n' '_')"

bash "$ROOT/scripts/local-pg.sh" >/dev/null
PGPASSWORD=app_owner "$PGBIN/psql" -w -h localhost -p "$LANE_PG_PORT" -U app_owner -d postgres -qtA -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
PGPASSWORD=app_owner "$PGBIN/psql" -w -h localhost -p "$LANE_PG_PORT" -U app_owner -d "$DB" -qtA -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"

URL="postgresql://app_owner:app_owner@localhost:$LANE_PG_PORT/$DB"
node "$ROOT/scripts/lane-env.mjs" strip "$ENV_FILE" DATABASE_URL DIRECT_URL APP_RUNTIME_PASSWORD DATABASE_URL_UNPOOLED SEED_PRUNE_R2
tmp="$(mktemp)"
{ cat "$ENV_FILE"; echo "DATABASE_URL=$URL"; echo "DIRECT_URL=$URL"; echo "APP_RUNTIME_PASSWORD=app_runtime_ci"; } > "$tmp"
mv "$tmp" "$ENV_FILE"
unset DATABASE_URL_UNPOOLED SEED_PRUNE_R2

# Same steps and test-only seed values as hosted CI. Generate first: the seed must use this checkout's schema.
npx prisma generate >/dev/null
env -u DATABASE_URL_UNPOOLED -u SEED_PRUNE_R2 \
  DATABASE_URL="$URL" DIRECT_URL="$URL" APP_RUNTIME_PASSWORD=app_runtime_ci npx prisma migrate deploy >/dev/null
SEED_TEST_ADMIN=1 SEED_ADMIN_PASSWORD='CiTestPass99!' SEED_ADMIN_TOTP_SECRET=JBSWY3DPEHPK3PXP \
  env -u DATABASE_URL_UNPOOLED -u SEED_PRUNE_R2 \
  DATABASE_URL="$URL" DIRECT_URL="$URL" APP_RUNTIME_PASSWORD=app_runtime_ci \
  BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-ci-e2e-test-secret-do-not-use-in-prod}" npx tsx prisma/seed.ts >/dev/null
echo "lane-db: $DB ready (migrated + seeded); $ENV_FILE now points at it"
