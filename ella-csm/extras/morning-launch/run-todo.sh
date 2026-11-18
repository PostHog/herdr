#!/bin/zsh
# Runs one to-do's background prep in Claude Code (auto mode). Called by todo-agent in a Herdr pane.
# A third argument is the Slack post an alert to-do came from: it adds todo-alert-preamble.md (investigate first, verdict line;
# the post goes to <slug>.post.md and verify-output's result to <slug>.verify.json for alert-check).
text="$1"; handover="$2"; alert="$3"
extra=""
if [[ -n "$alert" ]]; then
  pre="$(cat "$HOME/morning-launch/todo-alert-preamble.md")"
  extra="

${pre//SLACK_LINK/$alert}"
  extra="${extra//POST_FILE/${handover%.md}.post.md}"
  extra="${extra//VERIFY_FILE/${handover%.md}.verify.json}"
fi
exec ${CLAUDE_BIN:-claude} --permission-mode auto -n "to-do: $text" "To-do she just added: $text$extra

$(cat "$HOME/morning-launch/todo-preamble.md")

Write your handover to: $handover"
