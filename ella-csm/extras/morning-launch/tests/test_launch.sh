#!/bin/zsh
# End-to-end test of the Herdr morning launcher, with fake sessions instead of Claude.
# Usage: tests/test_launch.sh   (Herdr must be running)
BASE="$HOME/morning-launch"; HA="$HOME/.local/bin/herdr-app"
DAY=2099-01-05; DIR="$BASE/tasks/$DAY"; fails=0
ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; ((fails++)); }
check(){ eval "$2" >/dev/null 2>&1 && ok "$1" || bad "$1"; }
spaces_named() { "$HA" ls | python3 -c "import json,sys; print(sum(1 for s in json.load(sys.stdin)['spaces'] if s['name']==sys.argv[1]))" "$1"; }
cleanup() {
  "$HA" ls | python3 -c "import json,sys; [print(s['id']) for s in json.load(sys.stdin)['spaces'] if s['name'].startswith('morning · mon 5 jan')]" |
    while read id; do "$HA" do space.close "{\"id\":\"$id\",\"confirmed\":true}" >/dev/null; done
  rm -rf "$DIR"
}
cleanup; mkdir -p "$DIR"
printf '# Alpha\nsay hi\n' > "$DIR/01-alpha.md"
printf '# Beta\nsay bye\n' > "$DIR/02-beta.md"

echo "run-task prompt"
out="$(CLAUDE_BIN=echo zsh "$BASE/run-task.sh" "$DIR/01-alpha.md")"
check "prompt names the handover file" '[[ "$out" == *"$DIR/01-alpha.done.md"* ]]'
check "prompt includes the preamble" '[[ "$out" == *"How this session started"* ]]'

echo "launch"
MORNING_FAKE=1 zsh "$BASE/launch.sh" $DAY --force
check "state file written" '[[ -s "$DIR/.herdr.json" ]]'
check "state has both tasks with tab and terminal" 'python3 -c "import json,sys; t=json.load(open(sys.argv[1]))[\"tasks\"]; assert all(t[f][\"tab\"] and t[f][\"terminal\"] for f in (\"01-alpha.md\",\"02-beta.md\"))" "$DIR/.herdr.json"'
check "one space for the day" '[[ $(spaces_named "morning · mon 5 jan") == 1 ]]'
check "tabs are today, Alpha, Beta in order" '"$HA" ls | python3 -c "import json,sys; s=[s for s in json.load(sys.stdin)[\"spaces\"] if s[\"name\"]==\"morning · mon 5 jan\"][0]; assert [t[\"name\"] for t in s[\"tabs\"]]==[\"today\",\"Alpha\",\"Beta\"], s[\"tabs\"]"'
check "launched marker" '[[ -e "$DIR/.launched" ]]'

echo "no double launch"
MORNING_FAKE=1 zsh "$BASE/launch.sh" $DAY
check "still one space" '[[ $(spaces_named "morning · mon 5 jan") == 1 ]]'

echo "board"
check "morning mod loads" '"$HA" check "$HOME/.config/herdr-app/mods/ella-morning"'

[[ "$1" == --keep ]] || cleanup
echo; (( fails )) && { echo "$fails failed"; exit 1; } || echo "all passed"
