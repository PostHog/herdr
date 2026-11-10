#!/usr/bin/env bash
# Installs the Herdr layouts and mods in this repo into Herdr's config folder.
#
#   ./install.sh                 pull the latest, then update what you enabled (asks about new pieces)
#   ./install.sh list            every piece, and whether it's enabled here
#   ./install.sh enable <piece>  install a piece
#   ./install.sh disable <piece> remove a piece
#   --no-pull                    skip `git pull`
#
# A piece is a top-level folder with a RECIPE.md. Its layouts/ and mods/ are copied
# into ~/.config/herdr-app (or $HERDR_APP_HOME). They're copies, not symlinks, because
# Herdr refuses modules and images that resolve outside its folder. Each run copies
# what changed, and Herdr reloads it. What you enabled, and every file this script
# placed, is kept in that folder.

set -euo pipefail

REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
ENABLED_FILE="$HOME_DIR/.posthog-herdr-enabled"
SEEN_FILE="$HOME_DIR/.posthog-herdr-seen"
# One line per placed file: <piece><TAB><path under HOME_DIR>.
MANIFEST="$HOME_DIR/.posthog-herdr-files"
BACKUP_DIR="$HOME_DIR/.posthog-herdr-backup/$(date +%Y%m%d-%H%M%S)"
TAB=$'\t'

bold() { printf '\033[1m%s\033[0m' "$*"; }
dim() { printf '\033[2m%s\033[0m' "$*"; }
say() { printf '%s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

MERGED_PIECES="github-and-trunk:pull-requests"

merged_into() {
  local pair
  for pair in $MERGED_PIECES; do
    if [ "${pair%%:*}" = "$1" ]; then
      printf '%s' "${pair#*:}"
      return 0
    fi
  done
  return 1
}

pieces() {
  local d name
  for d in "$REPO"/*/; do
    name="$(basename "$d")"
    [ -f "$d/RECIPE.md" ] && ! merged_into "$name" >/dev/null && printf '%s\n' "$name"
  done
  return 0
}

is_piece() { [ -f "$REPO/$1/RECIPE.md" ]; }

# The first sentence of the recipe's opening paragraph.
summary() {
  local line
  line="$(awk 'NF && !/^#/ && !/^!\[/ { print; exit }' "$REPO/$1/RECIPE.md" | sed -E 's/\. .*/./')"
  if [ "${#line}" -gt 90 ]; then line="${line:0:87}..."; fi
  printf '%s' "$line"
}

enabled() { [ -f "$ENABLED_FILE" ] && grep -qx "$1" "$ENABLED_FILE"; }
seen() { [ -f "$SEEN_FILE" ] && grep -qx "$1" "$SEEN_FILE"; }

remember() {
  local file="$1" name="$2"
  touch "$file"
  grep -qxF "$name" "$file" || printf '%s\n' "$name" >>"$file"
}

forget() {
  local file="$1" name="$2"
  [ -f "$file" ] || return 0
  grep -vxF "$name" "$file" >"$file.tmp" || true
  mv "$file.tmp" "$file"
}

# The piece that placed a path, if this script placed it.
owner() {
  [ -f "$MANIFEST" ] || return 0
  awk -F'\t' -v p="$1" '$2 == p { print $1; exit }' "$MANIFEST"
}

# Herdr restores its own mods and layouts on every start, so a piece can't reuse their names.
shipped() {
  local key="$1"
  [ -f "$HOME_DIR/installed.json" ] && grep -Eq "\"$key\"[[:space:]]*:" "$HOME_DIR/installed.json"
}

# Files Herdr writes into mod folders itself.
herdr_written() {
  case "$(basename "$1")" in
    jsconfig.json | *.d.ts | .* | *.error) return 0 ;;
  esac
  return 1
}

