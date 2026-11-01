#!/usr/bin/env bash
# Stage A (build) and Fix rounds. See docs/agents/orchestration.md.
# Usage:
#   scripts/build-ticket.sh <issue>                      # build with /supermatt:implement
#   scripts/build-ticket.sh <issue> --resume "<findings>"  # fix round in the same session
#   scripts/build-ticket.sh <issue> --continue            # resume a killed run
#   NO_KEYS=1 scripts/build-ticket.sh <issue>             # build against fakes; real-key testing later, PR stays unmerged
# Writes: .builder/logs/ticket-<n>-<time>.json, .builder/session-<n>.txt, .builder/report-<n>.md
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"
ROOT="$(git rev-parse --show-toplevel)"
N="${1:?usage: scripts/build-ticket.sh <issue> [--resume \"<findings>\" | --continue]}"
MODE="${2:-build}"
FINDINGS="${3:-}"

cd "$ROOT"
mkdir -p .builder/logs
SESSION_FILE="$ROOT/.builder/session-$N.txt"
REPORT="$ROOT/.builder/report-$N.md"
LOG="$ROOT/.builder/logs/ticket-$N-$(date +%Y%m%d-%H%M%S).json"

if [ "$MODE" = "build" ]; then
  # Preflight 1: open and unblocked.
  state=$(gh issue view "$N" -R "$REPO" --json state --jq .state)
  [ "$state" = "OPEN" ] || { echo "Issue #$N is $state"; exit 1; }
  blockers=$(gh api "repos/$REPO/issues/$N/dependencies/blocked_by" --jq '[.[] | select(.state=="open") | .number] | join(",")')
  [ -z "$blockers" ] || { echo "Issue #$N is blocked by open issues: $blockers"; exit 1; }

  # Preflight 2: planner brief exists (stage T).
  if ! gh issue view "$N" -R "$REPO" --comments --json comments --jq '.comments[].body' | grep -qi "agent brief"; then
    echo "Issue #$N has no agent brief yet. Run scripts/plan-ticket.sh $N first."; exit 3
  fi

  # Preflight 3: required keys present in .env.local (values never printed).
  need=$(awk -v n="$N" '$1==n {for (i=2;i<=NF;i++) print $i}' scripts/ticket-env.txt)
  missing=()
  for k in $need; do grep -Eq "^$k=.+" .env.local 2>/dev/null || missing+=("$k"); done
  if [ ${#missing[@]} -gt 0 ] && [ "${NO_KEYS:-}" != "1" ]; then
    echo "Ticket #$N needs these keys in .env.local first: ${missing[*]} (or NO_KEYS=1 to build against fakes)"; exit 2
  fi
  [ ${#missing[@]} -eq 0 ] || KEYLESS="These keys are not available yet: ${missing[*]}. Build against the provider through a small interface with a fake for tests; unit, integration and e2e tests use the fake. Tests that need the real provider skip with a clear message when the keys are unset. The app must build and start without the keys: read them lazily and fail at call time with a clear error, never at import. Prefix the PR title with '[needs keys]' and list in the PR body exactly what the human must test with real keys. The coordinator will not merge until that testing is done."
fi

# Worktree (created once, reused by fix rounds).
slug=$(gh issue view "$N" -R "$REPO" --json title --jq .title | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g' | cut -c1-40)
BRANCH="ticket-$N-$slug"
WT="${WT:-$(dirname "$ROOT")/E-commerce-worktrees/ticket-$N}"
git fetch -q origin main
[ -d "$WT" ] || git worktree add -q -B "$BRANCH" "$WT" origin/main
cp .env.local "$WT/.env.local"
cd "$WT"

RULES="Run headless: never ask the user. Never end your turn while a subagent, background task or review is still running: wait for its result first, because ending the turn ends this headless run. For any finding or choice question, take the option you recommend and post the decision on issue #$N. Follow docs/agents/builder.md (including its mandatory design pass for any UI) and the merge policy in docs/agents/orchestration.md (blocking findings are fixed; non-blocking ones become one follow-up issue). Commit and push early so a killed run loses little. Before you report done, meet every item in the Definition of done in docs/agents/builder.md (rebased on origin/main, real integrations exercised with evidence, screenshots and images actually looked at, no unproven pre-existing-failure claims, migrations work on an empty database). While iterating, run only the affected e2e specs and unit tests; run the full e2e suite once at the end. Keep $REPORT updated with: the commit SHA you checked, QA and code-review verdict lines, every finding code with how it ended, and the PR URL."

case "$MODE" in
  build)
    PROMPT="/supermatt:implement #$N
Worktree: $WT (branch $BRANCH, based on origin/main). Local preview: pnpm build && pnpm start on http://localhost:3000 using .env.local.
If this ticket touches UI, the design pass in docs/agents/builder.md is part of done: the report must include the impeccable critique score and screenshots at 390px and 1440px (light and dark), or the coordinator will reject the PR.
When implement reports the work ready: push the branch and open a PR to main ('Closes #$N'), but do not merge.
${KEYLESS:-}
$RULES"
    claude -p "$PROMPT" --dangerously-skip-permissions --strict-mcp-config --output-format json < /dev/null > "$LOG" 2>&1 || status=$?
    ;;
  --resume)
    [ -n "$FINDINGS" ] || { echo "--resume needs the finding text"; exit 1; }
    SID=$(cat "$SESSION_FILE")
    PROMPT="/supermatt:fix-findings $FINDINGS
Fix test-first, re-run affected QA, review only the fix diff, commit, push to the same PR. $RULES"
    claude -p --resume "$SID" "$PROMPT" --dangerously-skip-permissions --strict-mcp-config --output-format json < /dev/null > "$LOG" 2>&1 || status=$?
    ;;
  --continue)
    SID=$(cat "$SESSION_FILE")
    claude -p --resume "$SID" "Continue where you stopped. $RULES" --dangerously-skip-permissions --strict-mcp-config --output-format json < /dev/null > "$LOG" 2>&1 || status=$?
    ;;
  *) echo "unknown mode $MODE"; exit 1 ;;
esac

# Keep the session id for --resume / --continue.
node -e 'const fs=require("fs");try{const t=fs.readFileSync(process.argv[1],"utf8");const j=JSON.parse(t.slice(t.indexOf("{")));if(j.session_id)fs.writeFileSync(process.argv[2],j.session_id)}catch(e){}' "$LOG" "$SESSION_FILE"

echo "Run finished (exit ${status:-0}). Log: $LOG"
[ -f "$REPORT" ] && head -40 "$REPORT" || echo "No report written; check the log."
exit "${status:-0}"
