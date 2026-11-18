#!/usr/bin/env bash
# PostToolUse hook: when a Claude session running inside Herdr opens a pull request,
# label its terminal with the PR so Herdr's Tasks panel lists it under that task.
# One label per PR (task-pr/<owner>/<repo>#<number>=<url>), so no read-modify-write.

set -euo pipefail

[ -n "${HC_TERMINAL_ID:-}" ] || exit 0

input="$(cat)"
tool="$(jq -r '.tool_name // ""' <<<"$input")"

if [ "$tool" = "Bash" ]; then
  case "$(jq -r '.tool_input.command // ""' <<<"$input")" in
    *"gh pr create"*) ;;
    *) exit 0 ;;
  esac
fi

jq -r '.tool_response | tostring' <<<"$input" |
  grep -oE 'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+' |
  sort -u |
  while read -r url; do
    key="$(sed -E 's#^https://github\.com/([^/]+)/([^/]+)/pull/([0-9]+)$#task-pr/\1/\2\#\3#' <<<"$url")"
    hc label "$HC_TERMINAL_ID" "$key=$url" >/dev/null
  done
