#!/bin/sh
umask 077
dir="$(cd "$(dirname "$0")/../.." && pwd)/data/claude-usage"
payload="$(cat)"
sid="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)"
if [ -n "$sid" ]; then
  mkdir -p "$dir/sessions"
  printf '%s' "$payload" > "$dir/sessions/$sid.json.tmp" && mv -f "$dir/sessions/$sid.json.tmp" "$dir/sessions/$sid.json"
fi
backup="${1:-$dir}"
if [ -s "$backup/original-command" ]; then
  printf '%s' "$payload" | sh -c "$(cat "$backup/original-command")"
fi
