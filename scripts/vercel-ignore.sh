#!/usr/bin/env bash
# Vercel "Ignored Build Step": exit 1 = build, exit 0 = skip.
# Deploys happen at milestones only, to save the Hobby plan's build allowance and Neon usage
# (every production build runs `prisma migrate deploy` against the production database).
#   Production (main): builds only when the merge commit subject ends with "[deploy]".
#     The coordinator adds it to the squash subject at a milestone, e.g.
#     DEPLOY=1 scripts/merge-ticket.sh <issue>   (only with the owner's go)
#   Preview: builds only on "[preview]" commits.

if [ "$VERCEL_ENV" = "production" ]; then
  # Only the first line, and only as its final token, so merely mentioning the marker never deploys.
  subject="${VERCEL_GIT_COMMIT_MESSAGE%%$'
'*}"
  subject="${subject%"${subject##*[![:space:]]}"}"
  case "$subject" in
    *"[deploy]") echo "Production deploy requested by commit subject"; exit 1 ;;
  esac
  echo "Production: skipping (milestone deploys only; add [deploy] to the merge commit subject)"; exit 0
fi

case "$VERCEL_GIT_COMMIT_MESSAGE" in
  *"[preview]"*) echo "Preview requested by commit message"; exit 1 ;;
esac
echo "Skipping preview build (add [preview] to the commit message to build one)"; exit 0