# Moves something of the person's out of the way, keeping it.
backup() {
  local rel="$1"
  mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
  mv "$HOME_DIR/$rel" "$BACKUP_DIR/$rel"
  say "  moved your $rel to $(dim "${BACKUP_DIR#"$HOME_DIR"/}")" >&2
}

# Copies one file when it changed. Herdr sees the new file and reloads what uses it.
place() {
  local src="$1" rel="$2" dst="$HOME_DIR/$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] || ! cmp -s "$src" "$dst"; then
    rm -rf "$dst"
    cp "$src" "$dst"
  fi
}

# The top-level thing a piece adds (a layout file or a mod folder), checked for clashes.
# Prints nothing when it can't be placed.
claim() {
  local piece="$1" rel="$2" key="$3" other
  if shipped "$key"; then
    warn "  skip $rel: Herdr ships one with that name. Rename it in $piece/."
    return 0
  fi
  other="$(owner "$rel")"
  if [ -n "$other" ] && [ "$other" != "$piece" ]; then
    warn "  skip $rel: the piece $other already has it."
    return 0
  fi
  if [ -z "$other" ] && { [ -e "$HOME_DIR/$rel" ] || [ -L "$HOME_DIR/$rel" ]; }; then
    backup "$rel"
  fi
  printf '%s' "$rel"
}

install_piece() {
  local piece="$1" src rel f mod placed
  placed="$(mktemp)"
  say "$(bold "$piece")"

  for src in "$REPO/$piece"/layouts/*; do
    [ -f "$src" ] || continue
    f="$(basename "$src")"
    rel="$(claim "$piece" "layouts/$f" "layout:${f%.*}")"
    [ -n "$rel" ] || continue
    place "$src" "$rel"
    printf '%s\t%s\n' "$piece" "$rel" >>"$placed"
  done

  for mod in "$REPO/$piece"/mods/*/; do
    [ -d "$mod" ] || continue
    mod="$(basename "$mod")"
    rel="$(claim "$piece" "mods/$mod" "$mod")"
    [ -n "$rel" ] || continue
    printf '%s\t%s\n' "$piece" "$rel" >>"$placed"
    while IFS= read -r f; do
      herdr_written "$f" && continue
      place "$REPO/$piece/mods/$mod/$f" "$rel/$f"
      printf '%s\t%s\n' "$piece" "$rel/$f" >>"$placed"
    done < <(cd "$REPO/$piece/mods/$mod" && find . -type f | sed 's|^\./||' | sort)
  done

  # Files this piece placed before that it no longer has.
  if [ -f "$MANIFEST" ]; then
    while IFS="$TAB" read -r p rel; do
      [ "$p" = "$piece" ] || continue
      grep -qxF "$piece$TAB$rel" "$placed" && continue
      [ -d "$HOME_DIR/$rel" ] || rm -f "$HOME_DIR/$rel"
    done <"$MANIFEST"
    grep -v "^$piece$TAB" "$MANIFEST" >>"$placed" || true
  fi
  mv "$placed" "$MANIFEST"
  say "  up to date"

  if [ -f "$REPO/$piece/keys.json" ]; then
    warn "  $piece/keys.json has key bindings. Merge the ones you want into $HOME_DIR/keys.json by hand."
  fi
}

# Removes what disabled or deleted pieces placed. Mod folders go once only Herdr's own files are left.
prune() {
  [ -f "$MANIFEST" ] || return 0
  local keep p rel dir
  keep="$(mktemp)"
  while IFS="$TAB" read -r p rel; do
    if enabled "$p" && is_piece "$p"; then
      printf '%s\t%s\n' "$p" "$rel" >>"$keep"
    elif [ -d "$HOME_DIR/$rel" ]; then
      dir="$HOME_DIR/$rel"
      if [ -z "$(find "$dir" -type f ! -name jsconfig.json ! -name '*.d.ts' ! -name '.*' ! -name '*.error' 2>/dev/null | head -1)" ]; then
        rm -rf "$dir"
        say "  removed $rel"
      fi
    else
      rm -f "$HOME_DIR/$rel"
    fi
  done < <(sort -r -t "$TAB" -k2 "$MANIFEST")
  mv "$keep" "$MANIFEST"
}

migrate() {
  local pair old new moved=0
  for pair in $MERGED_PIECES; do
    old="${pair%%:*}" new="${pair#*:}"
    enabled "$old" || continue
    forget "$ENABLED_FILE" "$old"
    remember "$ENABLED_FILE" "$new"
    remember "$SEEN_FILE" "$new"
    say "$(bold "$old") is now part of $(bold "$new"), so that's enabled instead. Its layout keeps its name."
    moved=1
  done
  if [ "$moved" = 1 ]; then prune; fi
  return 0
}

ask() {
  local piece="$1" answer
  [ -t 0 ] || return 1
  printf 'Enable %s? %s [y/N] ' "$(bold "$piece")" "$(dim "$(summary "$piece")")"
  read -r answer
  case "$answer" in y | Y | yes) return 0 ;; *) return 1 ;; esac
}

