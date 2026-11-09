#!/usr/bin/env bash
# Removes "Co-Authored-By:" trailers that credit an AI coding tool from a commit message.
# Owner rule (2026-11-09): commits in this repo carry no AI co-author. Agent CLIs add the trailer by default,
# and GitHub copies it onto the squash commit, which is how it reached main.
# Usage: scripts/strip-ai-coauthors.sh < message > cleaned     (a filter)
#        scripts/strip-ai-coauthors.sh --check < message       (exit 1 when such a trailer is present)
# Used by .githooks/commit-msg (every local commit) and scripts/merge-ticket.sh (the squash message).
# Tests: bash scripts/strip-ai-coauthors.test.sh
set -euo pipefail
# The address is what identifies the tool; the name before it changes with every model.
AI='^[[:space:]]*co-authored-by:.*(noreply@anthropic\.com|cursoragent@cursor\.com|\bclaude\b|\bcursor\b)'
if [ "${1:-}" = "--check" ]; then
  ! grep -qiE "$AI"
else
  # Drop the trailers, then any blank lines left at the end of the message.
  grep -viE "$AI" | sed -e :a -e '/^[[:space:]]*$/{$d;N;ba' -e '}' || true
fi
