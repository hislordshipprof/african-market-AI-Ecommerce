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
. "$ROOT/scripts/agent-cli.sh"
# Claude keeps the original file name; other engines get their own (their session ids differ).
SESSION_FILE="$ROOT/.builder/session-$N.txt"
[ "$AGENT_ENGINE" = "claude" ] || SESSION_FILE="$ROOT/.builder/session-$N.$AGENT_ENGINE.txt"
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
  need=$(node "$ROOT/scripts/lane-env.mjs" keys "$N" "$ROOT/scripts/ticket-env.txt")
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
# shellcheck disable=SC1091
source "$ROOT/scripts/lane-env.sh"
prepare_lane_env "$N" "$ROOT/.env.local" "$WT/.env.local" "$ROOT/scripts/ticket-env.txt"
cd "$WT"

# Database: each lane gets its own fresh database on the private local Postgres (scripts/local-pg.sh), so builds
# use no Neon at all and run with CI's roles (row-level security enforced). Recreated every run, like CI's test_db.
# LANE_DB=neon keeps the shared dev Neon branch from .env.local instead.
if [ "${LANE_DB:-local}" != "neon" ]; then
  [ -d node_modules ] || pnpm install --frozen-lockfile >/dev/null
  bash "$WT/scripts/lane-db.sh" "t$N" "$WT/.env.local" 2>/dev/null || bash "$ROOT/scripts/lane-db.sh" "t$N" "$WT/.env.local"
fi
DB_RULE="This lane's database is a private local Postgres database (lane_t$N on localhost:5434, CI's roles, already migrated and seeded); .env.local points at it. Never point it at Neon. To reset it, run scripts/lane-db.sh t$N .env.local (or bash $ROOT/scripts/lane-db.sh if this branch lacks it)."

# Risk: money and auth tickets (Stripe or Better Auth keys in ticket-env.txt, or RISK=1) always build at full
# tier and also get the second independent review (owner decision 2026-11-03).
need_keys=$(node "$ROOT/scripts/lane-env.mjs" keys "$N" "$ROOT/scripts/ticket-env.txt")
if [ -z "${RISK:-}" ]; then
  if printf '%s\n' "$need_keys" | grep -qE 'STRIPE|BETTER_AUTH'; then RISK=1; else RISK=0; fi
fi
export RISK

# Tier: full (default) = most capable model at high effort. light = faster model at medium effort, only for
# tests, docs, CSS and copy. Never light for money, auth, RLS/data isolation, migrations, order state or
# external providers.
TIER="${TIER:-full}"
[ "$RISK" = "1" ] && TIER=full
LANE_PORT="${E2E_PORT:-3000}"
# Cap local Playwright browsers per lane (several lanes share this machine).
export E2E_WORKERS="${E2E_WORKERS:-4}"
if [ "$TIER" = "light" ]; then
  MODEL_FLAGS=(--model claude-sonnet-5-5 --effort medium)
else
  MODEL_FLAGS=(--effort high)
fi
REVIEW_RULE="Do NOT run the code-review step on your own work: no agent reviews its own work. When implement reaches its review step, stop there. After you push, an independent reviewer in a separate fresh session reviews the PR (and Codex too for money, auth and external-provider tickets); its findings come back to you as a fix round. Still run the QA pass and every check in the Definition of done yourself."
PORT_RULE="This lane's e2e port is $LANE_PORT: run Playwright with E2E_PORT=$LANE_PORT and never use another lane's port."

RULES="Run headless: never ask the user. Never end your turn while a subagent, background task or review is still running: wait for its result first, because ending the turn ends this headless run. For any finding or choice question, take the option you recommend and post the decision on issue #$N. Follow docs/agents/builder.md (including its mandatory design pass for any UI, its edge-case rules and its test-double rules) and the merge policy in docs/agents/orchestration.md (blocking findings are fixed; non-blocking ones become one follow-up issue). Turn every edge case and required test in the agent brief and its 'Brief review' comment into a test, and meet the brief's Review checklist before you push. Commit and push early so a killed run loses little. Before you report done, meet every item in the Definition of done in docs/agents/builder.md (rebased on origin/main, real integrations exercised with evidence, screenshots and images actually looked at, no unproven pre-existing-failure claims, migrations work on an empty database). Run only the affected e2e specs and unit tests, plus pnpm typecheck and pnpm lint before each push. Never run scripts/ci-local.sh or the whole test suite yourself: after you push, the pipeline runs local-ci once (machine-wide queue, automatic flake retry) in parallel with the independent review, and sends any real failure back to you as a finding. GitHub Actions does not run on your pushes; never add the run-ci label yourself. $REVIEW_RULE $PORT_RULE ${DB_RULE:-} Keep $REPORT updated with: the commit SHA you checked, the QA verdict line, every finding code with how it ended, and the PR URL."

ROLE=build; [ "$TIER" = "light" ] && ROLE=light
save_session() {
  local sid; sid=$(agent_session_id "$LOG"); [ -n "$sid" ] && printf '%s' "$sid" > "$SESSION_FILE"; return 0
}
# A fix round on an engine with no saved session starts fresh, told to rebuild context from the PR.
FRESH_CONTEXT="You are taking over issue #$N in this worktree (branch $BRANCH). Before anything else, read the issue and its comments, the open PR for this branch and its comments, and git log origin/main..HEAD, so you know what was built and decided."

