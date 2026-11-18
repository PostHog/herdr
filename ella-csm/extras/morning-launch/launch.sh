#!/bin/zsh
# Morning launcher: one Herdr space per day ("morning · mon 16 nov") with a
# "today" checklist tab, then one tab per task file in tasks/<date>/.
# Usage: launch.sh [YYYY-MM-DD] [--force]
# MORNING_FAKE=1 runs a placeholder instead of Claude (used by tests/).
BASE="$HOME/morning-launch"
DAY="$(date +%F)"; FORCE=0
for a in "$@"; do [[ "$a" == --force ]] && FORCE=1 || DAY="$a"; done
DIR="$BASE/tasks/$DAY"
LOG="$BASE/logs/$DAY.log"
log() { echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

[[ -d "$DIR" ]] || { log "no task folder for $DAY"; exit 0; }
[[ -e "$DIR/.launched" && $FORCE == 0 ]] && { log "already launched"; exit 0; }

open -ga Herdr
for i in {1..30}; do "$HOME/.local/bin/herdr-app" status >/dev/null 2>&1 && break; sleep 2; done
"$HOME/.local/bin/herdr-app" status >/dev/null 2>&1 || { log "herdr not reachable"; exit 1; }

/usr/bin/python3 - "$DIR" "$DAY" "$BASE" >> "$LOG" 2>&1 <<'PY'
import glob, json, os, subprocess, sys, datetime
d, day, base = sys.argv[1:4]
HA = os.path.expanduser("~/.local/bin/herdr-app")
def do(cmd, args):
    r = subprocess.run([HA, "do", cmd, json.dumps(args)], capture_output=True, text=True)
    out = json.loads(r.stdout or "{}")
    if r.returncode or "error" in out: raise RuntimeError(f"{cmd}: {out.get('error', r.stderr)}")
    return out
def now(): return datetime.datetime.now().strftime("%H:%M:%S")
dt = datetime.date.fromisoformat(day)
space_name = f"morning · {dt.strftime('%a').lower()} {dt.day} {dt.strftime('%b').lower()}"
files = sorted(f for f in glob.glob(f"{d}/*.md") if not f.endswith(".done.md"))
if not files: print(f"{now()} no tasks"); sys.exit(0)
def argv(f):
    if os.environ.get("MORNING_FAKE"): return ["zsh", "-c", f"echo fake session for {os.path.basename(f)}; sleep 600"]
    return ["zsh", f"{base}/run-task.sh", f]
def title(f): return open(f).readline().lstrip("#").strip() or os.path.basename(f)
state = {"day": day, "tasks": {}}
work = f"{base}/work"
first = do("space.new", {"name": space_name, "folder": work, "tab": title(files[0]), "argv": argv(files[0])})
space = state["space"] = first["space"]
state["tasks"][os.path.basename(files[0])] = {"tab": first["tab"], "terminal": first["terminal"]}
print(f"{now()} space: {space_name} ({space})"); print(f"{now()} started: {title(files[0])}")
for f in files[1:]:
    try:
        t = do("tab.new", {"space": space, "name": title(f), "folder": work, "argv": argv(f)})
        state["tasks"][os.path.basename(f)] = {"tab": t["tab"], "terminal": t["terminal"]}
        print(f"{now()} started: {title(f)}")
    except Exception as e:
        print(f"{now()} FAILED: {title(f)}: {e}")
board = do("tab.new", {"space": space, "name": "today", "mod": "ella-morning", "props": {"day": day}})
do("tab.move", {"id": board["tab"], "index": 0})
do("tab.select", {"id": board["tab"]})
state["board"] = board["tab"]
json.dump(state, open(f"{d}/.herdr.json", "w"), indent=1)
print(f"{now()} done, {len(state['tasks'])} task(s)")
PY
rc=$?
touch "$DIR/.launched"
n=$(/usr/bin/python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['tasks']))" "$DIR/.herdr.json" 2>/dev/null || echo 0)
(( rc == 0 )) || log "launcher failed (exit $rc)"
osascript -e "display notification \"$n session(s) started in Herdr\" with title \"Morning launcher\"" 2>/dev/null
