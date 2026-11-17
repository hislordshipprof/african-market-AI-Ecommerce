#!/usr/bin/env bash
# #578 scale check on the local lane database: seed | measure | clean. Refuses any database that is not on localhost,
# so the seed can never reach Neon (decision in #578).
set -euo pipefail
cd "$(dirname "$0")/../.."
env_file="${SCALE_CHECK_ENV_FILE:-.env.local}"
if [ -f "$env_file" ]; then set -a; source "$env_file"; set +a; fi
url="${DIRECT_URL:-${DATABASE_URL:-}}"
# Both URLs are checked: psql uses the first, measure's Prisma client reads DATABASE_URL. libpq's host, hostaddr and
# service parameters override the URL's host, so they are refused too.
for u in "$url" ${DATABASE_URL:+"$DATABASE_URL"}; do
  host="$(node -e 'try { const u = new URL(process.argv[1]); console.log(["host", "hostaddr", "service"].some((k) => u.searchParams.has(k)) ? "" : u.hostname) } catch { console.log("") }' "$u")"
  case "$host" in
    localhost|127.0.0.1|::1|\[::1\]) ;;
    *) echo "scale-check: refusing database host '${host:-none}'; the seed runs on the local lane database only" >&2; exit 1 ;;
  esac
done
tables="copilot_weekly_reports, copilot_digests, substitution_requests, issue_reports, refund_requests, delivery_events,
  deliveries, stock_events, order_lines, orders, customers, copilot_alerts, listing_variants, listings, master_products,
  audit_logs, notification_logs, store_subscriptions, store_memberships, stores, users"
case "${1:-}" in
  seed) psql "$url" -f scripts/scale-check/seed.sql ;;
  # VACUUM FULL gives back the space the seed took: a bloated table or index changes the plans other tests check.
  clean) psql "$url" -f scripts/scale-check/clean.sql && psql "$url" -c "VACUUM (FULL, ANALYZE) $tables" ;;
  measure) DATABASE_URL="$url" NODE_ENV=test npx tsx scripts/scale-check/measure.ts "${@:2}" ;;
  *) echo "usage: scripts/scale-check/run.sh seed|measure|clean" >&2; exit 2 ;;
esac
