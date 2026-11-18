#!/usr/bin/env python3
"""heard — commitments Ella made in Granola meetings, offered as to-do candidates.

  heard.py check          launchd entry (every 15 min): find meetings that just ended, read each
                          transcript (never the summary), keep only things Ella said she'd do on
                          her own Microphone lines, and add them to heard.json as "pending".
  heard.py accept <id>    mark one accepted (the to-do panel adds it to todo.md itself, which starts
                          todo-agent) and log it on the account's Customer Analytics note.
  heard.py dismiss <id>   mark one dismissed.
  heard.py log-ca <id>    write the CA note for an accepted item (run in the background by accept).

Granola is reached through headless `claude -p` with a granola-only MCP config; raw tool results
are read from the stream-json output, so transcripts and quotes come from Granola verbatim, not
retyped by a model. Every quote is checked against a real Microphone line before it's offered.

Files (all in ~/morning-launch/heard): heard.json (the cards), seen.json (meetings already done),
meetings/<meeting_id>.json (per-meeting summary, read by call-space), log/heard.log.
Test hooks: HEARD_DIR, HEARD_FAKE=<dir of canned claude outputs>, HEARD_NOW, HEARD_ANY_HOUR.
"""
import fcntl, html, json, os, re, subprocess, sys, time
from datetime import datetime, timedelta, timezone

DIR = os.environ.get("HEARD_DIR", os.path.expanduser("~/morning-launch/heard"))
STORE = f"{DIR}/heard.json"
SEEN = f"{DIR}/seen.json"
MEETINGS = f"{DIR}/meetings"
LOG = f"{DIR}/log/heard.log"
MCP = os.path.expanduser("~/morning-launch/heard/granola-mcp.json")
CALL_SPACE = os.path.expanduser("~/.local/bin/call-space")
HP = os.path.expanduser("~/.local/bin/hp")
WORK_HOURS = (8, 20)          # local time, Mon–Fri; outside this the check does nothing
LOOKBACK_H = 6                # only meetings that started in the last 6 hours are considered
GIVE_UP_H = 24                # stop retrying a meeting whose transcript never arrives
KEEP_DAYS = 14                # accepted/dismissed cards are pruned after this
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")

EXTRACT = """You read meeting transcripts for Your Name, a Customer Success Manager at PostHog, and pick out \
the things SHE committed to do after the meeting.

The transcript labels Ella's own voice "Microphone". Everyone else is "System audio (Name)". Only Ella's \
Microphone lines can be commitments. Use the other lines only as context (e.g. a customer asks "could you \
send me the docs?" and Ella answers "yes, I'll send those over" — the commitment is hers, the quote is her line).

Count: concrete follow-ups she takes on — "I'll send over…", "let me check with the flags team", "I'll look into \
why…", "I'll set up a call with…", "I'll share the dashboard". Don't count: things other people will do, things \
she did during the call, vague pleasantries ("let's catch up sometime"), hypotheticals, or her describing \
what she usually does. When in doubt, leave it out. Merge repeats of the same promise into one item.

Return ONLY a JSON array (empty [] if none), each item:
{"quote": "<her exact words, copied verbatim from ONE Microphone line, 4-25 words, no ellipsis>",
 "time": "<the [m:ss] of that line, without brackets>",
 "todo": "<short imperative to-do in her voice, specific enough to act on, e.g. 'Send Pat the Replay Vision docs'>",
 "account": "<slug from the account list that this commitment is about, or null>"}

Account slugs (her book): %s
Pick an account only when the commitment is clearly about that customer (they're on the call, or they're named). \
In an internal meeting about several accounts, pick per item. Otherwise null."""


# ---------- small helpers ----------

def now():
    return datetime.fromisoformat(os.environ["HEARD_NOW"]) if "HEARD_NOW" in os.environ else datetime.now(timezone.utc).astimezone()


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(f"{now():%Y-%m-%d %H:%M:%S} {msg}\n")


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


