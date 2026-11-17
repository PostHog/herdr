#!/bin/bash
# Calls a Slack Web API method as you: slack-api.sh <method> [name=value ...], prints Slack's JSON.
# The user token (your Slack app, user scopes only) lives in the login
# keychain (service "herdr-slack"); it reaches curl through its config on stdin, so it never shows
# up in a process list.
set -euo pipefail

method="$1"
shift
if ! token=$(security find-generic-password -s herdr-slack -w 2>/dev/null); then
  echo '{"ok":false,"error":"no_token"}'
  exit 0
fi
params=()
for kv in "$@"; do params+=(--data-urlencode "$kv"); done
printf 'header = "Authorization: Bearer %s"\n' "$token" |
  curl -sS --max-time 25 -K - -G ${params[@]+"${params[@]}"} "https://slack.com/api/$method"
