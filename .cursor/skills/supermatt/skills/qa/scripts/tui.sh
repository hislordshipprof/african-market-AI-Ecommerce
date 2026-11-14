#!/bin/sh
# Usage: tui.sh start SESSION COLS ROWS COMMAND [ARG...]
#        tui.sh keys SESSION [-l] KEY...
#        tui.sh press SESSION [-l] KEY...
#        tui.sh wait SESSION TEXT [SECONDS]
#        tui.sh gone SESSION TEXT [SECONDS]
#        tui.sh show SESSION
#        tui.sh resize SESSION COLS ROWS
#        tui.sh colors SESSION
#        tui.sh stop SESSION
#
# Drives a terminal program in a detached tmux session.
#
# start runs COMMAND in a COLS x ROWS session from a launch script, so no
# command line is typed into the pane. Tabs reach the screen as spaces, and the
# pane stays after COMMAND exits, so its last screen and its exit status
# (tmux display -p -t SESSION '#{pane_dead_status}') remain to read. Put the
# environment on COMMAND: env HOME=... PATH=... PROGRAM.
#
# keys sends each KEY through tmux send-keys: text, or a key name such as
# Enter, Escape, BSpace, Up, or C-c. A -l sends the KEY after it as literal
# text, so text that reads as a key name is typed as written. It pauses after
# Escape, so the next key does not reach the program as Alt+key, and it escapes
# a trailing ;, which tmux would read as its command separator.
#
# press sends the keys as keys does, then polls the screen every 0.1 seconds
# and prints it once it stays the same for 0.3 seconds. It exits 1 and prints
# the screen when it still changes after 5 seconds, such as under a clock.
#
# wait polls the screen every 0.1 seconds until it contains TEXT, a fixed
# string, and prints it. It exits 1 and prints the screen once SECONDS (a whole
# number, 10 by default) pass, or once the program has exited without showing
# TEXT. TEXT must fit on one line of the screen, since a narrow pane wraps a
# long message. gone does the same until TEXT is off the screen.
#
# show prints the screen without trailing blank lines, and
# each Nerd Font icon (a private use code point) as [U+XXXX].
#
# resize changes the window to COLS x ROWS, then prints the screen as press
# does, once the program's redraw has settled.
#
# colors prints each run of text that is not blank as ROW COLOR "TEXT", one
# run per line. COLOR is the foreground: #rrggbb, a palette index as c3, or
# default, with +bold on a bold run.
set -u

usage() {
  echo "usage: tui.sh start SESSION COLS ROWS COMMAND [ARG...] | keys SESSION [-l] KEY... | press SESSION [-l] KEY... |" \
    "wait SESSION TEXT [SECONDS] | gone SESSION TEXT [SECONDS] | show SESSION | resize SESSION COLS ROWS | colors SESSION |" \
    "stop SESSION" >&2
  exit 2
}

start() {
  [ $# -ge 4 ] || usage
  session=$1 cols=$2 rows=$3
  shift 3
  launch="$(mktemp "${TMPDIR:-/tmp}/tui-launch.XXXXXX")" || return 1
  {
    echo 'rm -f "$0"'
    echo 'stty oxtabs 2>/dev/null || stty tab3'
    printf exec
    for arg; do
      printf " '%s'" "$(printf '%s' "$arg" | LC_ALL=C sed "s/'/'\\\\''/g")"
    done
    echo
  } > "$launch" || { rm -f "$launch"; return 1; }
  quoted_launch=$(printf '%s' "$launch" | LC_ALL=C sed "s/'/'\\\\''/g")
  if tmux new-session -d -s "$session" -x "$cols" -y "$rows" -c "$PWD" 'sleep 86400' &&
    tmux set-option -t "$session" remain-on-exit on > /dev/null &&
    tmux respawn-pane -k -t "$session" "sh '$quoted_launch'"; then
    return 0
  fi
  rm -f "$launch"
  return 1
}

# keys pauses after Escape, since a program reads Escape and the key right after it as one Alt+key.
keys() {
  session=$1
  shift
  literal=
  for key; do
    if [ "$key" = -l ] && [ -z "$literal" ]; then
      literal=-l
      continue
    fi
    case $key in
      *\;) key="${key%;}\\;" ;; # tmux reads a trailing ; as its command separator
    esac
    tmux send-keys -t "$session" $literal -- "$key" || exit 1
    literal=
    if [ "$key" = Escape ]; then
      sleep 0.2
    fi
  done
}

