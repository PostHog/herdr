#!/bin/zsh
# zsh ~/book/tests/test_book_spaces.sh — before/after in a throwaway Herdr space
# ("zz-book-spaces-test", placeholder shells, temp data dir). Needs Herdr running.
set -e
export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin
T=$(mktemp -d); export BOOK_SPACES_DIR=$T/spaces BOOK_CALLS_DIR=$T/calls BOOK_SPACES_FAKE=1
mkdir -p $BOOK_SPACES_DIR; cp ~/book/spaces/cadence.json $BOOK_SPACES_DIR/ 2>/dev/null || true
fail() { echo "FAIL: $*"; cleanup; exit 1; }
cleanup() {
  for id in $(herdr-app ls | python3 -c "import json,sys;[print(s['id']) for s in json.load(sys.stdin)['spaces'] if s['name']=='zz-book-spaces-test']"); do
    herdr-app do space.close "{\"id\":\"$id\",\"confirmed\":true}" >/dev/null; done
  rm -rf $T
}
# the test account: a fake roster entry named zz-book-spaces-test via the title matcher
python3 - <<PY
import importlib.machinery, importlib.util, json, os
from datetime import datetime, timedelta, timezone
l=importlib.machinery.SourceFileLoader('bs',os.path.expanduser('~/.local/bin/book-spaces'))
s=importlib.util.spec_from_loader('bs',l); bs=importlib.util.module_from_spec(s); l.exec_module(bs)
acc={"slug":"zz-book-spaces-test","name":"Zz Test","org":"00000000-0000-0000-0000-000000000000","hp":"zz-test"}
bs.roster=lambda: [acc]
start=datetime.now(timezone.utc)+timedelta(minutes=8)
m={"id":"evt_test1","title":"Zz Test sync","start":start.isoformat(),"end":(start+timedelta(minutes=30)).isoformat(),"emails":["you@posthog.com"]}
assert [x["id"] for x in bs.due([m], datetime.now(timezone.utc))]==["evt_test1"], "due window"
assert bs.due([m], datetime.now(timezone.utc)-timedelta(minutes=5))==[], "not due 15 min out"
assert bs.resolve(m["emails"], m["title"], [acc])==acc, "title match"
c=bs.before("evt_test1", m)
assert bs.before("evt_test1", m)["terminal"]==c["terminal"], "second before reuses"
calls=json.load(open(os.environ["BOOK_SPACES_DIR"]+"/calls.json")); assert "evt_test1" in calls
heard={"meeting_id":"g1","title":"Zz Test sync","ended_at":(start+timedelta(minutes=31)).isoformat(),"account":"zz-test",
       "items":[{"text":"send the flags doc","quote":"I'll send over the flags doc","link":"https://notes.granola.ai/d/g1"}]}
p=os.environ["BOOK_SPACES_DIR"]+"/heard.json"; json.dump(heard,open(p,"w"))
where=bs.after(p)
assert where==c["terminal"], ("after went to the prep terminal", where, c)
calls=json.load(open(os.environ["BOOK_SPACES_DIR"]+"/calls.json")); assert calls["evt_test1"].get("after_at")
t=json.load(open(os.environ["BOOK_SPACES_DIR"]+"/touches.json")); assert t["zz-book-spaces-test"]["source"]=="call"
# a call with no prep tab gets its own "after" tab
heard2=dict(heard, meeting_id="g2", ended_at=(start+timedelta(hours=6)).isoformat())
json.dump(heard2,open(p,"w")); w2=bs.after(p); assert w2 and w2!=c["terminal"], "fresh after tab"
print("ok  before/after round trip")
PY
sleep 1
hc read ${$(herdr-app ls | python3 -c "import json,sys;[print(t['terminals'][0]['terminal']) for s in json.load(sys.stdin)['spaces'] if s['name']=='zz-book-spaces-test' for t in s['tabs'][:1]]")} | grep -q "flags doc" && echo "ok  commitment text reached the prep terminal" || fail "text not in prep terminal"
cleanup; echo "all passed"
