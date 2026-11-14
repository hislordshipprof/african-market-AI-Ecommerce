#!/usr/bin/env bash
# The machine-wide local-ci slots, sourced by ci-local.sh. Up to CI_SLOTS suites (default 2) run at once, each
# holding the lock of its own slot; with every slot held, a run waits. Slot 1's lock is <lock>, slot k's is <lock>-k.
# Each lock is a directory holding the owner's pid, its start time, and a token only the owner knows.
# The earlier version let two runs hold the lock at once, three ways:
# - two waiters could both judge a lock stale, and the slower one then renamed away the lock the faster one had
#   just taken;
# - a lock older than 3 hours was taken from an owner that was still running;
# - every exit path removed whatever lock was there, including one that now belonged to another run.
# Two runs in one slot share its ci-runner checkout and drop each other's database.
# Tests: bash scripts/ci-lock.test.sh

# ci_lock_try <lock> <pid> <token>: take the lock if it is free.
ci_lock_try() {
  mkdir "$1" 2>/dev/null || return 1
  printf '%s\n' "$3" > "$1/token"
  _ci_lock_started "$2" > "$1/started"
  printf '%s\n' "$2" > "$1/pid"
}

# _ci_lock_started <pid>: the process start time. With the pid it names one process, so a pid reused after a
# reboot is not taken for the owner. Empty where ps has no -o (Git Bash); the pid alone is used there.
_ci_lock_started() { ps -o lstart= -p "$1" 2>/dev/null || true; }

# ci_lock_release <lock> <token>: remove the lock only when it is still ours.
ci_lock_release() {
  [ "$(cat "$1/token" 2>/dev/null || true)" = "$2" ] || return 0
  rm -rf "$1"
}

_ci_lock_age() { echo $(( $(date +%s) - $(stat -c %Y "$1" 2>/dev/null || date +%s) )); }

# ci_lock_stale <lock>: the owner is gone (its pid is dead or now another process), or the lock never got a pid
# (its owner died between the writes).
ci_lock_stale() {
  local owner; owner=$(cat "$1/pid" 2>/dev/null || true)
  if [ -n "$owner" ]; then
    ! kill -0 "$owner" 2>/dev/null || [ "$(_ci_lock_started "$owner")" != "$(cat "$1/started" 2>/dev/null || true)" ]
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

# ci_slot_lock <lock> <k>: slot k's lock path.
ci_slot_lock() { if [ "$2" = 1 ]; then echo "$1"; else echo "$1-$2"; fi; }

# ci_slot_count <CI_SLOTS> <CI_RUNNER> <CI_DB>: how many slots this run may use. A run without its own checkout
# and database (a hand run) gets only slot 1, so two hand runs still wait for each other.
ci_slot_count() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] || { echo "local-ci SETUP: CI_SLOTS must be a whole number from 1, got '$1'" >&2; return 1; }
  if [ -n "$2" ] && [ -n "$3" ]; then echo "$1"; else echo 1; fi
}

# ci_slot_env <k>: slot 1 keeps the caller's CI_RUNNER, CI_DB and E2E_PORT; slot k gets <CI_RUNNER>-k, <CI_DB>_k
# and E2E_PORT + (k-1)*1000, so two runs never share a checkout, a database or a port.
ci_slot_env() {
  [ "$1" != 1 ] || return 0
  [ -z "${CI_RUNNER:-}" ] || CI_RUNNER="$CI_RUNNER-$1"
  [ -z "${CI_DB:-}" ] || CI_DB="${CI_DB}_$1"
  export E2E_PORT=$(( ${E2E_PORT:-3000} + ($1 - 1) * 1000 ))
}

# ci_slot_try <lock> <slots> <pid> <token>: take the first free slot and print its number.
ci_slot_try() {
  local k
  for ((k = 1; k <= $2; k++)); do
    if ci_lock_try "$(ci_slot_lock "$1" "$k")" "$3" "$4"; then echo "$k"; return 0; fi
  done
  return 1
}

# ci_slot_takeover <lock> <slots>: free every stale slot; each slot is looked at on its own.
ci_slot_takeover() {
  local k
  for ((k = 1; k <= $2; k++)); do ci_lock_takeover "$(ci_slot_lock "$1" "$k")" || true; done
}
