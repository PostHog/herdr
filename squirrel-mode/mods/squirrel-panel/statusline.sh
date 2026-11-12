#!/bin/sh
# Claude Code statusLine command for Squirrel Mode. Saves the status Claude passes in (context
# window, cost, plan limits) under the Herdr terminal it runs in, tagged with the Claude config
# folder so each subscription's limits stay apart. Then it runs the command saved in
# data/squirrel/next-command, if any (your own statusline, or another piece's), so it can be chained.
umask 077
dir="$(cd "$(dirname "$0")/../.." && pwd)/data/squirrel"
payload="$(cat)"
if [ -n "$HC_TERMINAL_ID" ]; then
  mkdir -p "$dir/context"
  config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  tmp="$dir/context/.$HC_TERMINAL_ID.$$"
  { printf '{"config_dir":"%s","status":%s}' "$config" "${payload:-null}" > "$tmp" && mv -f "$tmp" "$dir/context/$HC_TERMINAL_ID.json"; } || rm -f "$tmp"
fi
if [ -s "$dir/next-command" ]; then
  printf '%s' "$payload" | sh -c "$(cat "$dir/next-command")"
fi
