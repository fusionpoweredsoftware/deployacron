#!/usr/bin/env bash
# The troubleshooter, in tmux: `ollama launch claude` (or whatever COMMAND is)
# in a detached session that survives the browser, with its screen piped to a
# log. The deployer reads the screen with capture-pane and types with
# send-keys, so there is no PTY to keep alive between the two sides.
#
#   troubleshoot.sh start|status|feed|send|stop|resize
set -u
: "${SESSION:?}" "${WORKDIR:?}"

# ~ in a path that came through the environment is a literal character until
# something expands it; $HOME here is the server's.
expand_home() { case "${1:-}" in "~") printf '%s' "$HOME" ;; "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;; *) printf '%s' "${1:-}" ;; esac; }
WORKDIR="$(expand_home "$WORKDIR")"
DEPLOY_DIR="$(expand_home "${DEPLOY_DIR:-}")"
# What this session was created to run, as recorded when it was created.
# Note the target form: set-option and show-options reject the "=" exact-match
# prefix that the pane commands want, so the session is named with a colon.
session_command() { tmux show-options -qv -t "$SESSION:" @command 2>/dev/null; }

case "${1:-status}" in
  start)
    : "${COMMAND:?}"
    # The directory may not exist yet: the troubleshooter is meant to be usable
    # before the first deploy has put anything on this machine.
    mkdir -p "$WORKDIR" 2>/dev/null || true
    [ -d "$WORKDIR" ] || WORKDIR="$HOME"
    LOGS="${DEPLOY_DIR:-$WORKDIR/.deploy}/logs"; mkdir -p "$LOGS" 2>/dev/null || { DEPLOY_DIR="$WORKDIR/.deploy"; LOGS="$DEPLOY_DIR/logs"; mkdir -p "$LOGS"; }
    # FORCE is what the Restart button sets: whatever is in there goes, and a
    # fresh session takes its place. Without it, an existing session is kept
    # unless it is running something other than what the project asks for.
    if [ "${FORCE:-}" = "1" ] && tmux has-session -t "=$SESSION" 2>/dev/null; then
      echo "restarting $(session_command || echo 'the session')"
      tmux kill-session -t "=$SESSION" 2>/dev/null || true
    fi
    if tmux has-session -t "=$SESSION" 2>/dev/null; then
      # A session keeps the command it was created with, so one started before
      # the setting changed goes on being the old thing however many times you
      # press Start. Start means "run this" — so a mismatch is restarted rather
      # than attached to.
      started="$(session_command)"
      [ "$started" = "$COMMAND" ] && { echo "already running"; exit 0; }
      echo "restarting: this session runs ${started:-something else}, not $COMMAND"
      tmux kill-session -t "=$SESSION" 2>/dev/null || true
    fi
    # Through a login shell, from a file: tmux would otherwise run the command
    # with whatever PATH a non-interactive ssh got, which is how a perfectly
    # installed ollama comes back as "command not found". A file rather than a
    # quoted string because the command is the user's and may contain anything.
    RUN="$(mktemp "${TMPDIR:-/tmp}/troubleshoot.XXXXXX")"
    {
      printf '%s\n' "$COMMAND"
      printf '%s\n' "echo" "echo '[troubleshooter exited — press Enter to close]'" "read -r"
    } > "$RUN"
    # Reported, not assumed: a new-session that fails (a session of this name
    # that would not die, most often) used to be followed by "started" anyway,
    # which is a long way to look for a session that never changed.
    if ! err="$(tmux new-session -d -s "$SESSION" -x "${COLS:-200}" -y "${ROWS:-50}" -c "$WORKDIR" "${SHELL:-/bin/bash} -l '$RUN'" 2>&1)"; then
      echo "could not start it: ${err:-tmux refused}"
      exit 1
    fi
    # What this session is *meant* to be running, recorded on the session
    # itself: the pane's start command is a wrapper and cannot be compared.
    tmux set-option -t "$SESSION:" @command "$COMMAND" 2>/dev/null || true
    # The window is sized by us, not by whoever happens to be attached. With
    # the default ("latest"), a second client — a stale control connection, a
    # terminal somebody left attached — resizes the window under the program,
    # and it redraws for a width the browser's terminal does not have: the
    # menu you were arrowing through comes back duplicated and shifted.
    tmux set-option -t "$SESSION:" window-size manual 2>/dev/null || true
    tmux resize-window -t "=$SESSION:" -x "${COLS:-200}" -y "${ROWS:-50}" 2>/dev/null || true
    tmux pipe-pane -o -t "=$SESSION:" "cat >> '$LOGS/troubleshoot-$(date +%Y%m%d-%H%M%S).log'"
    echo "started"
    ;;
  status)  if tmux has-session -t "=$SESSION" 2>/dev/null; then
             echo running
             # The size the program inside is drawing for. When it does not
             # match the browser's terminal every redraw lands wrong, which
             # looks like duplicated or shifted lines rather than like a size
             # problem — so it is reported rather than left to be deduced.
             echo "size=$(tmux display -p -t "=$SESSION:" '#{window_width}x#{window_height}' 2>/dev/null)"
             echo "clients=$(tmux list-clients -t "$SESSION" -F '#{client_width}x#{client_height}' 2>/dev/null | tr '\n' ',' )"
             # What the program inside believes it is talking to, and whether it
             # has turned mouse reporting on. Those two decide the pointer shape
             # over the output, and they are the program's business, not ours —
             # but a difference between the two panes is worth being able to see.
             echo "term=$(tmux display -p -t "=$SESSION:" '#{pane_tty}' >/dev/null 2>&1; tmux show-environment -t "$SESSION" TERM 2>/dev/null | cut -d= -f2-)"
             echo "mouse=$(tmux display -p -t "=$SESSION:" '#{mouse_any_flag}' 2>/dev/null)"
             # What this session was actually started with. A session outlives a
             # change to the setting, so "running" alone can be running the wrong thing.
             echo "cmd=$(session_command)"
           else echo stopped; fi ;;
  feed)    tmux capture-pane -p -e -J -S - -t "=$SESSION:" 2>/dev/null ;;
  # The visible screen, for painting into a terminal that has just attached.
  # The first line is where the cursor is; the rest is the screen, one pane row
  # per line, NOT joined — a joined line would be re-wrapped by the receiving
  # terminal and everything below it would sit a row too low.
  screen)  # ALT says whether a full-screen program owns the pane. Its screen
           # cannot be reproduced by painting text: scroll regions, origin mode
           # and the cursor go with it, and the program's next partial redraw
           # then lands against a terminal that disagrees. The deployer nudges
           # those into redrawing themselves instead of painting them.
           tmux display -p -t "=$SESSION:" 'ALT #{alternate_on}' 2>/dev/null
           # The modes the program has set. A terminal attaching now never saw
           # the sequences that turned them on, so it disagrees with the pane
           # about mouse reporting (whose cursor it is), about what the arrow
           # keys send, and about whether there is a cursor to show.
           tmux display -p -t "=$SESSION:" 'MODES mouse=#{mouse_any_flag} cursor=#{cursor_flag} appcursor=#{keypad_cursor_flag} keypad=#{keypad_flag}' 2>/dev/null
           tmux display -p -t "=$SESSION:" 'CURSOR #{cursor_y} #{cursor_x}' 2>/dev/null
           tmux capture-pane -p -e -t "=$SESSION:" 2>/dev/null ;;
  send)    tmux send-keys -t "=$SESSION:" -l "${TEXT:-}" && tmux send-keys -t "=$SESSION:" Enter ;;
  # One page of this pane's history, as text. START and END are tmux line
  # numbers: 0 is the top of the visible pane, negatives go back into history.
  # Copy mode is no use here — it is drawn by the client, and a control-mode
  # client never sees the overlay — so the deployer pages by reading history
  # and painting it itself.
  history) tmux capture-pane -p -e -J -S "${START:--20}" -E "${END:--1}" -t "=$SESSION:" 2>/dev/null ;;
  # How far back the history goes, in lines.
  depth)   tmux display -p -t "=$SESSION:" '#{history_size}' 2>/dev/null ;;
  keys)    tmux send-keys -t "=$SESSION:" ${KEYS:?} ;;
  resize)  tmux set-option -t "$SESSION:" window-size manual 2>/dev/null || true
           tmux resize-window -t "=$SESSION:" -x "${COLS:-200}" -y "${ROWS:-50}" 2>/dev/null || true ;;
  stop)    tmux kill-session -t "=$SESSION" 2>/dev/null && echo stopped || echo "not running" ;;
  *) echo "usage: $0 start|status|feed|screen|history|depth|send|keys|resize|stop|context"; exit 1 ;;
esac
