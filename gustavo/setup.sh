#!/usr/bin/env bash
# The parts of the gustavo setup that ../install.sh doesn't place: its themes, its key bindings and
# its two Claude Code hooks. Run it once after `./install.sh enable gustavo`. Anything already in the
# way is moved to a timestamped backup first, never overwritten, and each hook is added to
# ~/.claude/settings.json only if it isn't there.
set -euo pipefail

PIECE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
BACKUP="$HERDR/.gustavo-backup/$(date +%Y%m%d-%H%M%S)"

[ -d "$HERDR" ] || { echo "No Herdr config folder at $HERDR. Open Herdr once first." >&2; exit 1; }
command -v jq >/dev/null || { echo "This needs jq (brew install jq)." >&2; exit 1; }

backup() {
  if [ -e "$HERDR/$1" ]; then
    mkdir -p "$BACKUP/$(dirname "$1")"
    mv "$HERDR/$1" "$BACKUP/$1"
    echo "  moved your $1 to $BACKUP"
  fi
}

mkdir -p "$HERDR/themes"
for f in keys.json themes/sand.json themes/mist.json; do
  if ! cmp -s "$PIECE/$f" "$HERDR/$f"; then
    backup "$f"
    cp "$PIECE/$f" "$HERDR/$f"
    echo "  placed $f"
  fi
done

mkdir -p "$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"
[ -f "$SETTINGS" ] || echo '{}' >"$SETTINGS"

# Attaches a PR to its task when `gh pr create` runs (PostToolUse).
cp "$PIECE/claude/hooks/herdr-task-pr.sh" "$HOME/.claude/hooks/"
chmod +x "$HOME/.claude/hooks/herdr-task-pr.sh"
if jq -e '.hooks.PostToolUse[]? | select(.matcher == "Bash|mcp__github__create_pull_request")' "$SETTINGS" >/dev/null; then
  echo "  PR hook already in $SETTINGS"
else
  cp "$SETTINGS" "$SETTINGS.bak-gustavo"
  jq --slurpfile h "$PIECE/claude/settings-hook.json" '.hooks.PostToolUse += $h' "$SETTINGS.bak-gustavo" >"$SETTINGS"
  echo "  added the PR hook to $SETTINGS (previous copy: $SETTINGS.bak-gustavo)"
fi

# Resume after a reboot: labels each terminal with its Claude session (SessionStart), drops them
# when Claude is quit on purpose (SessionEnd).
cp "$PIECE/claude/hooks/herdr-claude-session.sh" "$HOME/.claude/hooks/"
chmod +x "$HOME/.claude/hooks/herdr-claude-session.sh"
if jq -e '.hooks.SessionStart[]?.hooks[]? | select(.command | contains("herdr-claude-session.sh"))' "$SETTINGS" >/dev/null; then
  echo "  session hook already in $SETTINGS"
else
  cp "$SETTINGS" "$SETTINGS.bak-gustavo"
  entry='[{"hooks":[{"type":"command","command":"~/.claude/hooks/herdr-claude-session.sh 2>/dev/null || true","timeout":10}]}]'
  jq --argjson e "$entry" '.hooks.SessionStart += $e | .hooks.SessionEnd += $e' "$SETTINGS.bak-gustavo" >"$SETTINGS"
  echo "  added the session hook to $SETTINGS (previous copy: $SETTINGS.bak-gustavo)"
fi

echo "Done. Switch to it with: herdr-app do layout.switch '{\"name\":\"gustavo\"}'"
