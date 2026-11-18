#!/usr/bin/env bash
# Copies the gustavo layout, its mods, keys, themes and Claude Code hooks from where they run into
# this folder. Run it after changing anything in Herdr, then commit. The private settings
# (data/gustavo/private.json in Herdr's folder) stay out: they name internal places.
set -euo pipefail

PIECE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS=(tasks hogli gh-inbox chrome settings gustavo-menu session-head gustavo-tabs task-empty grafana dungeon history)
THEMES=(sand mist)

mkdir -p "$PIECE/layouts" "$PIECE/mods" "$PIECE/themes" "$PIECE/claude/hooks"
cp "$HERDR/layouts/gustavo.json" "$HERDR/layouts/gustavo.svg" "$PIECE/layouts/"
for theme in "${THEMES[@]}"; do cp "$HERDR/themes/$theme.json" "$PIECE/themes/"; done

for mod in "${MODS[@]}"; do
  rm -rf "${PIECE:?}/mods/$mod"
  mkdir -p "$PIECE/mods/$mod"
  # Herdr writes jsconfig.json and the .d.ts files into every mod folder itself; hidden ones are caches.
  (cd "$HERDR/mods/$mod" && find . -type f ! -name jsconfig.json ! -name '*.d.ts' ! -name '.*' ! -name '*.error' ! -path './.*' -print0 |
    xargs -0 -I{} rsync -R {} "$PIECE/mods/$mod/")
done

cp "$HERDR/keys.json" "$PIECE/keys.json"
cp "$HOME/.claude/hooks/herdr-task-pr.sh" "$HOME/.claude/hooks/herdr-claude-session.sh" "$PIECE/claude/hooks/"
jq '.hooks.PostToolUse[] | select(.matcher == "Bash|mcp__github__create_pull_request")' \
  "$HOME/.claude/settings.json" > "$PIECE/claude/settings-hook.json"

echo "Saved into $PIECE. Review with git diff, then commit."
