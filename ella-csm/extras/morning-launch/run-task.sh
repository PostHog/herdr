#!/bin/zsh
# Runs one task file in Claude Code (auto mode). Called by launch.sh in a Herdr tab.
# The session ticks itself off on the morning board by writing NN-slug.done.md.
f="$1"
name="$(head -1 "$f" | sed 's/^# *//')"
done_file="${f%.md}.done.md"
exec ${CLAUDE_BIN:-claude} --permission-mode auto -n "$name" "$(cat "$f" "$HOME/morning-launch/preamble.md")

Write your handover to: $done_file"
