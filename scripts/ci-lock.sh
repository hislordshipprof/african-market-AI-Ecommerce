#!/usr/bin/env bash
# The machine-wide local-ci lock, sourced by ci-local.sh. One suite runs at a time; every other run waits.
# The lock is a directory holding the owner's pid and a token only the owner knows.
# The earlier version let two runs hold the lock at once, three ways:
# - two waiters could both judge a lock stale, and the slower one then renamed away the lock the faster one had
#   just taken;
# - a lock older than 3 hours was taken from an owner that was still running;
# - every exit path removed whatever lock was there, including one that now belonged to another run.
# Two runs at once share the ci-runner checkout and drop each other's database.
# Tests: bash scripts/ci-lock.test.sh

# ci_lock_try <lock> <pid> <token>: take the lock if it is free.
ci_lock_try() {
  mkdir "$1" 2>/dev/null || return 1
  printf '%s\n' "$3" > "$1/token"
  printf '%s\n' "$2" > "$1/pid"
}

# ci_lock_release <lock> <token>: remove the lock only when it is still ours.
ci_lock_release() {
  [ "$(cat "$1/token" 2>/dev/null || true)" = "$2" ] || return 0
  rm -rf "$1"
}

_ci_lock_age() { echo $(( $(date +%s) - $(stat -c %Y "$1" 2>/dev/null || date +%s) )); }

# ci_lock_stale <lock>: the owner is gone, or the lock never got a pid (its owner died between the two writes).
ci_lock_stale() {
  local owner; owner=$(cat "$1/pid" 2>/dev/null || true)
  if [ -n "$owner" ]; then
    ! kill -0 "$owner" 2>/dev/null
  else
    [ "$(_ci_lock_age "$1")" -gt "${CI_LOCK_NOPID_SEC:-120}" ]
  fi
}

# ci_lock_takeover <lock>: free a stale lock. Takeovers run one at a time (a second, short-lived mutex), and the
# lock is looked at again inside it, so a waiter can never remove a lock that another waiter has just taken.
# A run still alive after CI_LOCK_MAX_AGE_SEC (default 6 hours; every step has its own timeout, so this means a
# hang outside the steps) is stopped with its whole tree first, and only then loses the lock.
ci_lock_takeover() {
  local lock="$1" mutex="$1.takeover" owner
  if ! mkdir "$mutex" 2>/dev/null; then
    # Held only for an instant. One left behind by a waiter that died inside it is cleared after a minute.
    [ "$(_ci_lock_age "$mutex")" -gt 60 ] && rmdir "$mutex" 2>/dev/null
    return 1
  fi
  if [ -d "$lock" ]; then
    owner=$(cat "$lock/pid" 2>/dev/null || true)
    if ci_lock_stale "$lock"; then
      rm -rf "$lock"
    elif [ -n "$owner" ] && [ "$(_ci_lock_age "$lock")" -gt "${CI_LOCK_MAX_AGE_SEC:-21600}" ]; then
      echo "local-ci lock: run $owner has held the lock past ${CI_LOCK_MAX_AGE_SEC:-21600}s; stopping it" >&2
      if declare -F kill_tree >/dev/null; then kill_tree "$owner"; else kill -KILL "$owner" 2>/dev/null; fi
      rm -rf "$lock"
    fi
  fi
  rmdir "$mutex" 2>/dev/null
  return 0
}
