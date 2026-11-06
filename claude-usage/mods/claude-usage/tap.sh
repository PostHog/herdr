#!/bin/sh
umask 077
dir="$(cd "$(dirname "$0")/../.." && pwd)/data/claude-usage"
payload="$(cat)"
sid="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)"
if [ -n "$sid" ]; then
  mkdir -p "$dir/sessions"
  if tmp="$(mktemp "$dir/sessions/.$sid.XXXXXX")"; then
    { printf '%s' "$payload" > "$tmp" && mv -f "$tmp" "$dir/sessions/$sid.json"; } || rm -f "$tmp"
  fi
fi
backup="${1:-$dir}"
if [ -s "$backup/original-command" ]; then
  printf '%s' "$payload" | sh -c "$(cat "$backup/original-command")"
fi
