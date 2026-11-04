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
- a 'Required tests' list: for each acceptance criterion and edge case, the test file, the test name, the level (unit, integration against the lane database, sandbox, e2e), and the exact regression it must catch. Tests must drive the real code path (real auth.handler, storeScoped() under app_runtime RLS, the real provider adapter), never seed their own expected result, never assert only a type or 'less than 500', and never bypass RLS in the assertion. Test doubles must reject what the real provider rejects.
- a 'Review checklist' section: what the independent reviewer will check for this ticket (the acceptance criteria, the edge cases, the integration contracts, the required tests, production-only behaviour such as NODE_ENV=production, VERCEL, missing keys, and hosted CI's env). The builder meets this before pushing.
Never split the ticket and never create child issues (owner decision 2026-11-04: splitting adds pipeline bottlenecks). Brief the whole ticket as one build, however many acceptance criteria it has.
Label it ready-for-agent when it can be built without a human decision; otherwise needs-info or ready-for-human with the missing facts. Do not change any code or create branches."

. "$ROOT/scripts/agent-cli.sh"
agent_run plan "$LOG" "$PROMPT" || status=$?
echo "Plan finished (exit ${status:-0}). Log: $LOG"

# Brief review: a different model family attacks the brief before any code exists, so the failure modes reviewers
# used to find after the build become required tests up front. Skipped when the ticket has open blockers.
if [ -z "${status:-}" ] && [ "${SKIP_BRIEF_REVIEW:-0}" != "1" ] && \
   gh issue view "$N" -R "$REPO" --json labels --jq '.labels[].name' | grep -qx ready-for-agent && \
   [ -z "$(gh api "repos/$REPO/issues/$N/dependencies/blocked_by" --jq '[.[]|select(.state=="open")]|length|select(.>0)')" ]; then
  BLOG="$ROOT/.builder/logs/brief-review-$N-$(date +%Y%m%d-%H%M%S).json"
  BPROMPT="Brief review for issue #$N, before any code is written. Read the issue and its 'Agent brief' comment (gh issue view $N -R $REPO --comments), the code on origin/main it touches, CLAUDE.md, GLOSSARY.md, docs/adr/, docs/spec/platform-spec.md and docs/agents/builder.md. Act as the independent code reviewer who will review the finished PR: list everything that would make you return VERDICT: BLOCKING if the builder followed this brief exactly. Cover missed edge cases, wrong integration contracts (check the provider's official docs), production-only behaviour (NODE_ENV=production, VERCEL, missing keys, hosted CI env), cross-store isolation, concurrency, and required tests that would pass while the code is broken. Post one issue comment headed 'Brief review' with: corrections to the brief, extra edge cases as rows, and extra required tests (file, name, regression caught). Do not change code, labels or other comments."
  agent_run review "$BLOG" "$BPROMPT" || true
  echo "Brief review finished. Log: $BLOG"
fi
gh issue view "$N" -R "$REPO" --json labels --jq '"labels: " + ([.labels[].name] | join(", "))'
exit "${status:-0}"
