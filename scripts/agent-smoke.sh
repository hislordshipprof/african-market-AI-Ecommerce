#!/usr/bin/env bash
# Smoke test for the headless engines in scripts/agent-engine.env. Read-only prompts; no files are changed.
#   build  : a CURSOR_BUILD_MODEL turn, then a resume of the same session (proves fix rounds can continue)
#   review : a REVIEW_ENGINE turn (Claude on the benjamin profile by default) that must open a vendored SuperMatt skill
#   review2: the RISK second reviewer (CURSOR_REVIEW_MODEL)
# Usage: scripts/agent-smoke.sh [build|review|review2|all]   Logs go to .builder/logs/smoke-*.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
. scripts/agent-cli.sh
L="$ROOT/.builder/logs"; mkdir -p "$L"
what="${1:-all}"
rc=0
NOEDIT="Do not edit any files and do not run any commands except reading files you are told to read."

if [ "$what" = build ] || [ "$what" = all ]; then
  agent_run build "$L/smoke-build-1.json" "$NOEDIT Remember the code word PAPAYA-42 and reply with just: noted."
  echo "build turn 1 exit $? (engine $AGENT_ENGINE, model $(_cursor_model build))"
  sid=$(agent_session_id "$L/smoke-build-1.json"); echo "session: ${sid:-none}"
  if [ -n "$sid" ]; then
    agent_run build "$L/smoke-build-2.json" "$NOEDIT What was the code word? Reply with just the word." "$sid"
    echo "build resume exit $?"
    grep -q 'PAPAYA-42' "$L/smoke-build-2.json" && echo "RESUME OK" || { echo "RESUME FAILED"; rc=1; }
  else
    echo "NO SESSION ID"; rc=1
  fi
fi

if [ "$what" = review ] || [ "$what" = all ]; then
  agent_run review "$L/smoke-review.log" "/supermatt:code-review $NOEDIT Do not perform a review. Reply with one line: VERDICT: PASS, then the first markdown heading of that skill file."
  echo "review exit $? (engine $REVIEW_ENGINE)"
  out="$L/smoke-review.log.last.md"; [ -s "$out" ] || out="$L/smoke-review.log"
  tail -c 400 "$out"; echo
  grep -q 'VERDICT: PASS' "$out" && echo "REVIEW OK" || { echo "REVIEW FAILED"; rc=1; }
fi

if [ "$what" = review2 ] || [ "$what" = all ]; then
  agent_run review2 "$L/smoke-review2.json" "$NOEDIT Reply with just: second ok."
  echo "review2 exit $? (model $(_cursor_model review2))"
  grep -q 'second ok' "$L/smoke-review2.json" && echo "REVIEW2 OK" || { echo "REVIEW2 FAILED"; rc=1; }
fi

git status --short
exit $rc
