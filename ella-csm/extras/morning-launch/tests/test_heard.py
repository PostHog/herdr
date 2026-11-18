#!/usr/bin/env python3
"""Tests heard.py with canned Claude outputs (HEARD_FAKE) in a temp dir: no Claude, no Granola, no CA.
Run: python3 ~/morning-launch/tests/test_heard.py"""
import json, os, subprocess, sys, tempfile

HEARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "heard", "heard.py")
sys.path.insert(0, os.path.dirname(HEARD))
import heard  # noqa: E402

fails = 0


def check(name, cond):
    global fails
    print(f"  {'ok  ' if cond else 'FAIL'} {name}")
    fails += 0 if cond else 1


SEARCH = """<upcoming_meetings count="1">
<upcoming_meeting id="evt_x" title="Still going" meeting_at="2026-11-13T10:30:00.000+00:00" in_progress="true"></upcoming_meeting>
</upcoming_meetings>
<meetings_data connected_user_email="you@posthog.com">
<meeting id="aaaaaaaa-0000-0000-0000-000000000001" title="Acme &amp; Ella" meeting_at="2026-11-13T10:00:00.000+00:00" updated_at="2026-11-13T10:31:00.000+00:00" captured_by_me="true" url="https://notes.granola.ai/d/aaaaaaaa-0000-0000-0000-000000000001">
    <known_participants>
    Your Name (note creator) from Posthog (you@posthog.com), Pat (pat@example-customer.test)
    </known_participants>
  </meeting>
<meeting id="bbbbbbbb-0000-0000-0000-000000000002" title="Someone else's note" meeting_at="2026-11-13T09:00:00.000+00:00" captured_by_me="false" url="">
  </meeting>
</meetings_data>"""

TRANSCRIPT = ("[0:01] System audio (Pat): Could you send me the docs on cohorts?\n\n"
              "[0:05] Microphone: Yes, I'll send over the cohort docs after this call.\n\n"
              "[0:09] System audio (Pat): And I'll fix our identify call this week.\n\n"
              "[1:12] Microphone: Let me check with the flags team about the timeout.\n\n")

EXTRACT = json.dumps([
    {"quote": "I'll send over the cohort docs after this call", "time": "9:99", "todo": "Send Pat the cohort docs", "account": "acme"},
    {"quote": "let me check with the flags team about the timeout", "time": "1:12", "todo": "Ask flags team about timeout", "account": "not-in-book"},
    {"quote": "I'll fix our identify call this week", "time": "0:09", "todo": "Fix identify", "account": "acme"},  # Pat's line
    {"quote": "I'll write the whole migration guide", "time": "2:00", "todo": "Write guide", "account": None},       # never said
])

print("parse_meetings")
ms = heard.parse_meetings(SEARCH)
check("in-progress meeting left out", all(m["id"] != "evt_x" for m in ms))
check("two ended meetings", len(ms) == 2)
check("title unescaped", ms[0]["title"] == "Acme & Ella")
check("attendee emails read", "pat@example-customer.test" in ms[0]["emails"])
check("captured_by_me read", ms[0]["mine"] and not ms[1]["mine"])

print("assemble_transcript")
p1 = json.dumps({"offset": 0, "transcript": "[0:01] Microphone: one\n\n", "truncated": True})
p2 = json.dumps({"offset": 25, "transcript": "[0:02] Microphone: two\n\n"})
check("pages joined in offset order", heard.assemble_transcript([p2, p1]) == ("[0:01] Microphone: one\n\n[0:02] Microphone: two\n\n", "ok"))
check("pending stays pending", heard.assemble_transcript([json.dumps({"transcript": None, "transcript_unavailable": {"reason": "transcript_pending"}})])[1] == "pending")
check("no_transcript is final", heard.assemble_transcript([json.dumps({"transcript": None, "transcript_unavailable": {"reason": "no_transcript"}})])[1] == "none")
check("no tool result at all = try later", heard.assemble_transcript([])[1] == "pending")

print("validate")
kept, dropped = heard.validate(heard.parse_json_array("here you go:\n" + EXTRACT), TRANSCRIPT, {"acme": "org-1"})
check("two kept, two dropped", len(kept) == 2 and dropped == 2)
check("timestamp taken from the line, not the model", kept[0]["time"] == "0:05")
check("someone else's line dropped", all("identify" not in k["quote"] for k in kept))
check("unknown account slug → null", kept[1]["account"] is None)
check("case/punctuation-insensitive match", kept[1]["time"] == "1:12")

print("check, end to end with fakes")
with tempfile.TemporaryDirectory() as d:
    fake = f"{d}/fake"
    os.makedirs(fake)
    json.dump({"results": [SEARCH], "reply": "DONE"}, open(f"{fake}/meetings.json", "w"))
    json.dump({"results": [json.dumps({"offset": 0, "transcript": TRANSCRIPT})], "reply": "DONE"},
              open(f"{fake}/transcript-aaaaaaaa-0000-0000-0000-000000000001.json", "w"))
    open(f"{fake}/extract-aaaaaaaa-0000-0000-0000-000000000001.txt", "w").write(EXTRACT)
    env = {**os.environ, "HEARD_DIR": f"{d}/h", "HEARD_FAKE": fake, "HEARD_NOW": "2026-11-13T11:00:00+00:00",
           "HEARD_NO_CA": "1"}
    run = lambda *a, **kw: subprocess.run([sys.executable, HEARD, *a], env={**env, **kw}, capture_output=True, text=True)

    r = run("check")
    store = json.load(open(f"{d}/h/heard.json"))
    check("check exits 0", r.returncode == 0)
    check("two pending cards", [c["status"] for c in store["items"]] == ["pending", "pending"])
    check("card carries link + quote + time", store["items"][0]["link"].endswith("000000000001") and store["items"][0]["time"] == "0:05")
    check("meeting marked seen", "aaaaaaaa-0000-0000-0000-000000000001" in json.load(open(f"{d}/h/seen.json")))
    mf = json.load(open(f"{d}/h/meetings/aaaaaaaa-0000-0000-0000-000000000001.json"))
    check("per-meeting file has call-space fields", set(mf) >= {"meeting_id", "title", "ended_at", "account", "items"}
          and set(mf["items"][0]) >= {"text", "quote", "link"})

    run("check")
    check("second check adds nothing", len(json.load(open(f"{d}/h/heard.json"))["items"]) == 2)

    a, b = (c["id"] for c in store["items"])
    run("accept", a)
    run("dismiss", b)
    st = {c["id"]: c["status"] for c in json.load(open(f"{d}/h/heard.json"))["items"]}
    check("accept and dismiss recorded", st == {a: "accepted", b: "dismissed"})

    r = run("check", HEARD_ANY_HOUR="", HEARD_NOW="2026-11-14T11:00:00+00:00")  # a Saturday
    check("weekend check does nothing", r.returncode == 0)

    r = run("check", HEARD_NOW="2026-12-01T11:00:00+00:00")
    check("decided cards pruned after 14 days", json.load(open(f"{d}/h/heard.json"))["items"] == [])

print()
print(f"{fails} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
