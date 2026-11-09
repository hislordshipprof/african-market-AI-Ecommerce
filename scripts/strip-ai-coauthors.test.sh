#!/usr/bin/env bash
# Tests for scripts/strip-ai-coauthors.sh. Run: bash scripts/strip-ai-coauthors.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/scripts/strip-ai-coauthors.sh"
fail=0
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf 'want:\n%s\ngot:\n%s\n' "$2" "$3"; fail=1; fi; }

got=$(printf 'Fix the refund race (#307)\n\nA lost race now reports success.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://example.test/s\n' | bash "$F")
eq "the Claude trailer goes, the rest of the message stays" "$(printf 'Fix the refund race (#307)\n\nA lost race now reports success.\n\nClaude-Session: https://example.test/s')" "$got"

got=$(printf 'Subject\n\n* one\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n\n* two\n\n---------\n\nCo-authored-by: Claude Fable 5.2 <noreply@anthropic.com>\n' | bash "$F")
eq "every AI trailer in a squash message goes, in any letter case" "$(printf 'Subject\n\n* one\n\n\n* two\n\n---------')" "$got"

got=$(printf 'Subject\n\nCo-authored-by: Ada Obi <ada@example.test>\n' | bash "$F")
eq "a human co-author is kept" "$(printf 'Subject\n\nCo-authored-by: Ada Obi <ada@example.test>')" "$got"

got=$(printf 'Let Claude and Cursor review the brief\n\nThe claude profile is no longer used.\n' | bash "$F")
eq "a message that only mentions the tools is untouched" "$(printf 'Let Claude and Cursor review the brief\n\nThe claude profile is no longer used.')" "$got"

printf 'S\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' | bash "$F" --check && { echo "FAIL --check missed a trailer"; fail=1; } || echo "ok   --check reports a trailer"
printf 'S\n\nbody\n' | bash "$F" --check && echo "ok   --check passes a clean message" || { echo "FAIL --check on a clean message"; fail=1; }

# The hook, on a real commit.
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git init -q "$T/r" && mkdir -p "$T/r/scripts" "$T/r/.githooks"
cp "$F" "$T/r/scripts/"; cp "$ROOT/.githooks/commit-msg" "$T/r/.githooks/"
git -C "$T/r" config core.hooksPath .githooks
git -C "$T/r" -c user.name=t -c user.email=t@example.test commit -q --allow-empty \
  -m "Add a thing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
eq "a commit made with the hook on has no AI co-author" "Add a thing" "$(git -C "$T/r" log -1 --format=%B | sed -e :a -e '/^[[:space:]]*$/{$d;N;ba' -e '}')"

exit "$fail"
