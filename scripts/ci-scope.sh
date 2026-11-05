#!/usr/bin/env bash
# What local-ci must run for a change, sourced by ci-local.sh and merge-ticket.sh.
# Owner-requested 2026-11-05: a full run took 20-35 minutes whatever the change.
# Anything not recognised is "full", so a new kind of file can only cost time, never skip a check.

# ci_scope: reads changed paths on stdin, prints one tier.
#   docs     - documentation only: nothing runs.
#   pipeline - pipeline shell scripts and documentation: the scripts' own tests run.
#   tests    - test files only, so product code is unchanged: typecheck, lint and those tests.
#   full     - everything else, and an empty list (a commit on main, or a diff that could not be read).
ci_scope() {
  local f any=0 scope=docs
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    any=1
    case "$f" in
      docs/*|*.md|screenshots/*) ;;
      scripts/*.sh|scripts/agent-engine.env)
        [ "$scope" = tests ] && { echo full; return; }
        scope=pipeline ;;
      src/*.test.ts|src/*.test.tsx|e2e/*.spec.ts)
        [ "$scope" = pipeline ] && { echo full; return; }
        scope=tests ;;
      *) echo full; return ;;
    esac
  done
  [ "$any" = 1 ] || { echo full; return; }
  echo "$scope"
}

# rebase_is_safe <old-sha> <new-sha>: true when <new-sha> is <old-sha> replayed onto a newer main, with an
# identical patch, and main's new commits change nothing that reaches every test. Everything else needs a full run.
rebase_is_safe() {
  local old="$1" new="$2" old_base new_base a b
  old_base=$(git merge-base origin/main "$old") || return 1
  new_base=$(git merge-base origin/main "$new") || return 1
  a=$(git diff "$old_base" "$old" | git patch-id --stable | cut -d' ' -f1)
  b=$(git diff "$new_base" "$new" | git patch-id --stable | cut -d' ' -f1)
  [ -n "$a" ] && [ "$a" = "$b" ] || return 1
  ! git diff --name-only "$old_base" "$new_base" \
    | grep -qE '^(prisma/|package\.json$|pnpm-lock\.yaml$|patches/|next\.config\.|playwright\.config\.|vitest\.config\.|tsconfig|\.github/|src/proxy\.ts$|src/app/layout\.tsx$)'
}

# stop_all_children_but <pid...>: stops each child of this shell's script and its tree, sparing the given pids.
# Needs kill_tree from review-watch.sh.
stop_all_children_but() {
  local c spare=" $* "
  for c in $(_descendants "$$"); do
    case "$spare" in *" $c "*) ;; *) kill_tree "$c" ;; esac
  done
}
