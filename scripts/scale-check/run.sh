#!/usr/bin/env bash
# #578 scale check on the local lane database: seed | measure | clean. Refuses any database that is not on localhost,
# so the seed can never reach Neon (decision in #578).
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env.local; set +a
url="${DIRECT_URL:-${DATABASE_URL:-}}"
host="$(node -e 'try { console.log(new URL(process.argv[1]).hostname) } catch { console.log("") }' "$url")"
case "$host" in
  localhost|127.0.0.1|::1|\[::1\]) ;;
  *) echo "scale-check: refusing database host '${host:-none}'; the seed runs on the local lane database only" >&2; exit 1 ;;
esac
case "${1:-}" in
  seed) psql "$url" -f scripts/scale-check/seed.sql ;;
  clean) psql "$url" -f scripts/scale-check/clean.sql && psql "$url" -c 'ANALYZE' ;;
  measure) NODE_ENV=test npx tsx scripts/scale-check/measure.ts "${@:2}" ;;
  *) echo "usage: scripts/scale-check/run.sh seed|measure|clean" >&2; exit 2 ;;
esac