# Fix round in the builder's own session (it knows the code), on findings from someone else.
run_fix() {
  local findings="$1" sid
  sid=$(cat "$SESSION_FILE" 2>/dev/null || true)
  LOG="$ROOT/.builder/logs/ticket-$N-fix-$(date +%Y%m%d-%H%M%S).json"
  local prompt="/supermatt:fix-findings $findings
These findings come from an independent reviewer or from local-ci, not from you. Reproduce each one first (a failing test, or a command showing the failure). If one does not reproduce, say so with the evidence and leave that code alone. Fix the rest test-first. In a fix round run only the unit, integration and e2e specs affected by these findings, plus typecheck and lint; never run the whole suite or scripts/ci-local.sh. Then commit and push to the same PR; the pipeline re-runs local-ci. Do not review your own fix; the independent reviewer re-reviews it. $RULES"
  [ -n "$sid" ] || prompt="$FRESH_CONTEXT
$prompt"
  agent_run "$ROLE" "$LOG" "$prompt" "$sid" || status=$?
  save_session
}

case "$MODE" in
  build)
    PROMPT="/supermatt:implement #$N
Worktree: $WT (branch $BRANCH, based on origin/main). Local preview: pnpm build && pnpm start on http://localhost:$LANE_PORT using .env.local.
If this ticket touches UI, the design pass in docs/agents/builder.md is part of done: the report must include the impeccable critique score and screenshots at 390px and 1440px (light and dark), or the coordinator will reject the PR.
When implement reports the work ready: push the branch and open a PR to main ('Closes #$N'), but do not merge.
${KEYLESS:-}
$RULES"
    agent_run "$ROLE" "$LOG" "$PROMPT" || status=$?
    ;;
  --resume)
    [ -n "$FINDINGS" ] || { echo "--resume needs the finding text"; exit 1; }
    run_fix "$FINDINGS"
    ;;
  --continue)
    SID=$(cat "$SESSION_FILE" 2>/dev/null || true)
    if [ -n "$SID" ]; then agent_run "$ROLE" "$LOG" "Continue where you stopped. $RULES" "$SID" || status=$?
    else agent_run "$ROLE" "$LOG" "$FRESH_CONTEXT Then continue the work to done. $RULES" || status=$?; fi
    ;;
  *) echo "unknown mode $MODE"; exit 1 ;;
esac

# Keep the session id for --resume / --continue.
save_session

# Independent review loop: a fresh session reviews the branch while local-ci runs on the same pushed HEAD
# (in parallel: the builder never runs the full suite). Blocking findings and real CI failures go back to the
# builder; the fix is re-reviewed fresh. At most 2 fix rounds, then the coordinator decides.
# SKIP_REVIEW=1 skips it (e.g. when the coordinator runs the review by hand).
CI_LOCAL="${CI_LOCAL:-$ROOT/scripts/ci-local.sh}"
if [ "${SKIP_REVIEW:-0}" != "1" ] && [ -z "${status:-}" ]; then
  cd "$ROOT"
  for round in 1 2 3; do
    CI_LOG="$ROOT/.builder/logs/ci-local-$N-$(date +%Y%m%d-%H%M%S).log"
    # Own checkout, e2e port and database, so it never collides with the reviewer working in $WT on the lane's
    # port and database. One runner checkout serves every lane: the machine-wide lock runs one suite at a time.
    (cd "$WT" && E2E_PORT="$((LANE_PORT + 50))" CI_DB=ci CI_RUNNER="$(dirname "$ROOT")/E-commerce-worktrees/ci-runner" \
      bash "$CI_LOCAL" > "$CI_LOG" 2>&1) &
    ci_pid=$!
    REVIEW_TICKET="${REVIEW_TICKET:-$ROOT/scripts/review-ticket.sh}"
    verdict=$(E2E_PORT="$LANE_PORT" bash "$REVIEW_TICKET" "$N" | tail -1)
    echo "Independent review $round: $verdict"
    if wait "$ci_pid"; then ci=pass; else ci=fail; fi
    echo "local-ci $round: $ci ($(tail -1 "$CI_LOG"))"
    [ "$verdict" = "VERDICT: PASS" ] && [ "$ci" = pass ] && break
    [ "$round" = "3" ] && { echo "Still blocking after 2 fix rounds; the coordinator decides. See .builder/review-$N.md and $CI_LOG"; break; }
    findings=""
    [ "$verdict" = "VERDICT: PASS" ] || findings="$(cat "$ROOT/.builder/review-$N.md")"
    if [ "$ci" = fail ]; then
      findings="$findings

## local-ci failure (blocking; full log: $CI_LOG)

Test, build and e2e failures already failed twice in a row, so they are not one-off load flakes. If the log says 'local-ci SETUP', the pipeline itself failed (unpushed or uncommitted work, database setup): push your work if that is the cause, otherwise note it in the report and change no code for it.
\`\`\`
$(tail -80 "$CI_LOG")
\`\`\`"
    fi
    cd "$WT"
    run_fix "$findings"
    cd "$ROOT"
    [ -z "${status:-}" ] || break
  done
fi

echo "Run finished (exit ${status:-0}). Log: $LOG"
[ -f "$ROOT/.builder/review-$N.md" ] && head -1 "$ROOT/.builder/review-$N.md"
[ -f "$REPORT" ] && head -40 "$REPORT" || echo "No report written; check the log."
exit "${status:-0}"
