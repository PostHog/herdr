#!/bin/zsh
# Tests `acct <name> -s` / acct-space: one Herdr space per account, reused on the next call.
# Uses a placeholder shell instead of Claude (ACCT_SPACE_FAKE=1). Herdr must be running.
HA="$HOME/.local/bin/herdr-app"; fails=0
ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; ((fails++)); }
check(){ eval "$2" >/dev/null 2>&1 && ok "$1" || bad "$1"; }
ids()  { "$HA" ls | python3 -c "import json,sys; [print(s['id']) for s in json.load(sys.stdin)['spaces'] if s['name']==sys.argv[1]]" "$1"; }
shown(){ "$HA" status | python3 -c "import json,sys; print(json.load(sys.stdin)['space'])"; }
cleanup(){ for id in $(ids dunder-mifflin); do "$HA" do space.close "{\"id\":\"$id\",\"confirmed\":true}" >/dev/null; done; }
[[ -n "$(ids dunder-mifflin)" ]] && { echo "a real 'dunder-mifflin' space exists; not touching it"; exit 2; }
before="$(shown)"

echo "first call makes the space"
ACCT_SPACE_FAKE=1 "$HOME/.local/bin/acct" "dunder mifflin" -s
check "one space called dunder-mifflin" '[[ $(ids dunder-mifflin | wc -l) -eq 1 ]]'
check "it is the one on screen" '[[ "$(shown)" == "$(ids dunder-mifflin)" ]]'
check "it starts in ~/book" '"$HA" ls | python3 -c "import json,sys; s=[s for s in json.load(sys.stdin)[\"spaces\"] if s[\"name\"]==\"dunder-mifflin\"][0]; assert s[\"folder\"]==\"$HOME/book\", s[\"folder\"]"'
check "~/book sessions load the shared memory" '[[ -e "$HOME/.claude/projects/-Users-YOU-book/memory/MEMORY.md" ]]'

echo "second call reuses it"
"$HA" do space.select "{\"id\":\"$before\"}" >/dev/null
ACCT_SPACE_FAKE=1 "$HOME/.local/bin/acct" "dunder mifflin" -s
check "still one space" '[[ $(ids dunder-mifflin | wc -l) -eq 1 ]]'
check "switched back to it" '[[ "$(shown)" == "$(ids dunder-mifflin)" ]]'

echo "acct still prints tabs"
check "acct -p unchanged" '"$HOME/.local/bin/acct" "dunder mifflin" -p | grep -q metabase'

cleanup; "$HA" do space.select "{\"id\":\"$before\"}" >/dev/null
echo; (( fails )) && { echo "$fails failed"; exit 1; } || echo "all passed"
