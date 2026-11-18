#!/bin/zsh
# Tests todo-agent with a fake triage and placeholder sessions (no Claude). Herdr must be running.
HA="$HOME/.local/bin/herdr-app"; TA="$HOME/morning-launch/todo-agent"; P="$HOME/morning-launch/todo-prep"; fails=0
ok(){ echo "  ok   $1"; }; bad(){ echo "  FAIL $1"; ((fails++)); }
check(){ eval "$2" >/dev/null 2>&1 && ok "$1" || bad "$1"; }
field(){ python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$P/$1.json" "$2"; }
space(){ "$HA" ls | python3 -c "import json,sys; s=[s for s in json.load(sys.stdin)['spaces'] if s['name']=='to-do helpers ·test']; print(json.dumps(s[0]) if s else '')"; }
cleanup(){ id=$(space | python3 -c "import json,sys; d=sys.stdin.read(); print(json.loads(d)['id'] if d.strip() else '')"); [[ -n $id ]] && "$HA" do space.close "{\"id\":\"$id\",\"confirmed\":true}" >/dev/null; rm -f $P/zz-test-*.json(N) $P/zz-test-*.md(N); }
export TODO_SPACE="to-do helpers ·test" TODO_FAKE=1
cleanup

echo "triage says no"
TODO_TRIAGE=NO "$TA" zz-test-a "call mum"
check "record says skip" '[[ $(field zz-test-a status) == skip ]]'
check "no space made" '[[ -z "$(space)" ]]'

echo "triage says yes"
TODO_TRIAGE=YES "$TA" zz-test-b "check acme flag usage"
check "record says running" '[[ $(field zz-test-b status) == running ]]'
check "record has a terminal" '[[ -n $(field zz-test-b terminal) ]]'
check "helpers space exists with one tab" '[[ $(space | python3 -c "import json,sys; print(len(json.load(sys.stdin)[\"tabs\"]))") == 1 ]]'

echo "second item shares the space and tab"
TODO_TRIAGE=YES "$TA" zz-test-c "draft vandelay email"
check "still one tab" '[[ $(space | python3 -c "import json,sys; print(len(json.load(sys.stdin)[\"tabs\"]))") == 1 ]]'
check "two panes in it" '[[ $(space | python3 -c "import json,sys; print(len(json.load(sys.stdin)[\"tabs\"][0][\"terminals\"]))") == 2 ]]'
check "item text kept" '[[ $(field zz-test-c text) == "draft vandelay email" ]]'

echo "unclear triage leans yes"
TODO_TRIAGE="I'd love to help with that" "$TA" zz-test-d "prep for globex qbr"
check "unclear → running" '[[ $(field zz-test-d status) == running ]]'

echo "a fifth helper opens a second tab"
TODO_TRIAGE=YES "$TA" zz-test-e "check stark replay"
check "four panes in the first tab" '[[ $(space | python3 -c "import json,sys; print(len(json.load(sys.stdin)[\"tabs\"][0][\"terminals\"]))") == 4 ]]'
TODO_TRIAGE=YES "$TA" zz-test-f "draft acme follow-up"
check "now two tabs" '[[ $(space | python3 -c "import json,sys; print(len(json.load(sys.stdin)[\"tabs\"]))") == 2 ]]'
check "fifth helper in the second tab" '[[ $(field zz-test-f tab) == $(space | python3 -c "import json,sys; print(json.load(sys.stdin)[\"tabs\"][1][\"id\"])") ]]'

cleanup; echo; (( fails )) && { echo "$fails failed"; exit 1; } || echo "all passed"
