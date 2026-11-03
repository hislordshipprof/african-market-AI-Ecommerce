#!/usr/bin/env bash
# Independent review of a ticket's branch, in a FRESH session that never saw the builder's reasoning.
# No agent reviews its own work: build-ticket.sh calls this after every build and fix round.
# Usage: scripts/review-ticket.sh <issue>
# Writes: .builder/review-<n>.md. Its first line is "VERDICT: PASS" or "VERDICT: BLOCKING".
# RISK=1 (set automatically by build-ticket.sh for money, auth and external-provider tickets) also runs the
# Codex review and merges its findings into the same file. With REVIEW_ENGINE=codex the main review is
# Codex and the RISK second review is CURSOR_REVIEW_MODEL on AGENT_ENGINE.
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"
ROOT="$(git rev-parse --show-toplevel)"
N="${1:?usage: scripts/review-ticket.sh <issue>}"
. "$ROOT/scripts/agent-cli.sh"
WT="$(dirname "$ROOT")/E-commerce-worktrees/ticket-$N"
OUT="$ROOT/.builder/review-$N.md"
LOG="$ROOT/.builder/logs/review-$N-$(date +%Y%m%d-%H%M%S).json"
LANE_PORT="${E2E_PORT:-3000}"
[ -d "$WT" ] || { echo "No worktree for ticket $N at $WT"; exit 1; }
mkdir -p "$ROOT/.builder/logs"
rm -f "$OUT"

cd "$WT"
git fetch -q origin main

PROMPT="/supermatt:code-review since origin/main, for issue #$N.
You are an independent reviewer. You did not write this code, and you have not seen the builder's reasoning; judge only the diff (git diff origin/main...HEAD), the issue #$N with its agent brief (gh issue view $N --comments), and the project rules (CLAUDE.md, GLOSSARY.md, docs/adr/, docs/spec/platform-spec.md, docs/agents/builder.md).
Do not modify, commit or push anything.
Hunt for what breaks in production:
- every acceptance criterion: met or not, with evidence;
- each edge case listed in the agent brief, and the ones it missed: retries and duplicates, failure partway through (an external call succeeds then the DB write fails), concurrency, cross-store access, timezones and overnight hours, empty and maximum inputs, money rounding and amounts above the authorization;
- how each external provider actually works (read its official docs when unsure), for example which Stripe account owns a destination charge;
- whether the tests would catch a regression: test doubles must enforce the provider's real rules, and each external path needs a real sandbox test.
Reproduce what you can: run the affected unit, integration and sandbox tests yourself, and the affected e2e specs with E2E_PORT=$LANE_PORT; stop any server you start.
Write your result to $OUT. The FIRST line must be exactly 'VERDICT: PASS' (no blocking findings) or 'VERDICT: BLOCKING'. Then list every finding with: severity (blocking = security, data isolation, money or data loss, a failed acceptance criterion, or broken build/CI; otherwise non-blocking), file:line, the concrete failure scenario, and how to reproduce it."

agent_run review "$LOG" "$PROMPT" || true
# Codex may return the review as its final message instead of writing the file.
if [ ! -s "$OUT" ] && grep -q '^VERDICT: ' "$LOG.last.md" 2>/dev/null; then
  sed -n '/^VERDICT: /,$p' "$LOG.last.md" > "$OUT"
fi
[ -s "$OUT" ] || printf 'VERDICT: BLOCKING\nThe independent review wrote no result; see %s\n' "$LOG" > "$OUT"

if [ "${RISK:-0}" = "1" ] && [ "$REVIEW_ENGINE" = codex ]; then
  # Codex already did the main review: the second RISK reviewer is another family on AGENT_ENGINE.
  OUT2="$ROOT/.builder/review-$N.second.md"; rm -f "$OUT2"
  agent_run review2 "$LOG.second.json" "${PROMPT//$OUT/$OUT2}" || true
  [ -s "$OUT2" ] || printf 'VERDICT: BLOCKING\nThe second review wrote no result; see %s\n' "$LOG.second.json" > "$OUT2"
  head -1 "$OUT2" | grep -q '^VERDICT: PASS' || sed -i '1s/^VERDICT: PASS/VERDICT: BLOCKING/' "$OUT"
  printf '\n\n## Second review (independent, %s)\n\n' "${CURSOR_REVIEW_MODEL:-$AGENT_ENGINE}" >> "$OUT"
  cat "$OUT2" >> "$OUT"
elif [ "${RISK:-0}" = "1" ]; then
  cd "$ROOT"
  bash scripts/codex-review.sh "$N" >/dev/null 2>&1 || true
  CODEX="$ROOT/.builder/codex-review-$N.md"
  if [ -s "$CODEX" ]; then
    if ! grep -q "NO BLOCKING FINDINGS" "$CODEX"; then
      sed -i '1s/^VERDICT: PASS/VERDICT: BLOCKING/' "$OUT"
    fi
    printf '\n\n## Codex review (independent, gpt-6-astra medium)\n\n' >> "$OUT"
    cat "$CODEX" >> "$OUT"
  fi
fi

head -1 "$OUT"
