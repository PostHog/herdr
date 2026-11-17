"""Who is on an incident.io on-call schedule from now on.

    incident-oncall.py <schedule id> [days ahead, default 28]

Prints {"ok": true, "entries": [{"start", "end", "name", "email", "slack_user_id"}, ...]} sorted by
start, the schedule's final entries (rotation plus overrides and swaps) overlapping the window
from now; or {"ok": false, "error": ..., "code": ...}, code "no_token" / "auth" / "network" /
"http". Always exits 0 so the caller reads the reason.

The API key (incident.io, read access to on-call schedules) is in the login keychain, service
"herdr-incident", read here and sent only to api.incident.io. Same call as PostHog's
support-hero-notification action (PostHog/shared-actions). Run with /usr/bin/python3 -I.
"""

import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

URL = "https://api.incident.io/v2/schedule_entries"
KEYCHAIN_SERVICE = "herdr-incident"
TIMEOUT_S = 15


class Failure(Exception):
    def __init__(self, message, code="error"):
        super().__init__(message)
        self.code = code


def token():
    r = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise Failure("No incident.io API key in the keychain", "no_token")
    return r.stdout.strip()


def stamp(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def entries(schedule_id, days):
    now = datetime.now(timezone.utc)
    query = urllib.parse.urlencode({
        "schedule_id": schedule_id,
        "entry_window_start": stamp(now),
        "entry_window_end": stamp(now + timedelta(days=days)),
    })
    req = urllib.request.Request(f"{URL}?{query}", headers={"Authorization": f"Bearer {token()}", "User-Agent": "herdr-support-hero/1"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            body = json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise Failure(f"incident.io said {e.code}: {detail}", "auth" if e.code in (401, 403) else "http") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise Failure(f"Can't reach incident.io: {getattr(e, 'reason', e)}", "network") from None
    # "final" is the schedule as it will run: rotations with overrides applied.
    out = []
    for e in body.get("schedule_entries", {}).get("final", []):
        user = e.get("user") or {}
        out.append({
            "start": e.get("start_at"),
            "end": e.get("end_at"),
            "name": user.get("name", ""),
            "email": user.get("email", ""),
            "slack_user_id": user.get("slack_user_id"),
        })
    return sorted(out, key=lambda x: x["start"] or "")


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 28
    try:
        out = {"ok": True, "entries": entries(sys.argv[1], days)}
    except Failure as e:
        out = {"ok": False, "error": str(e), "code": e.code}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
