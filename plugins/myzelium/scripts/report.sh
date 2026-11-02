#!/usr/bin/env bash
# Myzelium session reporter. Forwards one Claude Code hook event to Myzelium,
# plus what the hook cannot know itself: the repo's remote, branch, head and
# the files the branch touches. Needs only bash, git and curl.
#
# Never fails the session: every error path exits 0, and the hook is async.
# Kill switch: MYZELIUM_SESSIONS_DISABLE=1.

[ -n "${MYZELIUM_SESSIONS_DISABLE:-}" ] && exit 0
key="${CLAUDE_PLUGIN_OPTION_API_KEY:-${MYZELIUM_API_KEY:-}}"
[ -z "$key" ] && exit 0
url="${CLAUDE_PLUGIN_OPTION_API_URL:-${MYZELIUM_API_URL:-https://api.myzelium.ai}}"
url="${url%/}"
command -v curl >/dev/null 2>&1 || exit 0

input=$(cat)
# Top-level string fields of the hook JSON. A quote inside a string value is
# escaped (\"), so `"name":` cannot match inside the prompt text.
field() {
  printf '%s' "$input" | tr '\n' ' ' \
    | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}
event=$(field hook_event_name)
sid=$(field session_id)
[ -z "$event" ] || [ -z "$sid" ] && exit 0

# Tell this session's channel server (scripts/channel.mjs) which session it
# serves. The server is a child of the same claude process as this hook, so
# the file is keyed by that pid; it follows /clear and --resume, which change
# the session id inside one process. Written for the hook's parent and
# grandparent, because a shell may or may not sit between claude and us.
pid_dir="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}/myzelium}/by-pid"
if mkdir -p "$pid_dir" 2>/dev/null; then
  [ "$event" = "SessionStart" ] && for f in "$pid_dir"/*; do
    [ -e "$f" ] && { kill -0 "${f##*/}" 2>/dev/null || rm -f "$f"; }
  done
  p=$PPID
  for _ in 1 2; do
    case "$p" in ''|*[!0-9]*|0|1) break ;; esac
    printf '%s' "$sid" > "$pid_dir/$p"
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
fi

# A permission prompt blocks the turn; the next PostToolUse means it was
# answered. Only that one PostToolUse is sent — the rest would be noise.
state_dir="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}/myzelium}/waiting"
marker="$state_dir/$sid"
case "$event" in
  Notification)
    case "$(field notification_type)" in
      permission_prompt|elicitation_dialog|agent_needs_input) mkdir -p "$state_dir" && : > "$marker" ;;
    esac ;;
  PostToolUse)
    [ -f "$marker" ] || exit 0
    rm -f "$marker" ;;
  UserPromptSubmit|Stop|StopFailure|SessionEnd)
    rm -f "$marker" 2>/dev/null ;;
esac

cwd=$(field cwd)
[ -n "$cwd" ] && [ -d "$cwd" ] || cwd="$PWD"
remote="" branch="" head="" files=""
if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  remote=$(git -C "$cwd" remote get-url origin 2>/dev/null)
  branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
  head=$(git -C "$cwd" rev-parse --short=12 HEAD 2>/dev/null)
  # What the branch changes: committed vs its merge base with the default
  # branch, plus uncommitted. Only when a turn ends — cheap, but not free.
  if [ "$event" = "Stop" ] || [ "$event" = "SessionStart" ]; then
    base=""
    for ref in origin/HEAD origin/main origin/master; do
      base=$(git -C "$cwd" merge-base HEAD "$ref" 2>/dev/null) && [ -n "$base" ] && break
    done
    files=$( { [ -n "$base" ] && git -C "$cwd" diff --name-only "$base" 2>/dev/null
               git -C "$cwd" status --porcelain -uall 2>/dev/null | cut -c4- | sed 's/.* -> //'; } \
             | sort -u | head -n 80 | paste -sd '|' -)
    [ -z "$files" ] && files="-"
  fi
fi
# An explicit binding wins, as in the Myzelium MCP: the nearest
# .context-hub/project.json at or above the session folder. This is what binds
# a session started in a parent folder that is not itself a git repo.
project_id=""
dir="$cwd"
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -f "$dir/.context-hub/project.json" ]; then
    project_id=$(tr '\n' ' ' < "$dir/.context-hub/project.json" \
      | sed -n 's/.*"projectId"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]\{36\}\)".*/\1/p')
    break
  fi
  dir=$(dirname "$dir")
done

# Strip credentials from an https remote before it leaves the machine.
remote=$(printf '%s' "$remote" | sed -E 's#://[^/@]+@#://#')

timeout=8
[ "$event" = "SessionEnd" ] && timeout=2
args=(-sS -o /dev/null -m "$timeout" -X POST "$url/local-sessions/events"
  -H "Authorization: Bearer $key" -H "Content-Type: application/json"
  -H "x-myz-host: $(hostname -s 2>/dev/null || hostname)")
[ -n "$remote" ] && args+=(-H "x-myz-git-remote: $remote")
[ -n "$branch" ] && args+=(-H "x-myz-branch: $branch")
[ -n "$head" ] && args+=(-H "x-myz-head: $head")
[ -n "$files" ] && args+=(-H "x-myz-files: $files")
[ -n "$project_id" ] && args+=(-H "x-myz-project-id: $project_id")
# Where the session runs, so Myzelium can say where to answer it: a session
# spawned by `claude remote-control` carries CLAUDE_CODE_ENVIRONMENT_KIND=bridge
# and can be answered in the Claude app; anything else is a terminal.
if [ "${CLAUDE_CODE_ENVIRONMENT_KIND:-}" = "bridge" ]; then
  args+=(-H "x-myz-surface: remote-control")
else
  args+=(-H "x-myz-surface: terminal")
fi
printf '%s' "$input" | curl "${args[@]}" --data-binary @- >/dev/null 2>&1
exit 0
