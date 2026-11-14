#!/usr/bin/env bash
# Tests for the machine-wide local-ci slots (scripts/ci-lock.sh). Run: bash scripts/ci-lock.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/ci-lock.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
L="$T/ci-local.lock"

ci_lock_try "$L" "$$" mine && ok "a free lock is taken" || bad "a free lock is taken"
ci_lock_try "$L" "$$" theirs && bad "a held lock was taken twice" || ok "a held lock is not taken twice"

# A waiter looks at a lock whose owner is running: it must stay.
ci_lock_takeover "$L"
[ "$(cat "$L/token" 2>/dev/null)" = mine ] && ok "a running owner keeps its lock" || bad "a running owner lost its lock"

# A run that lost its lock (or never had this one) must not remove the current owner's lock on exit.
ci_lock_release "$L" theirs
[ -d "$L" ] && ok "releasing with another run's token leaves the lock" || bad "another run's release removed the lock"
ci_lock_release "$L" mine
[ -d "$L" ] && bad "the owner's release left the lock" || ok "the owner's release frees the lock"

# The owner died without releasing: the next waiter takes over.
sleep 0 & dead=$!; wait "$dead"
ci_lock_try "$L" "$dead" gone
ci_lock_takeover "$L"
ci_lock_try "$L" "$$" next && ok "a dead owner's lock is taken over" || bad "a dead owner's lock stayed"

# The overlap this replaced: two waiters both saw the dead owner. The first took over and now holds the lock;
# the second finishes its takeover late and must not remove the first one's lock.
ci_lock_takeover "$L"
[ "$(cat "$L/token" 2>/dev/null)" = next ] && ok "a late second takeover leaves the new owner's lock" || bad "a late second takeover removed a live lock"
ci_lock_release "$L" next

# A lock directory with no pid yet belongs to a run between its two writes: left alone at first, cleared later.
mkdir "$L"
ci_lock_takeover "$L"
[ -d "$L" ] && ok "a fresh lock without a pid is left alone" || bad "a fresh lock without a pid was removed"
CI_LOCK_NOPID_SEC=-1 ci_lock_takeover "$L"
[ -d "$L" ] && bad "an old lock without a pid stayed" || ok "an old lock without a pid is cleared"

# A run alive past the maximum age is stopped before its lock goes, so it cannot run beside the next one.
sleep 300 & hung=$!
ci_lock_try "$L" "$hung" hung
CI_LOCK_MAX_AGE_SEC=-1 ci_lock_takeover "$L" 2>/dev/null
wait "$hung" 2>/dev/null
kill -0 "$hung" 2>/dev/null && bad "the hung run is still running" || ok "a hung run is stopped"
[ -d "$L" ] && bad "the hung run's lock stayed" || ok "the hung run's lock is freed"

# After a reboot the recorded pid can belong to an unrelated program. It is not the owner: the lock is freed and
# the program is left running.
sleep 300 & stranger=$!
ci_lock_try "$L" "$stranger" old
echo "Mon Jan  1 00:00:00 2001" > "$L/started"
CI_LOCK_MAX_AGE_SEC=-1 ci_lock_takeover "$L" 2>/dev/null
kill -0 "$stranger" 2>/dev/null && ok "a reused pid's program is not stopped" || bad "a reused pid's program was stopped"
[ -d "$L" ] && bad "a lock with a reused pid stayed" || ok "a lock with a reused pid is freed"
kill "$stranger" 2>/dev/null; wait "$stranger" 2>/dev/null

# While one takeover is in progress another backs off.
mkdir "$L.takeover"
ci_lock_try "$L" "$dead" gone
ci_lock_takeover "$L" && bad "two takeovers ran at once" || ok "a second takeover waits for the first"
[ -d "$L" ] && ok "the waiting takeover removed nothing" || bad "the waiting takeover removed the lock"

# Slots (CI_SLOTS): each run takes the first free slot. Slot 1 is today's lock path; slot k is <lock>-k.
S="$T/slots.lock"
a=$(ci_slot_try "$S" 2 "$$" a) && [ "$a" = 1 ] && [ "$(cat "$S/token" 2>/dev/null)" = a ] \
  && ok "the first run takes slot 1, today's lock" || bad "the first run did not take slot 1"
b=$(ci_slot_try "$S" 2 "$$" b) && [ "$b" = 2 ] && [ "$(cat "$S-2/token" 2>/dev/null)" = b ] \
  && ok "a second run takes slot 2 while slot 1 is held" || bad "a second run did not take slot 2"
ci_slot_try "$S" 2 "$$" c >/dev/null && bad "a third run took a slot" || ok "a third run waits while both slots are held"
[ "$(cat "$S/token")" = a ] && [ "$(cat "$S-2/token")" = b ] && ok "a waiting run changes no slot" || bad "a waiting run changed a slot"

# One slot's run ends: its release frees only its own slot, and the next run takes that slot.
ci_lock_release "$S" b; ci_lock_release "$S-2" a
[ -d "$S" ] && [ -d "$S-2" ] && ok "a run cannot release another slot's lock" || bad "a run released another slot's lock"
ci_lock_release "$S" a
[ "$(cat "$S-2/token")" = b ] && c=$(ci_slot_try "$S" 2 "$$" c) && [ "$c" = 1 ] \
  && ok "a freed slot goes to the next run, the other slot untouched" || bad "a freed slot was not reused cleanly"

# Slot 2's owner died: the takeover over every slot frees slot 2 and leaves slot 1's live owner alone.
rm -rf "$S-2"; ci_lock_try "$S-2" "$dead" gone
ci_slot_takeover "$S" 2
[ ! -d "$S-2" ] && [ "$(cat "$S/token" 2>/dev/null)" = c ] \
  && ok "a stale slot is taken over without touching the other" || bad "a stale slot takeover was wrong"
ci_lock_release "$S" c

# CI_SLOTS=1: one lock at today's path, and a second run waits.
o=$(ci_slot_try "$S" 1 "$$" one) && [ "$o" = 1 ] && [ -d "$S" ] && ! ci_slot_try "$S" 1 "$$" two >/dev/null && [ ! -d "$S-2" ] \
  && ok "one slot is today's single lock" || bad "one slot is not today's single lock"
ci_lock_release "$S" one

exit "$fail"
