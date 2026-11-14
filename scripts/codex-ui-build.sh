#!/usr/bin/env bash
# Codex UI build in a ticket worktree (gpt-6-astra, medium effort), WITHOUT the Windows sandbox so it can
# launch Chromium, esbuild and Prisma's engines (the sandbox blocks child processes with spawn EPERM).
# Owner-approved 2026-11-02. Same trust level as the Claude builders (--dangerously-skip-permissions).
# Usage: scripts/codex-ui-build.sh <worktree> <brief.md> [log]
set -euo pipefail
WT="${1:?usage: scripts/codex-ui-build.sh <worktree> <brief.md> [log]}"
BRIEF="${2:?brief file required}"
LOG="${3:-$WT/../codex-$(basename "$WT").log}"
[ -d "$WT" ] || { echo "No worktree at $WT"; exit 1; }
GUARD="Operating rules (non-negotiable): work only inside $WT. Never read, print, copy or modify any .env* file except to load it for running the app or tests. Never touch files outside the worktree, never change git config, and never run git commit, push, branch, reset or clean. Stop every server or browser you start before you finish. Run the real checks yourself (pnpm typecheck, lint, test, build, test:e2e --workers=1 with E2E_PORT if set) and capture the screenshots the brief asks for."
cd "$WT"
{ printf '%s\n\n' "$GUARD"; cat "$BRIEF"; } | codex exec -C "$WT" --sandbox danger-full-access \
  -c model="gpt-6-astra" -c model_reasoning_effort="medium" --skip-git-repo-check - > "$LOG" 2>&1
echo "Codex finished. Log: $LOG"
