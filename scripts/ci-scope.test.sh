#!/usr/bin/env bash
# Tests for scripts/ci-scope.sh. Run: bash scripts/ci-scope.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/ci-scope.sh"
fail=0
check() {
  local want="$1" got; shift
  got=$(printf '%s\n' "$@" | ci_scope)
  if [ "$got" = "$want" ]; then echo "ok   $want: $*"; else echo "FAIL want $want, got $got: $*"; fail=1; fi
}

check docs docs/adr/0020-x.md
check docs README.md CLAUDE.md
check docs screenshots/a.png docs/x.md
check pipeline scripts/ci-local.sh
check pipeline scripts/ci-local.sh docs/agents/builder.md
check tests src/lib/cart/service.test.ts
check tests e2e/cart.spec.ts src/lib/cart/service.test.ts docs/note.md
check full src/lib/cart/service.ts
check full src/lib/cart/service.ts src/lib/cart/service.test.ts
check full scripts/seed-preview.mjs
check full scripts/ci-local.sh src/lib/cart/service.test.ts
check full prisma/schema.prisma
check full package.json
check full e2e/helpers.ts
check full ""

# merge_is_safe, in a throwaway repository. t1m is t1 with main merged in, as merge-ticket.sh does it.
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
(
  cd "$T" && git init -q -b main && git config user.email t@t && git config user.name t
  mkdir src; printf 'a\nb\nc\nd\ne\nf\ng\nh\n' > src/app.ts; printf '1\n' > other.txt; git add .; git commit -qm base
  git checkout -qb t1; sed -i 's/^a$/A/' src/app.ts; git commit -qam change
  git checkout -q main; printf '2\n' > other.txt; git commit -qam main1
  git update-ref refs/remotes/origin/main main
  git checkout -qb t1r t1; git rebase -q main
  git checkout -qb t1m t1; git merge -q --no-edit main >/dev/null
) || { echo "FAIL repo setup"; fail=1; }
cd "$T" || exit 1
merge_is_safe t1 t1m && echo "ok   a clean merge of main is safe" || { echo "FAIL clean merge refused"; fail=1; }
merge_is_safe t1 t1r && echo "ok   a clean rebase is safe" || { echo "FAIL clean rebase refused"; fail=1; }

# Main already has part of the PR (the same line change landed there), so the merge carries less than was tested.
git checkout -q -b v1 main; sed -i 's/^c$/C/; s/^f$/F/' src/app.ts; git commit -qam two-changes
git checkout -q main; sed -i 's/^c$/C/' src/app.ts; git commit -qam part
git update-ref refs/remotes/origin/main main
git checkout -q -b v1m v1; git merge -q --no-edit main >/dev/null
merge_is_safe v1 v1m && { echo "FAIL a merge where main has part of the PR passed"; fail=1; } || echo "ok   main holding part of the PR needs a full run"

git checkout -q -b t1move t1r; mkdir docs; git mv src/app.ts docs/app.md; git commit -qm move
got=$(changed_paths HEAD~1 HEAD | ci_scope)
if [ "$got" = full ]; then echo "ok   moving source into docs is a full run"; else echo "FAIL a move into docs gave $got"; fail=1; fi

git checkout -q -b t1edit t1r; sed -i 's/^h$/H/' src/app.ts; git commit -qam extra
merge_is_safe t1 t1edit && { echo "FAIL a changed patch passed"; fail=1; } || echo "ok   a changed patch needs a full run"

git checkout -q -b u1 main~1; echo x > build.mjs; git add .; git commit -qm tool
git checkout -q -b u1r u1; git rebase -q main
merge_is_safe u1 u1r && { echo "FAIL a change outside src passed"; fail=1; } || echo "ok   a change outside src needs a full run"

git checkout -q main; mkdir -p prisma; echo x > prisma/schema.prisma; git add .; git commit -qm schema
git update-ref refs/remotes/origin/main main
git checkout -q -b t1p t1; git rebase -q main
merge_is_safe t1 t1p && { echo "FAIL a schema change on main passed"; fail=1; } || echo "ok   a schema change on main needs a full run"

git checkout -q main; mkdir -p e2e; echo x > e2e/global-setup.ts; git add .; git commit -qm setup
git update-ref refs/remotes/origin/main main
git checkout -q -b t1s t1p; git rebase -q main
merge_is_safe t1p t1s && { echo "FAIL a test setup change on main passed"; fail=1; } || echo "ok   a test setup change on main needs a full run"

exit "$fail"
