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

# The reviewer's six-chunk case: five big chunks are in the baseline; a small new sixth chunk tips the total over.
# It is not among the 5 largest, so the failure must still name it (and not name the unchanged ones as growth).
mkdir -p "$TMP/six/.next/diagnostics" "$TMP/six/.next/static/chunks"
paths=""
for n in 0 1 2 3 4; do
  head -c $((30000 - n * 1000)) /dev/urandom | base64 > "$TMP/six/.next/static/chunks/unchanged-$n.js"
  paths="$paths\".next/static/chunks/unchanged-$n.js\","
done
six_stats() { printf '[{"route": "/", "firstLoadChunkPaths": [%s]}]\n' "$1" > "$TMP/six/.next/diagnostics/route-bundle-stats.json"; }
six_run() { (cd "$TMP/six" && node "$HERE/js-budget.mjs" --config "$TMP/six.json" "$@") > "$TMP/out" 2>&1; }
six_stats "${paths%,}"
printf '{"route": "/", "budgetBytes": 1000000}\n' > "$TMP/six.json"
six_run --update-baseline; check "--update-baseline succeeds" 0 $?
BASE=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(c.baseline.length+" "+c.baseline.reduce((n,b)=>n+b.bytes,0))' "$TMP/six.json")
if [ "${BASE% *}" = 5 ]; then echo "ok - --update-baseline records the 5 chunks"; else echo "not ok - baseline not recorded: $BASE"; bad=1; fi
six_run --update-baseline --budget $((${BASE#* } + 1000)); check "--update-baseline --budget sets the budget" 0 $?
head -c 6000 /dev/urandom | base64 > "$TMP/six/.next/static/chunks/added-regression.js"
six_stats "${paths}\".next/static/chunks/added-regression.js\""
six_run; check "a small sixth chunk that tips the budget fails" 1 $?
has "failure names the new sixth chunk" "added-regression.js"
has "failure says it is new" "added-regression.js.*(new, +"
has "failure explains hashed names" "content-hashed"
if sed -n '/new or grown/,/largest chunks/p' "$TMP/out" | grep -q "unchanged-"; then echo "not ok - unchanged chunk listed as grown"; cat "$TMP/out"; bad=1; else echo "ok - unchanged chunks are not listed as grown"; fi

exit "$bad"
