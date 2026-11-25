#!/usr/bin/python3
"""Reminders for Herdr: one JSON file, read and written only through this script.

Every change holds a lock and replaces the file atomically (write a temp file, fsync, rename), so a
force quit of Herdr, or Herdr and the background job writing at once, can't lose or half-write it.

  reminders.py list                  print every reminder as JSON
  reminders.py add FILE              add the reminder in FILE (JSON), deleting FILE; print it
  reminders.py update ID FILE        merge the fields in FILE into reminder ID, deleting FILE
  reminders.py tick herdr|mac        mark reminders that came due; print the ones this side hasn't
                                     told you about yet ("mac" also posts a macOS notification)
"""
import fcntl, json, os, subprocess, sys, time, uuid

HOME = os.path.expanduser("~/.config/herdr-app/data/squirrel")
STORE = os.path.join(HOME, "reminders.json")
LOCK = os.path.join(HOME, "reminders.lock")


def now_ms():
    return int(time.time() * 1000)


def load():
    try:
        with open(STORE) as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save(items):
    tmp = STORE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(items, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STORE)


def read_input(path):
    with open(path) as f:
        data = json.load(f)
    os.remove(path)
    return data


def notify_mac(r):
    body = r.get("task", "")
    script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run'
    subprocess.run(["/usr/bin/osascript", "-e", script, "Reminder", body], capture_output=True, timeout=15)


def main():
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    with open(LOCK, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        items = load()
        out = None
        if cmd == "list":
            out = items
        elif cmd == "add":
            r = read_input(sys.argv[2])
            r.update(id=uuid.uuid4().hex[:12], created=now_ms(), status="upcoming", herdr_told=False, mac_told=False)
            items.append(r)
            save(items)
            out = r
        elif cmd == "update":
            patch = read_input(sys.argv[3])
            for r in items:
                if r["id"] == sys.argv[2]:
                    r.update(patch)
                    out = r
            save(items)
        elif cmd == "tick":
            side = sys.argv[2] + "_told"
            due = []
            for r in items:
                if r.get("status") == "upcoming" and r.get("at", 0) <= now_ms():
                    r["status"] = "due"
                if r.get("status") == "due" and not r.get(side):
                    r[side] = True
                    due.append(r)
            if due:
                save(items)
            if sys.argv[2] == "mac":
                for r in due:
                    notify_mac(r)
            out = due
        print(json.dumps(out))


main()
