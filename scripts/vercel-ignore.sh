#!/usr/bin/env bash
# Vercel "Ignored Build Step": exit 0 skips the build, exit 1 builds.
# Production (main) always builds. Preview builds only run when the commit message
# contains [preview] -- the coordinator adds it at a milestone it wants to check.
if [ "$VERCEL_ENV" = "production" ]; then
  echo "Production build"; exit 1
fi
case "$VERCEL_GIT_COMMIT_MESSAGE" in
  *"[preview]"*) echo "Preview requested by commit message"; exit 1 ;;
esac
echo "Skipping preview build (add [preview] to the commit message to build one)"; exit 0