class Lock:
    """"store": one writer at a time for heard.json, held only for a read-modify-write.
    "run": one check at a time (a check can take minutes of Claude calls)."""
    def __init__(self, name="store", blocking=True):
        self.name, self.blocking = name, blocking

    def __enter__(self):
        os.makedirs(DIR, exist_ok=True)
        self.f = open(f"{DIR}/.{self.name}.lock", "w")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | (0 if self.blocking else fcntl.LOCK_NB))
            return True
        except BlockingIOError:
            return False

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


# ---------- talking to Granola through claude -p ----------

def claude_stream(prompt, tools, model="haiku", fake=None):
    """Run claude -p and return the raw tool-result texts (in order) plus the final reply."""
    if os.environ.get("HEARD_FAKE"):
        path = f"{os.environ['HEARD_FAKE']}/{fake}.json"
        data = load(path, {"results": [], "reply": ""})
        return data["results"], data["reply"]
    argv = [CLAUDE, "-p", prompt, "--model", model, "--no-session-persistence", "--output-format", "stream-json",
            "--verbose", "--strict-mcp-config", "--mcp-config", MCP, "--allowedTools", *tools]
    r = subprocess.run(argv, capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL, cwd=DIR)
    results, reply = [], ""
    for line in r.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "user":
            for c in ev.get("message", {}).get("content", []):
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    body = c.get("content")
                    if isinstance(body, list):
                        body = "".join(x.get("text", "") for x in body if isinstance(x, dict))
                    results.append(body or "")
        elif ev.get("type") == "result":
            reply = ev.get("result", "") or ""
    if r.returncode != 0 and not results:
        raise RuntimeError(f"claude exited {r.returncode}: {r.stderr.strip()[:300]}")
    return results, reply


def claude_text(prompt, stdin_text, model="sonnet", fake=None):
    """A plain no-tools claude -p call; the transcript goes in on stdin."""
    if os.environ.get("HEARD_FAKE"):
        return open(f"{os.environ['HEARD_FAKE']}/{fake}.txt").read()
    r = subprocess.run([CLAUDE, "-p", "--model", model, "--no-session-persistence", "--strict-mcp-config",
                        "--system-prompt", prompt, "--tools", "", "--output-format", "text"],
                       input=stdin_text, capture_output=True, text=True, timeout=600, cwd=DIR)
    if r.returncode != 0:
        raise RuntimeError(f"claude exited {r.returncode}: {r.stderr.strip()[:300]}")
    return r.stdout


ATTR = re.compile(r'(\w+)="([^"]*)"')


def parse_meetings(text):
    """Ended meetings from a search_meetings result. Upcoming / in-progress ones live in a separate
    <upcoming_meetings> block and are left out on purpose: they haven't ended."""
    text = re.sub(r"<upcoming_meetings.*?</upcoming_meetings>", "", text, flags=re.S)
    out = []
    for m in re.finditer(r"<meeting (.*?)>(.*?)</meeting>", text, flags=re.S):
        a = {k: html.unescape(v) for k, v in ATTR.findall(m.group(1))}
        if "id" not in a:
            continue
        people = re.search(r"<known_participants>(.*?)</known_participants>", m.group(2), flags=re.S)
        emails = re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", people.group(1) if people else "")
        out.append({"id": a["id"], "title": a.get("title", ""), "meeting_at": a.get("meeting_at", ""),
                    "updated_at": a.get("updated_at", ""), "url": a.get("url", ""),
                    "mine": a.get("captured_by_me") == "true", "emails": emails})
    return out


def fetch_meetings(since):
    prompt = (f"Call mcp__granola__search_meetings with from_date \"{since:%Y-%m-%d}\", attended_only true, limit 50. "
              "If the result has a next_cursor, call it again with that cursor until there is none. Then reply DONE.")
    results, _ = claude_stream(prompt, ["mcp__granola__search_meetings"], fake="meetings")
    seen, out = set(), []
    for r in results:
        for m in parse_meetings(r):
            if m["id"] not in seen:
                seen.add(m["id"])
                out.append(m)
    return out


