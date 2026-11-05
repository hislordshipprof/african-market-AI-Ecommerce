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
. "$ROOT/scripts/review-watch.sh"
WT="$(dirname "$ROOT")/E-commerce-worktrees/ticket-$N"
OUT="$ROOT/.builder/review-$N.md"
LOG="$ROOT/.builder/logs/review-$N-$(date +%Y%m%d-%H%M%S).json"
LANE_PORT="${E2E_PORT:-3000}"
[ -d "$WT" ] || { echo "No worktree for ticket $N at $WT"; exit 1; }
mkdir -p "$ROOT/.builder/logs"
rm -f "$OUT"
# A sandboxed Codex can only write inside the worktree, so it writes there and the file is moved after.
TARGET="$OUT"
if [ "$REVIEW_ENGINE" = codex ]; then
  TARGET="$WT/.builder/review-$N.md"; mkdir -p "$WT/.builder"; rm -f "$TARGET"
fi

# Review round for this ticket (1 = first review). From round 3 on, only real blockers block.
# (grep -c exits 1 on zero matches, so the count is guarded: under set -e a bare pipeline would end the script.)
PRIOR=$(ls "$ROOT"/.builder/logs/review-"$N"-*.json 2>/dev/null | grep -vc '\.second\.json$' || true)
ROUND="${REVIEW_ROUND:-$(( ${PRIOR:-0} + 1 ))}"
[ "$ROUND" -ge 1 ] 2>/dev/null || ROUND=1
if [ "$ROUND" -ge 3 ]; then
  ROUND_RULE="This is review round $ROUND. From round 3 on, a finding is blocking ONLY if it is a demonstrated security or secret exposure, a per-store isolation break, money or data loss, an acceptance criterion observed failing, or a broken build or CI. Weak, missing or flaky tests, doc drift, duplication, design tokens and anything outside the brief are non-blocking: list them for the follow-up issue."
else
  ROUND_RULE="This is review round $ROUND. Missing or vacuous tests are blocking only for the brief's Required tests (including its 'Brief review' comment); other test-strength findings are non-blocking. Never ask for a test per edge case or per input: the owner's rule is only necessary tests (docs/agents/builder.md, 'Which tests to write'). Tests that break that rule are a non-blocking finding."
fi

cd "$WT"
git fetch -q origin main

PROMPT="/supermatt:code-review since origin/main, for issue #$N.
You are an independent reviewer. You did not write this code, and you have not seen the builder's reasoning; judge only the diff (git diff origin/main...HEAD), the issue #$N with its agent brief (gh issue view $N --comments), and the project rules (CLAUDE.md, GLOSSARY.md, docs/adr/, docs/spec/platform-spec.md, docs/agents/builder.md).
Do not modify, commit or push anything.
Hunt for what breaks in production:
- every acceptance criterion: met or not, with evidence;
- each edge case listed in the agent brief, and the ones it missed: retries and duplicates, failure partway through (an external call succeeds then the DB write fails), concurrency, cross-store access, timezones and overnight hours, empty and maximum inputs, money rounding and amounts above the authorization;
- how each external provider actually works (read its official docs when unsure), for example which Stripe account owns a destination charge;
- whether the necessary tests would catch a regression: test doubles must enforce the provider's real rules, and each external path needs a real sandbox test. Judge test helpers by what real inputs produce, not by hypothetical input.
$ROUND_RULE
Reproduce what you can: run the affected unit, integration and sandbox tests yourself, and the affected e2e specs with E2E_PORT=$LANE_PORT; stop any server you start.
Write your result to $TARGET. The FIRST line must be exactly 'VERDICT: PASS' (no blocking findings) or 'VERDICT: BLOCKING'. Then list every finding with: severity (blocking = security, data isolation, money or data loss, a failed acceptance criterion, or broken build/CI; otherwise non-blocking), file:line, the concrete failure scenario, and how to reproduce it."

# The watchdog stops a reviewer that wrote its verdict but never exited, or ran too long (review-watch.sh).
watch_run "$TARGET" agent_run review "$LOG" "$PROMPT" || true
stop_worktree_servers "$WT"
if [ "$TARGET" != "$OUT" ] && [ -s "$TARGET" ]; then mv -f "$TARGET" "$OUT"; fi
# Codex may return the review as its final message instead of writing the file (often as **VERDICT: X**).
if [ ! -s "$OUT" ] && grep -qE '^\**VERDICT: ' "$LOG.last.md" 2>/dev/null; then
  sed -n '/^\**VERDICT: /,$p' "$LOG.last.md" | sed '1s/\*//g' > "$OUT"
fi
[ -s "$OUT" ] && sed -i '1s/\*//g' "$OUT"
[ -s "$OUT" ] || printf 'VERDICT: BLOCKING\nThe independent review wrote no result; see %s\n' "$LOG" > "$OUT"

if [ "${RISK:-0}" = "1" ] && [ "$REVIEW_ENGINE" = codex ]; then
  # Codex already did the main review: the second RISK reviewer is another family on AGENT_ENGINE.
  OUT2="$ROOT/.builder/review-$N.second.md"; rm -f "$OUT2"
  watch_run "$OUT2" agent_run review2 "$LOG.second.json" "${PROMPT//$TARGET/$OUT2}" || true
  stop_worktree_servers "$WT"
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
    printf '\n\n## Codex review (independent, ${CODEX_REVIEW_MODEL:-gpt-6.1-sol} ${CODEX_REVIEW_EFFORT:-high})\n\n' >> "$OUT"
    cat "$CODEX" >> "$OUT"
  fi
fi

head -1 "$OUT"