pull() {
  if ! git -C "$REPO" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    say "$(dim "No upstream branch here, so nothing to pull.")"
  elif [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    warn "This checkout has local changes, so it isn't pulling. Commit or stash them to get your teammates' updates."
  else
    git -C "$REPO" pull --ff-only --quiet || warn "git pull failed. Installing what's here."
  fi
}

update() {
  local piece
  # New pieces since the last run: ask on a terminal, else just mention them.
  for piece in $(pieces); do
    seen "$piece" && continue
    remember "$SEEN_FILE" "$piece"
    if ask "$piece"; then
      remember "$ENABLED_FILE" "$piece"
    elif ! enabled "$piece"; then
      say "New: $(bold "$piece") $(dim "$(summary "$piece")") Enable it with ./install.sh enable $piece"
    fi
  done
  prune
  for piece in $(pieces); do
    if enabled "$piece"; then install_piece "$piece"; fi
  done
  return 0
}

list() {
  local piece mark
  for piece in $(pieces); do
    if enabled "$piece"; then mark="[x]"; else mark="[ ]"; fi
    printf '%s %-20s %s\n' "$mark" "$piece" "$(dim "$(summary "$piece")")"
  done
}

[ -d "$HOME_DIR" ] || die "No Herdr config folder at $HOME_DIR. Open Herdr once first."

do_pull=1
args=()
for a in "$@"; do
  case "$a" in
    --no-pull) do_pull=0 ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) args+=("$a") ;;
  esac
done
set -- ${args[@]+"${args[@]}"}

cmd="${1:-update}"
[ $# -gt 0 ] && shift

case "$cmd" in
  update)
    if [ "$do_pull" = 1 ]; then pull; fi
    migrate
    update
    ;;
  list) list ;;
  enable | disable)
    [ $# -gt 0 ] || die "Name a piece: ./install.sh $cmd <piece>. ./install.sh list shows them."
    resolved=()
    for piece in "$@"; do
      if new="$(merged_into "$piece")"; then
        if [ "$cmd" = disable ]; then
          forget "$ENABLED_FILE" "$piece"
          say "$(bold "$piece") is part of $(bold "$new") now. Removed $piece, and left $new as it was."
          continue
        fi
        say "$(bold "$piece") is part of $(bold "$new") now, so that's what gets enabled."
        piece="$new"
      fi
      resolved+=("$piece")
    done
    migrate
    for piece in ${resolved[@]+"${resolved[@]}"}; do
      is_piece "$piece" || die "No piece named $piece. ./install.sh list shows them."
      remember "$SEEN_FILE" "$piece"
      if [ "$cmd" = enable ]; then
        remember "$ENABLED_FILE" "$piece"
        install_piece "$piece"
      else
        forget "$ENABLED_FILE" "$piece"
        say "$(bold "$piece")"
      fi
    done
    prune
    ;;
  *) die "Unknown command: $cmd. Run ./install.sh --help." ;;
esac
