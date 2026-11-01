#!/usr/bin/env bash
# Vercel "Ignored Build Step": exit 1 = build, exit 0 = skip.
# Previews build only on "[preview]" commits. Production builds unless the merge
# changed nothing the deployed app uses (docs, scripts, tests, screenshots, research,
# builder notes, CI config), which saves the Hobby plan's daily build allowance.

if [ "$VERCEL_ENV" = "production" ]; then
  changed=$(git diff --name-only HEAD^ HEAD 2>/dev/null) || { echo "No diff available; building"; exit 1; }
  [ -n "$changed" ] || { echo "Empty diff; building"; exit 1; }
  app=$(printf '%s\n' "$changed" | grep -vE '^(docs/|scripts/|research/|screenshots/|e2e/|\.builder/|\.github/|\.claude/|\.impeccable/)|\.md$|\.test\.tsx?$|^CODEX_REPORT\.md$' || true)
  if [ -z "$app" ]; then
    echo "Production: only docs/scripts/tests changed; skipping build"
    exit 0
  fi
  echo "Production build"
  exit 1
fi

case "$VERCEL_GIT_COMMIT_MESSAGE" in
  *"[preview]"*) echo "Preview requested by commit message"; exit 1 ;;
esac
echo "Skipping preview build (add [preview] to the commit message to build one)"; exit 0
