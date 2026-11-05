#!/usr/bin/env bash
# Full local-ci on the tip of main. Hosted CI is off, so without this nothing runs the whole suite after a merge,
# and lighter runs on tickets (scripts/ci-scope.sh) have no safety net. merge-ticket.sh starts it every
# CI_MAIN_EVERY merges (default 3). It waits in the machine-wide local-ci queue like any other run.
# Usage: scripts/ci-main.sh
# A failure opens one bug issue. The last checked commit is kept in .builder/ci-main-last.
set -uo pipefail
{
REPO="hislordshipprof/african-market-AI-Ecommerce"
ROOT="$(git rev-parse --show-toplevel)"
WT="$(dirname "$ROOT")/E-commerce-worktrees/main-ci"
LOG="$ROOT/.builder/logs/ci-main-$(date +%Y%m%d-%H%M%S).log"
git -C "$ROOT" fetch -q origin main
SHA=$(git -C "$ROOT" rev-parse origin/main)
[ -d "$WT" ] || git -C "$ROOT" worktree add -q --detach "$WT" "$SHA"
git -C "$WT" checkout -q --force --detach "$SHA"
cp "$ROOT/.env.local" "$WT/.env.local"
cd "$WT" || exit 1
if CI_SCOPE=full CI_DB=main E2E_PORT="${CI_MAIN_PORT:-3400}" CI_RUNNER="$(dirname "$ROOT")/E-commerce-worktrees/ci-runner" \
  bash "$ROOT/scripts/ci-local.sh" > "$LOG" 2>&1; then
  echo "$SHA" > "$ROOT/.builder/ci-main-last"
  echo "ci-main PASSED on $SHA"
  exit 0
fi
echo "ci-main FAILED on $SHA. Log: $LOG"
TITLE="main failed the full local-ci on ${SHA:0:7}"
if [ -z "$(gh issue list -R "$REPO" --state open --search "\"$TITLE\" in:title" --json number --jq '.[0].number // empty')" ]; then
  gh issue create -R "$REPO" --title "$TITLE" --label bug \
    --body "$(printf 'The full run on main failed. Log on the build machine: `%s`\n\n```\n%s\n```\n' "$LOG" "$(tail -30 "$LOG")")" >/dev/null || true
fi
exit 1
}
