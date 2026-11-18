# python3 ~/book/tests/test_alert_todos.py — book-spaces alert-todos, against throwaway folders.
import importlib.machinery, importlib.util, json, os, sys, tempfile, time
from pathlib import Path

tmp = Path(tempfile.mkdtemp(prefix="alert-todos-"))
assert str(tmp).strip() and tmp.exists()
os.environ["BOOK_SPACES_DIR"] = str(tmp / "spaces")
os.environ["TODO_HOME"] = str(tmp / "ml")
(tmp / "spaces").mkdir(); (tmp / "ml").mkdir()
loader = importlib.machinery.SourceFileLoader("bs", str(Path(__file__).resolve().parent.parent / "bin/book-spaces"))
spec = importlib.util.spec_from_loader("bs", loader); bs = importlib.util.module_from_spec(spec); loader.exec_module(bs)
n = 0
def t(name, fn):
    global n; fn(); n += 1; print("  ok  ", name)

ACC = [{"slug": "umbrella", "name": "Umbrella"}, {"slug": "initech", "name": "Initech"}, {"slug": "acme", "name": "Acme"}]
bs.roster = lambda: ACC
now = time.time()
def msg(author, ts, body):
    return f"=== Message from {author} at x === \nMessage TS: {ts:.6f}\n{body}\n\n"
shared = ("Channel: #sales-alerts (C0000000SALES)\n\n"
          + msg("Ari <bot@x> (B1)", now - 600, "<@U00000000ME|Your Name> Umbrella\n- $1,000.00 · 3 days overdue")
          + msg("Ari <bot@x> (B1)", now - 500, "<@U00000OTHER|someone-else> Hooli invoice overdue")
          + msg("Your Name (U00000000ME)", now - 400, "thanks <@U00000000ME|Your Name> note to self"))

t("shared posts: only ones tagging Ella, not hers, with the account found", lambda: (
    (p := bs.parse_shared("C0000000SALES", shared, ACC)),
    len(p) == 1 or sys.exit(f"got {p}"),
    p[0]["slug"] == "umbrella" or sys.exit(p[0]),
    p[0]["link"].startswith("https://posthog.slack.com/archives/C0000000SALES/p") or sys.exit(p[0])))
t("account match is whole-word", lambda: (bs.find_account("Initechesque thing", ACC) is None or sys.exit("matched"),
                                           bs.find_account("New ticket from Acme.", ACC) == "acme" or sys.exit("no acme")))
md = "# to-do\n\n- [ ] one\n- [ ] two <!-- slack:https://x -->\n- [x] old <!-- done:2026-11-18 -->\n"
t("add_todo goes after the last open item", lambda: bs.add_todo(md, "- [ ] new").splitlines()[4] == "- [ ] new" or sys.exit(bs.add_todo(md, "- [ ] new")))
t("add_todo on an empty file", lambda: bs.add_todo("", "- [ ] new") == "# to-do\n\n- [ ] new\n" or sys.exit(repr(bs.add_todo("", "- [ ] new"))))
t("open_todos strips comments", lambda: bs.open_todos(md) == ["one", "two"] or sys.exit(bs.open_todos(md)))

# End to end: one own-channel alert + the shared post; the fake model adds both, then a rerun adds nothing.
own_link = "https://posthog.slack.com/archives/C00000NEWS0/p1"
bs.save("alerts.json", {"alerts": [{"slug": "initech", "ts": f"{now - 300:.6f}", "at": bs.now().isoformat(), "scout": "s", "update": False,
                                    "title": "Initech: 100 query timeouts", "detail": "d", "channel": "#account-news-you", "link": own_link}]})
(tmp / "ml/todo.md").write_text(md)
os.environ["ALERT_SHARED_FAKE"] = json.dumps([{"channel": "C0000000SALES", "text": shared}])
shared_link = bs.parse_shared("C0000000SALES", shared, ACC)[0]["link"]
os.environ["ALERT_TODOS_FAKE"] = json.dumps([
    {"id": own_link, "action": "add", "todo": "Initech: 100 query timeouts last week (#account-news-you, 18 Nov)"},
    {"id": shared_link, "action": "add", "todo": "Umbrella: $1,000.00 invoice 3 days overdue (#sales-alerts, 18 Nov) <!-- x -->"},
    {"id": "made-up", "action": "add", "todo": "should be ignored"}])
added = bs.alert_todos()
out = (tmp / "ml/todo.md").read_text()
t("adds both, with their slack comment, before done items", lambda: (
    len(added) == 2 or sys.exit(added),
    f"- [ ] Initech: 100 query timeouts last week (#account-news-you, 18 Nov) <!-- slack:{own_link} -->" in out or sys.exit(out),
    "should be ignored" not in out or sys.exit(out),
    out.splitlines()[-1].startswith("- [x] old") or sys.exit(out)))
t("model text can't inject a comment", lambda: "<!-- x -->" not in out or sys.exit(out))
t("writes an alert link record under the panel's slug", lambda: (
    (rec := json.loads((tmp / "ml/todo-links" / f"{bs.todo_slug('Initech: 100 query timeouts last week (#account-news-you, 18 Nov)')}.json").read_text())),
    rec["how"] == "alert" and rec["slack"] == own_link or sys.exit(rec)))
t("a rerun adds nothing (posts are remembered)", lambda: (bs.alert_todos() == [] or sys.exit("re-added"),
                                                          (tmp / "ml/todo.md").read_text() == out or sys.exit("changed")))
os.environ["ALERT_TODOS_FAKE"] = json.dumps([{"id": own_link, "action": "skip", "reason": "dup"}])
t("posts older than the first-run window are ignored", lambda: (
    bs.save("alert-todos.json", {"since": bs.now().isoformat(), "seen": {}}), bs.alert_todos() == [] or sys.exit("old post added")))
print(f"{n} passed")
