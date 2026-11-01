#!/usr/bin/env bash
# Independent PR review by Codex (gpt-6-astra, medium effort, one exhaustive pass) on a builder worktree.
# Usage: scripts/codex-review.sh <issue-number>
# Writes: .builder/codex-review-<n>.md. The coordinator reproduces every finding before acting on it.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
N="${1:?usage: scripts/codex-review.sh <issue-number>}"
WT="$(dirname "$ROOT")/E-commerce-worktrees/ticket-$N"
OUT="$ROOT/.builder/codex-review-$N.md"
[ -d "$WT" ] || { echo "No worktree for ticket $N at $WT"; exit 1; }

cd "$WT"
git fetch -q origin main
git pull -q --ff-only || true

ISSUE="$(gh issue view "$N" --comments 2>/dev/null || echo "(issue text unavailable)")"
PROMPT="You are a code reviewer. Do not modify any files. Review the changes on this branch against origin/main (run: git diff origin/main...HEAD, and read files as needed).
The GitHub issue being implemented (#$N):
---
$ISSUE
---
Project rules to check against: CLAUDE.md, GLOSSARY.md, DESIGN.md, docs/adr/ (especially 0005, 0011-0017), docs/agents/builder.md.
Focus on: correctness bugs, per-store data isolation (Postgres RLS, the storeScoped transaction, connection pooling), security (header spoofing, auth, secrets), acceptance criteria actually met, tests that would not catch a regression, scale rules (indexes, N+1, caching), and ADR violations.
Report ALL findings in this single pass: do not hold any back for a later round, and check every acceptance criterion explicitly (met / not met, with evidence). For EVERY finding give: severity (blocking = security, data isolation, data loss, a failed acceptance criterion, or broken build/CI; everything else non-blocking), file:line, the concrete failure scenario, and exact steps or a command to reproduce it. Do not report style preferences. If nothing blocking remains, say exactly: NO BLOCKING FINDINGS."

codex exec --sandbox read-only --skip-git-repo-check \
  -c model="gpt-6-astra" -c model_reasoning_effort="medium" \
  -o "$OUT" "$PROMPT" > "$OUT.log" 2>&1 || true
echo "Codex review written to $OUT"
