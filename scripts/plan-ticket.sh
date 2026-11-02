#!/usr/bin/env bash
# Stage T (plan): turn the next ticket into an agent brief while another ticket builds.
# Read-only on code; writes only an issue comment and labels. See docs/agents/orchestration.md.
# Usage: scripts/plan-ticket.sh <issue>
set -euo pipefail
REPO="hislordshipprof/african-market-AI-Ecommerce"
ROOT="$(git rev-parse --show-toplevel)"
N="${1:?usage: scripts/plan-ticket.sh <issue>}"
cd "$ROOT"
mkdir -p .builder/logs
git fetch -q origin main
LOG="$ROOT/.builder/logs/plan-$N-$(date +%Y%m%d-%H%M%S).json"

PROMPT="/supermatt:triage #$N
I am away: decide for me, for issue #$N only. Verify the issue's claims against the code on origin/main, and against GLOSSARY.md, docs/adr/ and docs/spec/platform-spec.md. Then post an agent brief comment (heading 'Agent brief') that records:
- what to build and what is explicitly out of scope
- each acceptance criterion as a concrete scenario
- the test seams (every store-owned table: cross-store read and write fail through storeScoped(); auth paths tested against the real database)
- environment keys and external accounts needed (match scripts/ticket-env.txt; say which are missing)
- dependencies on merged code to reuse, and risks
- an 'Integration contracts' section: for every external provider or platform API the ticket touches (Stripe, Inngest, Resend, Telnyx, R2, Vercel and so on), how it actually behaves, checked against its official docs, with links. Example: destination charges live on the platform account, so capture and cancel run on the platform, not the connected account.
- an 'Edge cases' table that the builder must turn into tests: retries and duplicate events, an external call that succeeds followed by a failed DB write, concurrency, cross-store access, timezones and overnight hours, empty and maximum inputs, money rounding and amounts above an authorization, keys missing at runtime
If the ticket has more than about 5 acceptance criteria or more than one security-sensitive system, recommend a split in the brief and create the child issues.
Label it ready-for-agent when it can be built without a human decision; otherwise needs-info or ready-for-human with the missing facts. Do not change any code or create branches."

claude -p "$PROMPT" --dangerously-skip-permissions --strict-mcp-config --output-format json < /dev/null > "$LOG" 2>&1 || status=$?
echo "Plan finished (exit ${status:-0}). Log: $LOG"
gh issue view "$N" -R "$REPO" --json labels --jq '"labels: " + ([.labels[].name] | join(", "))'
exit "${status:-0}"
