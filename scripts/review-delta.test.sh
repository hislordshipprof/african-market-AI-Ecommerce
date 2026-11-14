#!/usr/bin/env bash
# Tests for the delta re-review in scripts/review-ticket.sh (#616), end to end with a stubbed reviewer: the
# stub saves the prompt it is given and writes a verdict, so no real review runs.
# Run: bash scripts/review-delta.test.sh
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
g() { git -c user.name=t -c user.email=t@t "$@"; }
unset REVIEW_FULL REVIEW_ROUND RISK
# The pipeline scripts use GNU sed -i (Windows Git Bash, Linux). On macOS, put gsed first on PATH.
if ! sed --version >/dev/null 2>&1 && command -v gsed >/dev/null 2>&1; then
  mkdir -p "$T/gnu" && ln -s "$(command -v gsed)" "$T/gnu/sed" && PATH="$T/gnu:$PATH"
fi

# fixture <name>: a bare origin with main (a.txt of 200 lines), a clone ($ROOT) holding the scripts with a stub
# reviewer, and ticket 9's worktree on branch ticket-9 with one commit that adds p.txt (100 lines).
fixture() {
  D="$T/$1"; ROOT="$D/E-commerce"; WT="$D/E-commerce-worktrees/ticket-9"
  mkdir -p "$D/E-commerce-worktrees" && g init -q --bare -b main "$D/origin.git"
  g clone -q "$D/origin.git" "$ROOT" 2>/dev/null
  ( cd "$ROOT" && seq 1 200 | sed 's/^/line /' > a.txt && g add a.txt && g commit -qm base && g push -q origin main )
  mkdir -p "$ROOT/scripts"
  cp "$SRC/scripts/review-ticket.sh" "$SRC/scripts/review-watch.sh" "$SRC/scripts/merge-gate.sh" "$ROOT/scripts/"
  cp "$SRC/scripts/review-delta.sh" "$ROOT/scripts/" 2>/dev/null
  cat > "$ROOT/scripts/agent-cli.sh" <<'STUB'
REVIEW_ENGINE=claude
agent_run() {
  printf '%s' "$3" > "$PROMPT_OUT"
  printf 'VERDICT: PASS\n' > "$(grep -o 'Write your result to [^ ]*\.md' "$PROMPT_OUT" | head -1 | sed 's/^Write your result to //')"
}
STUB
  ( cd "$ROOT" && g worktree add -q -b ticket-9 "$WT" && cd "$WT" && seq 1 100 | sed 's/^/p /' > p.txt \
    && g add p.txt && g commit -qm "Add p" )
  export PROMPT_OUT="$D/prompt.txt" REVIEW_WATCH_POLL_SEC=1
}
# review <extra env...>: runs the real review-ticket.sh for ticket 9, prints its stderr.
review() { ( cd "$ROOT" && env "$@" bash scripts/review-ticket.sh 9 2>&1 >/dev/null ); }
# reviewed: pretend the current head was reviewed, with a blocking finding.
reviewed() {
  mkdir -p "$ROOT/.builder"
  printf 'VERDICT: BLOCKING\n- blocking p.txt:3 SENTINEL-FINDING the guard is missing\n' > "$ROOT/.builder/review-9.md"
  g -C "$WT" rev-parse HEAD > "$ROOT/.builder/review-9.sha"
}
has() { grep -qF -- "$1" "$PROMPT_OUT"; }
delta_file() { cat "$WT/.builder/review-9.delta.diff" 2>/dev/null; }

# 1. Round 1: no earlier review. Full review, no delta section.
fixture r1; review REVIEW_ROUND=1 >/dev/null
if has "git diff origin/main...HEAD" && ! has "DELTA REVIEW" && [ ! -e "$WT/.builder/review-9.delta.diff" ]; then ok "round 1 is a full review"; else bad "round 1 is a full review"; fi
[ "$(cat "$ROOT/.builder/review-9.sha")" = "$(g -C "$WT" rev-parse HEAD)" ] && ok "the .sha file still names the reviewed head" || bad "the .sha file names the head"

