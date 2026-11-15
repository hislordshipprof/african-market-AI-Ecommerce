#!/usr/bin/env bash
# The storefront home first-load JS budget check (scripts/js-budget.mjs) fails over budget and names the largest chunks.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
bad=0

# A fake build: route "/" loads a small and a big chunk; route "/cart" loads another one that "/" must not count.
mkdir -p "$TMP/app/.next/diagnostics" "$TMP/app/.next/static/chunks"
head -c 20000 /dev/urandom | base64 > "$TMP/app/.next/static/chunks/small.js"
head -c 90000 /dev/urandom | base64 > "$TMP/app/.next/static/chunks/big.js"
head -c 90000 /dev/urandom | base64 > "$TMP/app/.next/static/chunks/other-route.js"
cat > "$TMP/app/.next/diagnostics/route-bundle-stats.json" <<'JSON'
[
  {"route": "/cart", "firstLoadChunkPaths": [".next/static/chunks/small.js", ".next/static/chunks/other-route.js"]},
  {"route": "/", "firstLoadChunkPaths": [".next/static/chunks/small.js", ".next/static/chunks/big.js"]}
]
JSON
SIZE=$(cat "$TMP/app/.next/static/chunks/small.js" "$TMP/app/.next/static/chunks/big.js" >/dev/null; node -e '
const z=require("zlib"),fs=require("fs");const d=process.argv[1];
console.log(["small","big"].reduce((n,c)=>n+z.gzipSync(fs.readFileSync(d+"/static/chunks/"+c+".js")).length,0))' "$TMP/app/.next")

run() { # run <budget bytes> -> output in $TMP/out, exit code in $?
  printf '{"route": "/", "budgetBytes": %s}\n' "$1" > "$TMP/budget.json"
  (cd "$TMP/app" && node "$HERE/js-budget.mjs" --config "$TMP/budget.json") > "$TMP/out" 2>&1
}
check() { # check <name> <expected exit> <actual exit>
  if [ "$3" = "$2" ]; then echo "ok - $1"; else echo "not ok - $1 (exit $3, wanted $2)"; cat "$TMP/out"; bad=1; fi
}
has() { # has <name> <pattern>
  if grep -q -- "$2" "$TMP/out"; then echo "ok - $1"; else echo "not ok - $1 (no '$2')"; cat "$TMP/out"; bad=1; fi
}

run $((SIZE - 1)); check "fails when the budget is one byte below the size" 1 $?
has "failure prints the size" "size: $SIZE"
has "failure prints the budget" "budget: $((SIZE - 1))"
has "failure names the largest chunk" "big.js"
if grep -q other-route "$TMP/out"; then echo "not ok - another route's chunk was counted"; bad=1; else echo "ok - only the home route's chunks are counted"; fi
run $SIZE; check "passes when the size equals the budget" 0 $?
run $((SIZE + 5000)); check "passes under the budget" 0 $?

printf '{"route": "/missing", "budgetBytes": 1}\n' > "$TMP/budget.json"
(cd "$TMP/app" && node "$HERE/js-budget.mjs" --config "$TMP/budget.json") > "$TMP/out" 2>&1; check "fails when the route is not in the build stats" 1 $?

exit "$bad"
