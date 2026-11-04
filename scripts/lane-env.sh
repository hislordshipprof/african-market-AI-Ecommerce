#!/usr/bin/env bash
# Filter a lane .env.local and clear inherited write credentials in this shell.
# Source this file. Running it as a script cannot unset the caller's variables.
_LANE_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prepare_lane_env() {
  local ticket="$1" src="$2" dest="$3" ticket_env="$4"
  local directives line
  node "$_LANE_ENV_DIR/lane-env.mjs" filter "$ticket" "$src" "$dest" "$ticket_env" || return 1
  directives="$(node "$_LANE_ENV_DIR/lane-env.mjs" child-env "$ticket" "$ticket_env")" || return 1
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      unset\ [A-Z_][A-Z0-9_]*) unset "${line#unset }" ;;
      *) echo "lane-env: refused directive" >&2; return 1 ;;
    esac
  done <<< "$directives"
}
