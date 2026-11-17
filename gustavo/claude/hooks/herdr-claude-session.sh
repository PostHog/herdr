#!/usr/bin/env bash
# SessionStart / SessionEnd hook: labels the Herdr terminal a Claude session runs in with that
# session's id, folder and account, so Herdr's tasks mod can `claude --resume` it after a reboot
# (a lost terminal comes back as a plain shell with the same address and labels).
# SessionEnd removes the labels when the user quits on purpose, so a closed session stays closed.

set -euo pipefail

[ -n "${HC_TERMINAL_ID:-}" ] || exit 0

input="$(cat)"
event="$(jq -r '.hook_event_name // ""' <<<"$input")"
session="$(jq -r '.session_id // ""' <<<"$input")"
[ -n "$session" ] || exit 0

# Only the terminal's own Claude: a `claude -p` started from a tool inherits HC_TERMINAL_ID too.
# The nearest claude above this hook must be the terminal's foreground program.
fg="$(hc get "$HC_TERMINAL_ID" --json | jq -r '.foreground.pid // ""')"
pid=$PPID
while [ "$pid" -gt 1 ] && [ "$(ps -o comm= -p "$pid" | xargs basename 2>/dev/null)" != "claude" ]; do
  pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
done
[ "$pid" = "$fg" ] || exit 0

case "$event" in
  SessionStart)
    dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    dir="${dir%/}"
    case "$dir" in
      "$HOME/.claude") account=main ;;
      *) account="$(basename "$dir")" ;;
    esac
    hc label "$HC_TERMINAL_ID" \
      "claude.session=$session" \
      "claude.cwd=$(jq -r '.cwd // ""' <<<"$input")" \
      "claude.account=$account" \
      "claude.at=$(($(date +%s) * 1000))" >/dev/null
    ;;
  SessionEnd)
    case "$(jq -r '.reason // ""' <<<"$input")" in
      prompt_input_exit | logout)
        hc label "$HC_TERMINAL_ID" claude.session= claude.cwd= claude.account= claude.at= >/dev/null
        ;;
    esac
    ;;
esac
