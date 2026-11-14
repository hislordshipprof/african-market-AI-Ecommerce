#!/usr/bin/env bash
# Tests for .githooks/pre-push, in a throwaway repository. Run: bash scripts/pre-push.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

git init -q --bare -b main "$T/remote.git"
git init -q -b main "$T/r"; cd "$T/r" || exit 1
git config user.email t@t; git config user.name t
mkdir .githooks; cp "$ROOT/.githooks/pre-push" .githooks/ 2>/dev/null
git config core.hooksPath .githooks
git commit -q --allow-empty -m init; git remote add origin "$T/remote.git"
git -c core.hooksPath=/dev/null push -q origin main

git commit -q --allow-empty -m next
git push -q origin main 2>/dev/null && bad "a push to main went through" || ok "a push to main is refused"
git push -q origin HEAD:refs/heads/main 2>/dev/null && bad "a push of HEAD to main went through" || ok "a push of HEAD to main is refused"
[ "$(git -C "$T/remote.git" rev-list --count main)" = 1 ] && ok "main on the remote is unchanged" || bad "main on the remote moved"
ALLOW_MAIN_PUSH=1 git push -q origin main 2>/dev/null && [ "$(git -C "$T/remote.git" rev-list --count main)" = 2 ] \
  && ok "the owner's ALLOW_MAIN_PUSH=1 lets a push to main through" || bad "ALLOW_MAIN_PUSH=1 was refused"
git push -q origin HEAD:refs/heads/ticket-9-x 2>/dev/null && ok "a push to a ticket branch goes through" || bad "a push to a ticket branch was refused"
git push -q origin HEAD:refs/heads/main-notes 2>/dev/null && ok "a branch whose name starts with main is not main" || bad "main-notes was refused"

exit "$fail"
