#!/bin/sh
# Human-in-the-loop reproduction loop.
# The agent copies this file and edits the steps below; the user runs it in
# their own terminal (it reads from a TTY, so an agent's shell gets EOF and
# exits) and pastes the Captured block back.
#
# Usage:
#   sh hitl-loop.template.sh
#
# Two helpers:
#   step "<instruction>"          → print the step, wait for Enter
#   capture VAR "<question>"      → print the question, read response into VAR
#
# At the end, captured values are printed as KEY=VALUE for the agent to parse.
#
# `capture` prints its value back to the terminal, where the agent reads it,
# so capture observations, and leave signing in to the user as a `step`.

set -eu

step() {
  printf '\n>>> %s\n    [Enter when done] ' "$1"
  read -r _
}

capture() {
  printf '\n>>> %s\n    > ' "$2"
  read -r "$1"
}

# --- edit below ---------------------------------------------------------

step "Open the app at http://localhost:3000 and sign in."

capture ERRORED "Click the 'Export' button. Did it throw an error? (y/n)"

capture ERROR_MSG "Paste the error message (or 'none'):"

# --- edit above ---------------------------------------------------------

printf '\n--- Captured ---\n'
printf 'ERRORED=%s\n' "$ERRORED"
printf 'ERROR_MSG=%s\n' "$ERROR_MSG"