# 2. Fix round, with main merged in since the review: the delta holds the fix, not main's change.
fixture r2; reviewed
( cd "$WT" && sed -i.bak 's/^p 3$/p 3 guarded/' p.txt && rm p.txt.bak && g commit -qam "Guard line three" )
( cd "$ROOT" && echo "MAIN-ONLY" > m.txt && g add m.txt && g commit -qm "Main moves" && g push -q origin main )
( cd "$WT" && g fetch -q origin main && g merge -q --no-edit origin/main )
err=$(review REVIEW_ROUND=2)
if has "DELTA REVIEW" && has "SENTINEL-FINDING" && has "Guard line three" && has "git diff origin/main...HEAD"; then ok "fix round gets the delta prompt with earlier findings, commits and the full-diff pointer"; else bad "fix round prompt: $err"; fi
if delta_file | grep -qF "p 3 guarded" && ! delta_file | grep -qF "MAIN-ONLY"; then ok "fix-round delta has the fix and not main's change"; else bad "fix-round delta content: $(delta_file)"; fi
if has "fixed" && has "evidence"; then ok "reviewer must say per earlier finding whether it is fixed, with evidence"; else bad "per-finding instruction"; fi

# 3. Conflict repair: head is a merge of main onto the reviewed commit. Only the resolution is reviewed.
fixture r3
( cd "$WT" && sed -i.bak 's/^line 5$/line 5 branch/' a.txt && rm a.txt.bak && g commit -qam "Branch edits line 5" )
reviewed
( cd "$ROOT" && sed -i.bak 's/^line 5$/line 5 main/' a.txt && rm a.txt.bak && echo MAIN-ONLY > m.txt && g add m.txt && g commit -qam "Main edits line 5" -a && g push -q origin main )
( cd "$WT" && g fetch -q origin main && { g merge --no-edit origin/main >/dev/null 2>&1 || true; } \
  && sed -i.bak '/^<<<<<<<\|^=======\|^>>>>>>>/d;/^line 5 main$/d;s/^line 5 branch$/line 5 RESOLVED/' a.txt && rm a.txt.bak && g add a.txt && g commit -qm "Merge main" )
err=$(review REVIEW_ROUND=2)
if has "merge resolution" && delta_file | grep -qF "RESOLVED" && ! delta_file | grep -qF "MAIN-ONLY" && has "a.txt"; then ok "conflict repair reviews the resolution and names the conflicted file"; else bad "conflict repair: $err / $(delta_file)"; fi

# 4. Fallback: a delta over 30% of the branch diff gets the full review.
fixture r4; reviewed
( cd "$WT" && seq 1 60 | sed 's/^/q /' > q.txt && g add q.txt && g commit -qm "Add q" )
err=$(review REVIEW_ROUND=2)
if ! has "DELTA REVIEW" && [[ "$err" == *"30%"* ]]; then ok "delta over 30% falls back to a full review"; else bad "30% fallback: $err"; fi

# 5. Fallback: the previous reviewed sha is not in the repository.
fixture r5; reviewed
echo 0123456789abcdef0123456789abcdef01234567 > "$ROOT/.builder/review-9.sha"
( cd "$WT" && sed -i.bak 's/^p 3$/p 3 guarded/' p.txt && rm p.txt.bak && g commit -qam fix )
err=$(review REVIEW_ROUND=2)
if ! has "DELTA REVIEW" && [[ "$err" == *"not reachable"* ]]; then ok "an unreachable previous sha falls back to a full review"; else bad "unreachable sha: $err"; fi

# 6. REVIEW_FULL=1 forces a full review even when a delta is available.
fixture r6; reviewed
( cd "$WT" && sed -i.bak 's/^p 3$/p 3 guarded/' p.txt && rm p.txt.bak && g commit -qam fix )
err=$(review REVIEW_ROUND=2 REVIEW_FULL=1)
if ! has "DELTA REVIEW" && [[ "$err" == *"REVIEW_FULL"* ]]; then ok "REVIEW_FULL=1 forces a full review"; else bad "REVIEW_FULL: $err"; fi

[ "$fail" = 0 ] && echo "ALL PASS" || { echo "FAILURES"; exit 1; }
