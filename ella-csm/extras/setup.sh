#!/bin/zsh
# Puts the parts of ella-csm that live outside Herdr's config folder in place:
# scripts in ~/.local/bin, the to-do helpers in ~/morning-launch, the scene themes,
# the /plan-tomorrow skill and the launchd jobs. ../install.sh at the repo root does
# the mods and the layout; run that first.
#
#   zsh setup.sh --dry-run    say what it would do, change nothing
#   zsh setup.sh              do it
#
# It never overwrites: a file you already have is kept and listed. The launchd jobs
# are copied but not started; it prints the commands to start them.
set -e
[[ -n "$HOME" && -d "$HOME" ]] || { echo "HOME isn't set"; exit 1; }
HERE=${0:A:h}
APP=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
DRY=0; [[ "$1" == --dry-run ]] && DRY=1
kept=() placed=()

put() {  # put <source> <destination> [exec]
  local src=$1 dst=$2
  if [[ -e "$dst" ]]; then kept+=("$dst"); return; fi
  placed+=("$dst")
  (( DRY )) && return
  mkdir -p "${dst:h}"
  # Templates say /Users/YOU where your home folder goes (launchd needs full paths).
  sed "s|/Users/YOU|$HOME|g" "$src" > "$dst"
  [[ -n "$3" ]] && chmod +x "$dst"
  return 0
}

[[ -d "$APP" ]] || { echo "No Herdr home at $APP. Open Herdr once, then run ../install.sh first."; exit 1; }
for f in $HERE/bin/*(.); do put $f $HOME/.local/bin/${f:t} x; done
for f in todo-agent todo-slack; do put $HERE/morning-launch/$f $HOME/morning-launch/$f x; done
for f in run-todo.sh launch.sh run-task.sh; do put $HERE/morning-launch/$f $HOME/morning-launch/$f x; done
for f in todo-preamble.md todo-alert-preamble.md preamble.md; do put $HERE/morning-launch/$f $HOME/morning-launch/$f; done
put $HERE/morning-launch/heard/heard.py $HOME/morning-launch/heard/heard.py x
for f in $HERE/morning-launch/tests/*(.); do put $f $HOME/morning-launch/tests/${f:t}; done
for f in $HERE/themes/*.json; do put $f $APP/themes/${f:t}; done
put $HERE/skills/plan-tomorrow/SKILL.md $HOME/.claude/skills/plan-tomorrow/SKILL.md
for f in $HERE/launchd/*.plist; do put $f $HOME/Library/LaunchAgents/${f:t}; done
(( DRY )) || mkdir -p $HOME/morning-launch/{todo-prep,todo-links,work,logs} $HOME/book/spaces
(( DRY )) || [[ -e $HOME/morning-launch/todo.md ]] || print -- "- [ ] try the to-do panel" > $HOME/morning-launch/todo.md

(( DRY )) && echo "Would place:" || echo "Placed:"
printf '  %s\n' $placed
(( ${#kept} )) && { echo "Kept yours (not overwritten):"; printf '  %s\n' $kept; }
echo
echo "Before starting the background jobs, fill in the EDIT ME parts (README.md, 'Make it yours')."
echo "Then start the ones you want:"
for f in $HERE/launchd/*.plist; do echo "  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${f:t}"; done
