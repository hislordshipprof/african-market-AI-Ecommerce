#!/usr/bin/env bash
# Removes AI tool attribution from a commit message: "Co-Authored-By:" trailers that credit an AI coding tool,
# "Claude-Session:" link trailers, and the "Generated with Claude Code" line.
# Owner rule (2026-11-09): commits in this repo carry no AI co-author and no session link. Agent CLIs add them
# by default, and GitHub copies them onto the squash commit, which is how they reached main.
# Usage: scripts/strip-ai-coauthors.sh < message > cleaned     (a filter)
#        scripts/strip-ai-coauthors.sh --check < message       (exit 1 when any of these lines is present)
# Used by .githooks/commit-msg (every local commit) and scripts/merge-ticket.sh (the squash message).
# Tests: bash scripts/strip-ai-coauthors.test.sh
set -euo pipefail
# Only the address identifies the tool: the name changes with every model, and a person can be named Claude.
AI='^[[:space:]]*(co-authored-by:.*(noreply@anthropic\.com|cursoragent@cursor\.com)|claude-session:|(🤖 )?generated with \[?claude code)'
if [ "${1:-}" = "--check" ]; then
  ! grep -qiE "$AI"
else
  # Drop the trailers, then any blank lines left at the end of the message.
  grep -viE "$AI" | sed -e :a -e '/^[[:space:]]*$/{$d;N;ba' -e '}' || true
fi
