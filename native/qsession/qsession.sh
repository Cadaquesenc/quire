#!/bin/bash
# qsession: resolve a claude code session from a terminal window title.
#
#   qsession            the frontmost terminal window, then newest writer
#   qsession "<title>"  a window title you already have
#   qsession --newest   skip the window list, take the session that wrote last
#   qsession --list     every terminal window that could carry a session
#
# prints one line: <session-id>\t<cwd>\t<title>\t<how>
#
# `how` is `window` or `newest`. it matters, because reading a window's title
# needs Screen Recording permission and an app that has not been granted it gets
# every title back as nil. quire has not been granted it and will not ask, so
# from inside quire this always lands on `newest`, and that is fine: the session
# that just asked for a note is the session that wrote last.
#
# four things went wrong getting here and all four are load bearing:
#
# 1. match on the aiTitle record, not a substring scan of the transcript. every
#    transcript carries an `ai-title` record whose aiTitle is exactly the window
#    title. a substring scan resolves to the WRONG session the moment one
#    session quotes another's title, which happens constantly.
# 2. read cwd and sessionId out of the transcript, never off the filename. the
#    project directory name is a lossy encoding: "/" and a real "-" both become
#    "-", so -Users-ethangiannaros-Code-personal-site cannot be decoded back to
#    /Users/ethangiannaros/Code/personal-site. longest-existing-prefix does not
#    save it either, it stops at /Users/ethangiannaros/Code.
# 3. filter the window list by owner. the raw list also carries Dock, Wallpaper,
#    Window Server and quire's own windows, none of which host a session.
# 4. `set -e` with pipefail plus `head -1` dies on SIGPIPE, exit 141. use
#    `sed -n 1p`.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WINDOWS="$HERE/qwindows"
HOSTS='Ghostty|Terminal|iTerm|Alacritty|kitty|WezTerm|Warp|Hyper'

list() {
  "$WINDOWS" 2>/dev/null | awk -F'\t' -v h="$HOSTS" '$2 ~ h'
}

transcripts() {
  find "$HOME/.claude/projects" -name '*.jsonl' -type f 2>/dev/null
}

field() {   # field <file> <key>, first occurrence
  grep -o "\"$2\":\"[^\"]*\"" "$1" 2>/dev/null | sed -n 1p | sed "s/.*\"$2\":\"//; s/\"$//"
}

ai_title() {   # the LAST ai-title record. it can be rewritten mid session.
  grep -o '"aiTitle":"[^"]*"' "$1" 2>/dev/null | sed -n '$p' | sed 's/.*"aiTitle":"//; s/"$//'
}

emit() {   # emit <transcript> <title> <how>
  printf '%s\t%s\t%s\t%s\n' "$(field "$1" sessionId)" "$(field "$1" cwd)" "$2" "$3"
}

# the transcript written most recently, whatever it is called
newest_transcript() {
  local best="" newest=0 m
  while IFS= read -r f; do
    m=$(stat -f %m "$f" 2>/dev/null) || continue
    if [ "$m" -gt "$newest" ]; then newest=$m; best=$f; fi
  done < <(transcripts)
  [ -n "$best" ] && printf '%s\n' "$best"
}

# the session whose last aiTitle is exactly this title. newest wins on a tie.
by_title() {
  local want="$1" best="" newest=0 m
  while IFS= read -r f; do
    [ "$(ai_title "$f")" = "$want" ] || continue
    m=$(stat -f %m "$f" 2>/dev/null) || continue
    if [ "$m" -gt "$newest" ]; then newest=$m; best=$f; fi
  done < <(transcripts)
  [ -n "$best" ] && printf '%s\n' "$best"
}

fall_back_to_newest() {
  t=$(newest_transcript) || true
  [ -n "${t:-}" ] || { echo "no transcripts under ~/.claude/projects" >&2; exit 1; }
  emit "$t" "$(ai_title "$t")" newest
  exit 0
}

case "${1:-}" in
  --list)   list; exit 0 ;;
  --newest) fall_back_to_newest ;;
esac

title="${1:-}"
[ -n "$title" ] || title=$(list | sed -n 1p | cut -f3)

# no title means no window list, which on a machine that has not granted Screen
# Recording is the normal case, not an error.
[ -n "$title" ] || fall_back_to_newest

t=$(by_title "$title") || true
[ -n "${t:-}" ] || fall_back_to_newest
emit "$t" "$title" window
