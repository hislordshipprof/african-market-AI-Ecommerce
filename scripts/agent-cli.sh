#!/usr/bin/env bash
# Engine switch for the headless pipeline. Source it, then call:
#   agent_run <role> <log-file> <prompt> [resume-session-id]
# role: build | light | review | review2 | plan | ship   (picks the engine, model and effort)
# Writes the CLI's JSON output to <log-file>; returns the CLI's exit status.
# Engine: $AGENT_ENGINE, else ENGINE in scripts/agent-engine.env, else claude.
#   claude: claude -p ... --dangerously-skip-permissions --output-format json
#   cursor: Cursor CLI (node index.js) -p --force --trust --output-format json --workspace "$PWD"
# Prompts that start with "/supermatt:<skill>" are rewritten for Cursor to point at the vendored skill in
# .cursor/skills/supermatt/skills/<skill>/SKILL.md, since Cursor has no plugin slash commands.

_AGENT_CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
_REVIEW_ENGINE_OVERRIDE="${REVIEW_ENGINE:-}"
[ -f "$_AGENT_CLI_DIR/agent-engine.env" ] && . "$_AGENT_CLI_DIR/agent-engine.env"
AGENT_ENGINE="${AGENT_ENGINE:-${ENGINE:-claude}}"
REVIEW_ENGINE="${_REVIEW_ENGINE_OVERRIDE:-${REVIEW_ENGINE:-$AGENT_ENGINE}}"

# Resolve the Cursor CLI's bundled node + index.js (newest installed version) so long multi-line prompts
# never pass through cmd.exe quoting.
_cursor_cmd() {
  local base="${CURSOR_AGENT_HOME:-${LOCALAPPDATA:-$HOME/AppData/Local}/cursor-agent}"
  base="$(cygpath -u "$base" 2>/dev/null || echo "$base")"
  if [ -x "$base/node.exe" ] && [ -f "$base/index.js" ]; then echo "$base/node.exe|$base/index.js"; return; fi
  local v
  v=$(ls -1 "$base/versions" 2>/dev/null | grep -E '^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
  [ -n "$v" ] || { echo "Cursor CLI not found under $base. Install it: irm 'https://cursor.com/install?win32=true' | iex" >&2; return 1; }
  echo "$base/versions/$v/node.exe|$base/versions/$v/index.js"
}

_cursor_model() {
  case "$1" in
    review|review2) echo "${CURSOR_REVIEW_MODEL:-}" ;;
    light)  echo "${CURSOR_LIGHT_MODEL:-${CURSOR_BUILD_MODEL:-}}" ;;
    plan)   echo "${CURSOR_PLAN_MODEL:-${CURSOR_BUILD_MODEL:-}}" ;;
    *)      echo "${CURSOR_BUILD_MODEL:-}" ;;
  esac
}

_cursor_prompt() {
  local p="$1" skill rest
  if [[ "$p" =~ ^/supermatt:([a-z-]+)[[:space:]]*(.*)$ ]]; then
    skill="${BASH_REMATCH[1]}"; rest="${p#/supermatt:$skill}"
    printf 'Use the "%s" skill: first read .cursor/skills/supermatt/skills/%s/SKILL.md (and any files it references) and follow it exactly.%s' "$skill" "$skill" "$rest"
  else
    printf '%s' "$p"
  fi
}

# Windows caps a command line at about 32 KB, so a long prompt (a fix round carrying full review reports)
# goes to a file in the ignored .builder/ dir and the agent is told to read it.
_spill_prompt() {
  local p="$1" role="$2"
  if [ "${#p}" -le 20000 ]; then printf '%s' "$p"; return; fi
  mkdir -p .builder
  local f; f="$(pwd -W 2>/dev/null || pwd)/.builder/prompt-$role-$(date +%Y%m%d-%H%M%S)-$$.md"
  printf '%s' "$p" > "$f"
  printf 'Your full instructions are in the file %s (%s characters). Read the WHOLE file first, then follow it exactly.' "$f" "${#p}"
}