def assemble_transcript(results):
    """Join paged get_meeting_transcript results. Returns (text, status) where status is
    'ok', 'pending' (try again later) or 'none' (never coming)."""
    pages, status = {}, None
    for r in results:
        try:
            d = json.loads(r)
        except ValueError:
            continue
        if d.get("transcript"):
            pages[d.get("offset", 0)] = d["transcript"]
        elif d.get("transcript_unavailable"):
            reason = str(d["transcript_unavailable"].get("reason") if isinstance(d["transcript_unavailable"], dict)
                         else d["transcript_unavailable"])
            status = "pending" if reason in ("transcript_pending", "not_happened_yet") else "none"
    if pages:
        return "".join(pages[k] for k in sorted(pages)), "ok"
    return "", status or "pending"


def fetch_transcript(meeting_id):
    prompt = (f"Call mcp__granola__get_meeting_transcript with meeting_id \"{meeting_id}\", include_timestamps true, "
              "max_chars 100000. If the result says truncated true, call it again with offset set to next_offset "
              "(same include_timestamps and max_chars) until truncated is false. Then reply DONE. Don't summarise.")
    results, _ = claude_stream(prompt, ["mcp__granola__get_meeting_transcript"], fake=f"transcript-{meeting_id}")
    return assemble_transcript(results)


# ---------- the transcript itself ----------

LINE = re.compile(r"^\[(\d+:\d{2}(?::\d{2})?)\]\s*(Microphone|System audio(?: \([^)]*\))?|[^:]{1,60}):\s*(.*)$")


def mic_lines(transcript):
    out = []
    for raw in transcript.split("\n"):
        m = LINE.match(raw.strip())
        if m and m.group(2) == "Microphone":
            out.append((m.group(1), m.group(3)))
    return out


def norm(s):
    s = s.lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("—", "-")
    return re.sub(r"[^a-z0-9']+", " ", s).strip()