show() {
  capture="$(tmux capture-pane -p -t "$1")" || return 1
  printf '%s\n' "$capture" |
    perl -CSD -0777 -pe 's/([\x{e000}-\x{f8ff}\x{f0000}-\x{10ffff}])/sprintf("[U+%04X]", ord $1)/ge; s/\n+\z/\n/'
}

# colors reads the SGR codes of capture-pane -e. tmux carries the attributes
# from one row to the next, so the state carries too.
colors() {
  capture="$(tmux capture-pane -p -e -t "$1")" || return 1
  printf '%s\n' "$capture" | perl -CSD -ne '
    BEGIN { $fg = "default"; $bold = "" }
    sub run { my $t = shift; $t =~ s/([\x{e000}-\x{f8ff}\x{f0000}-\x{10ffff}])/sprintf("[U+%04X]", ord $1)/ge;
      print qq($. $fg$bold "$t"\n) if $t =~ /\S/ }
    chomp;
    for my $part (split /(\e\[[0-9;:]*m)/) {
      if ($part !~ /^\e\[([0-9;:]*)m$/) { run($part); next }
      my @p = split /[;:]/, $1;
      @p = (0) unless @p;
      while (@p) {
        my $c = shift @p;
        if ($c eq "" || $c == 0) { $fg = "default"; $bold = "" }
        elsif ($c == 1) { $bold = "+bold" }
        elsif ($c == 22) { $bold = "" }
        elsif ($c == 39) { $fg = "default" }
        elsif ($c >= 30 && $c <= 37) { $fg = "c" . ($c - 30) }
        elsif ($c >= 90 && $c <= 97) { $fg = "c" . ($c - 82) }
        elsif ($c == 38 || $c == 48) {
          my $mode = shift @p;
          my $color = $mode == 5 ? "c" . shift(@p) : sprintf("#%02x%02x%02x", splice(@p, 0, 3));
          $fg = $color if $c == 38;
        }
      }
    }'
}

# wait_for polls until TEXT is on the screen (want=yes) or off it (want=no).
wait_for() {
  want=$1 session=$2 text=$3 tries=$((${4:-10} * 10))
  while :; do
    # Read whether the program has exited before the screen, so a dead pane's screen is final.
    dead="$(tmux display -p -t "$session" '#{pane_dead}')" || exit 1
    screen="$(show "$session")" || return 1
    case $screen in
    *"$text"*) shown=yes ;;
    *) shown=no ;;
    esac
    if [ "$shown" = "$want" ]; then
      printf '%s\n' "$screen"
      return 0
    fi
    if [ "$dead" = 1 ] || [ "$tries" -le 0 ]; then
      printf '%s\n' "$screen"
      echo "tui.sh: timed out while \"$text\" on screen was still $shown" >&2
      return 1
    fi
    tries=$((tries - 1))
    sleep 0.1
  done
}

# settle polls until the screen stays the same for three polls in a row, then prints it.
settle() {
  session=$1 tries=50 same=0
  last="$(show "$session")" || return 1
  while [ "$same" -lt 3 ]; do
    if [ "$tries" -le 0 ]; then
      printf '%s\n' "$last"
      echo "tui.sh: the screen still changes after 5 seconds: read it with wait" >&2
      return 1
    fi
    tries=$((tries - 1))
    sleep 0.1
    screen="$(show "$session")" || return 1
    if [ "$screen" = "$last" ]; then
      same=$((same + 1))
    else
      same=0 last=$screen
    fi
  done
  printf '%s\n' "$last"
}

# The default tmux socket is shared by every session on the machine, so another
# session's kill-server would take the program down mid-run.
if [ -z "${TMUX_TMPDIR:-}" ]; then
  echo "tui.sh: run export TMUX_TMPDIR=\$DIR first, so this QA run has a tmux server of its own" >&2
  exit 2
fi
# TMUX overrides TMUX_TMPDIR when inherited from an enclosing session.
unset TMUX

[ $# -ge 2 ] || usage
command=$1
shift
case $command in
start) start "$@" ;;
keys) keys "$@" ;;
press) keys "$@" && settle "$1" ;;
wait) [ $# -ge 2 ] || usage; wait_for yes "$@" ;;
gone) [ $# -ge 2 ] || usage; wait_for no "$@" ;;
show) show "$1" ;;
resize) [ $# -ge 3 ] || usage; tmux resize-window -t "$1" -x "$2" -y "$3" && settle "$1" ;;
colors) colors "$1" ;;
stop) tmux kill-session -t "$1" ;;
*) usage ;;
esac