# role review runs on REVIEW_ENGINE (codex|cursor|claude); review2 (second RISK reviewer) and every
# other role run on AGENT_ENGINE.
agent_run() {
  local role="$1" log="$2" prompt="$3" resume="${4:-}" engine="$AGENT_ENGINE"
  [ "$role" = review ] && engine="$REVIEW_ENGINE"
  case "$engine" in
    codex)
      # Codex has no plugin slash commands either: same skill rewrite as Cursor. Sandboxed by default
      # (workspace-write plus network, so tests can reach the lane's local Postgres); CODEX_REVIEW_SANDBOX=off
      # gives full access, owner's call. The final message is also saved to <log>.last.md.
      local cx_sandbox=(-s workspace-write -c sandbox_workspace_write.network_access=true)
      [ "${CODEX_REVIEW_SANDBOX:-on}" = off ] && cx_sandbox=(--dangerously-bypass-approvals-and-sandbox)
      codex exec "${cx_sandbox[@]}" --skip-git-repo-check \
        -c model="${CODEX_REVIEW_MODEL:-gpt-6-astra}" -c model_reasoning_effort="${CODEX_REVIEW_EFFORT:-medium}" \
        -o "$log.last.md" "$(_spill_prompt "$(_cursor_prompt "$prompt")" "$role")" < /dev/null > "$log" 2>&1 ;;
    claude)
      local flags=(--dangerously-skip-permissions --strict-mcp-config --output-format json)
      case "$role" in
        light)  flags+=(--model claude-sonnet-5-5 --effort medium) ;;
        build|review|review2) flags+=(--effort high) ;;
      esac
      # Reviews may run on a separate Claude profile. It has no supermatt plugin, so the slash skill is rewritten
      # to the vendored copy, as for Cursor.
      if [ "$role" = review ] || [ "$role" = review2 ]; then
        if [ -n "${REVIEW_CLAUDE_CONFIG_DIR:-}" ]; then
          [ -d "$REVIEW_CLAUDE_CONFIG_DIR" ] || { echo "No Claude profile at $REVIEW_CLAUDE_CONFIG_DIR" >&2; return 2; }
          local -x CLAUDE_CONFIG_DIR="$REVIEW_CLAUDE_CONFIG_DIR"
          prompt="$(_cursor_prompt "$prompt")"
        fi
        [ -n "${REVIEW_CLAUDE_MODEL:-}" ] && flags+=(--model "$REVIEW_CLAUDE_MODEL")
      fi
      if [ -n "$resume" ]; then
        claude -p --resume "$resume" "$(_spill_prompt "$prompt" "$role")" "${flags[@]}" < /dev/null > "$log" 2>&1
      else
        claude -p "$(_spill_prompt "$prompt" "$role")" "${flags[@]}" < /dev/null > "$log" 2>&1
      fi ;;
    cursor)
      local cmd node js model
      cmd=$(_cursor_cmd) || return 127
      node="${cmd%%|*}"; js="${cmd##*|}"
      model=$(_cursor_model "$role")
      local args=(-p --force --trust --approve-mcps --output-format json --workspace "$(pwd -W 2>/dev/null || pwd)")
      [ -n "$model" ] && args+=(--model "$model")
      [ -n "$resume" ] && args+=(--resume "$resume")
      CURSOR_INVOKED_AS=agent NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-${LOCALAPPDATA:-}/cursor-compile-cache}" \
        "$node" "$js" "${args[@]}" "$(_spill_prompt "$(_cursor_prompt "$prompt")" "$role")" < /dev/null > "$log" 2>&1 ;;
    *) echo "Unknown engine '$engine' (claude|cursor|codex)" >&2; return 2 ;;
  esac
}

# Last session/chat id in a log (Claude prints session_id; Cursor's JSON uses session_id or chatId).
agent_session_id() {
  node -e 'const fs=require("fs");try{const t=fs.readFileSync(process.argv[1],"utf8");const m=[...t.matchAll(/"(?:session_id|sessionId|chatId|chat_id)"\s*:\s*"([0-9A-Za-z-]{8,})"/g)].pop();if(m)process.stdout.write(m[1])}catch(e){}' "$1"
}