def parse_json_array(text):
    m = re.search(r"\[.*\]", text, flags=re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return []
    return [x for x in data if isinstance(x, dict)]


def validate(items, transcript, book):
    """Keep only items whose quote really is on one of Ella's Microphone lines. The timestamp comes
    from that line, not from the model. Unknown account slugs are dropped to null."""
    lines = [(t, text, norm(text)) for t, text in mic_lines(transcript)]
    kept, dropped = [], 0
    for it in items:
        q, todo = str(it.get("quote") or "").strip().strip('"'), str(it.get("todo") or "").strip()
        nq = norm(q)
        hit = next((ln for ln in lines if nq and len(nq.split()) >= 3 and nq in ln[2]), None)
        if not hit or not todo:
            dropped += 1
            continue
        acct = it.get("account")
        kept.append({"quote": q, "time": hit[0], "todo": todo, "account": acct if acct in book else None})
    return kept, dropped


# ---------- accounts ----------

def book_slugs():
    try:
        r = subprocess.run([HP, "book", "show"], capture_output=True, text=True, timeout=30)
        rows = json.loads(r.stdout).get("rows", [])
        return {row["account"]: row["org_id"] for row in rows if row.get("active", True)}
    except (OSError, ValueError, subprocess.TimeoutExpired, KeyError):
        return {}


def account_from_emails(emails, book):
    """The meeting's account from external attendee domains, via hp id (domain → org)."""
    for dom in sorted({e.split("@")[1].lower() for e in emails}):
        if dom == "posthog.com" or dom.endswith(".posthog.com"):
            continue
        try:
            r = subprocess.run([HP, "id", "--json", dom], capture_output=True, text=True, timeout=30)
            d = json.loads(r.stdout)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
        if d.get("status") == "ok" and d.get("account") in book:
            return d["account"]
    return None


# ---------- one meeting ----------

def item_id(meeting_id, time_, quote):
    h = 5381
    for ch in f"{meeting_id}|{time_}|{quote}":
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return f"{meeting_id[:8]}-{h:x}"


def process(meeting, book):
    """Returns ('ok', [cards]) | ('pending', None) | ('none', None)."""
    transcript, status = fetch_transcript(meeting["id"])
    if status != "ok":
        return status, None
    if not mic_lines(transcript):
        log(f"{meeting['id']} has no Microphone lines; nothing to pick from")
        return "ok", []
    meeting_acct = account_from_emails(meeting["emails"], book)
    header = (f"Meeting: {meeting['title']}\nStarted: {meeting['meeting_at']}\n"
              f"Attendees: {', '.join(meeting['emails']) or 'unknown'}\n"
              f"Account from attendee domains: {meeting_acct or 'none found'}\n\nTranscript:\n")
    raw = claude_text(EXTRACT % ", ".join(sorted(book)), header + transcript, fake=f"extract-{meeting['id']}")
    items, dropped = validate(parse_json_array(raw), transcript, book)
    if dropped:
        log(f"{meeting['id']} dropped {dropped} item(s) whose quote wasn't on a Microphone line")
    cards = []
    for it in items:
        acct = it["account"] or meeting_acct
        cards.append({"id": item_id(meeting["id"], it["time"], it["quote"]), "status": "pending",
                      "meeting_id": meeting["id"], "meeting_title": meeting["title"], "meeting_at": meeting["meeting_at"],
                      "link": meeting["url"] or f"https://notes.granola.ai/d/{meeting['id']}",
                      "account": acct, "org_id": book.get(acct) if acct else None,
                      "todo": it["todo"], "quote": it["quote"], "time": it["time"],
                      "found_at": now().isoformat(timespec="seconds")})
    return "ok", cards


def write_meeting_file(meeting, cards, book):
    """Per-meeting summary for other tools (call-space), then hand it over if call-space exists."""
    accts = [c["account"] for c in cards if c["account"]]
    account = max(set(accts), key=accts.count) if accts else account_from_emails(meeting["emails"], book)
    path = f"{MEETINGS}/{meeting['id']}.json"
    save(path, {"meeting_id": meeting["id"], "title": meeting["title"],
                "ended_at": meeting.get("updated_at") or meeting["meeting_at"], "account": account,
                "items": [{"id": c["id"], "text": c["todo"], "quote": c["quote"], "time": c["time"],
                           "account": c["account"], "link": c["link"]} for c in cards]})
    if account and os.access(CALL_SPACE, os.X_OK) and not os.environ.get("HEARD_FAKE"):
        try:
            subprocess.Popen([CALL_SPACE, "after", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError as e:
            log(f"call-space failed to start: {e}")


# ---------- commands ----------

def in_hours(t):
    return os.environ.get("HEARD_ANY_HOUR") or (t.weekday() < 5 and WORK_HOURS[0] <= t.hour < WORK_HOURS[1])


def parse_time(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def check():
    t = now()
    if not in_hours(t):
        return 0
    with Lock("run", blocking=False) as got:
        if not got:
            return 0  # a previous check is still running
        seen = load(SEEN, {})
        try:
            meetings = fetch_meetings(t - timedelta(hours=LOOKBACK_H))
        except Exception as e:
            log(f"search failed: {e}")
            return 1
        cutoff = t - timedelta(hours=LOOKBACK_H)
        todo = [m for m in meetings if m["mine"] and m["id"] not in seen
                and (parse_time(m["meeting_at"]) or t) >= cutoff]
        book = book_slugs() if todo else {}
        found = []
        for m in todo:
            try:
                status, cards = process(m, book)
            except Exception as e:
                log(f"{m['id']} failed: {e}")
                continue
            if status == "pending":
                started = parse_time(m["meeting_at"])
                if started and t - started > timedelta(hours=GIVE_UP_H):
                    seen[m["id"]] = {"at": t.isoformat(timespec="seconds"), "result": "no transcript"}
                continue
            if status == "none":
                seen[m["id"]] = {"at": t.isoformat(timespec="seconds"), "result": "no transcript"}
                continue
            found.extend(cards)
            seen[m["id"]] = {"at": t.isoformat(timespec="seconds"), "result": f"{len(cards)} found",
                             "title": m["title"]}
            log(f"{m['id']} '{m['title']}': {len(cards)} commitment(s)")
            write_meeting_file(m, cards, book)
        with Lock():
            store = load(STORE, {"items": []})
            have = {c["id"] for c in store["items"]}
            store["items"].extend(c for c in found if c["id"] not in have)
            store["items"] = prune(store["items"], t)
            save(STORE, store)
        save(SEEN, seen)
    return 0


def prune(items, t):
    keep = []
    for c in items:
        done = c.get("decided_at") and c["status"] != "pending"
        if done and t - parse_time(c["decided_at"]) > timedelta(days=KEEP_DAYS):
            continue
        keep.append(c)
    return keep


def decide(cid, status):
    with Lock():
        store = load(STORE, {"items": []})
        card = next((c for c in store["items"] if c["id"] == cid), None)
        if not card:
            print(f"no card {cid}", file=sys.stderr)
            return None
        card["status"] = status
        card["decided_at"] = now().isoformat(timespec="seconds")
        save(STORE, store)
        return card


def accept(cid):
    card = decide(cid, "accepted")
    if not card:
        return 1
    if card.get("org_id") and not os.environ.get("HEARD_NO_CA"):
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "log-ca", cid], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return 0


def ca_project():
    """The Customer Analytics project id from ~/.config/ella-csm/internal.json (not in the public repo)."""
    p = os.path.join(os.environ.get("ELLA_CSM_INTERNAL", os.path.expanduser("~/.config/ella-csm")), "internal.json")
    try:
        return int(json.load(open(p))["ca_project_id"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


CA_PROMPT = """Log one commitment to a PostHog Customer Analytics account note. Use the PostHog exec tool only.
1. `call switch-project {"project_id": %(project)s}` (run `info switch-project` first if that errors).
2. `call accounts-list {"search": "%(org_id)s", "limit": 5}` and take the account whose external_id is exactly %(org_id)s. If none matches exactly, stop and reply {"error": "no account"}.
3. `call accounts-notebooks-create` with account_id = that account's id, title = %(title)s, tags = ["ca:call", "ca-source:granola"], and text_content = the markdown below, unchanged.
Only create. Never update, delete or destroy anything, and don't touch any other note.
Reply with one line of JSON only: {"short_id": "<the new note's short_id>", "account_id": "<id>"} or {"error": "<why>"}.

Markdown:
%(body)s"""


def log_ca(cid):
    store = load(STORE, {"items": []})
    card = next((c for c in store["items"] if c["id"] == cid), None)
    if not card or not card.get("org_id"):
        return 1
    day = parse_time(card["meeting_at"])
    when = f"{day:%-d %b %Y}" if day else card["meeting_at"]
    body = (f"Ella said on the call **{card['meeting_title']}** ({when}, at {card['time']}) that she would: "
            f"**{card['todo']}**\n\n"
            f"Her words: \"{card['quote']}\"\n\n"
            f"[Granola note]({card['link']}). Logged when she accepted it from her to-do list; still open.")
    project = ca_project()
    if project is None:
        log(f"CA note for {cid}: skipped, no ~/.config/ella-csm/internal.json (README)")
        return 1
    prompt = CA_PROMPT % {"project": project, "org_id": card["org_id"], "title": json.dumps(f"Call commitment ({when}): {card['todo']}"[:250]),
                          "body": body}
    result = {"status": "failed"}
    try:
        r = subprocess.run([CLAUDE, "-p", prompt, "--model", "sonnet", "--no-session-persistence",
                            "--allowedTools", "mcp__claude_ai_PostHog__exec"],
                           capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL, cwd=DIR)
        m = re.search(r"\{.*\}", r.stdout, flags=re.S)
        d = json.loads(m.group(0)) if m else {}
        if d.get("short_id"):
            result = {"status": "logged", "note": d["short_id"], "account_id": d.get("account_id")}
        else:
            result = {"status": "failed", "error": d.get("error") or r.stdout.strip()[-200:]}
    except Exception as e:
        result = {"status": "failed", "error": str(e)[:200]}
    log(f"CA note for {cid}: {result}")
    with Lock():
        store = load(STORE, {"items": []})
        for c in store["items"]:
            if c["id"] == cid:
                c["ca"] = result
        save(STORE, store)
    return 0 if result["status"] == "logged" else 1


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "check":
        return check()
    if cmd == "accept" and len(argv) == 3:
        return accept(argv[2])
    if cmd == "dismiss" and len(argv) == 3:
        return 0 if decide(argv[2], "dismissed") else 1
    if cmd == "log-ca" and len(argv) == 3:
        return log_ca(argv[2])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
