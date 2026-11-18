"""Talks to Grafana for the grafana mod, as the Grafana MCP wrapper does.

  grafana.py <region> get <path>        prints Grafana's JSON for a GET of <path> ("/api/search?...")
  grafana.py <region> query <json>      runs PromQL range queries at once, prints {id: result}
      <json> = {"start": s, "end": s, "step": s, "queries": [{"id": str, "expr": str, "ds": uid}]}
      result = {"series": [{"metric": {...}, "values": [[t, "v"], ...]}]} or {"error": str}

Each region's API address (reached over Tailscale) is in the private settings file, kept out of the
repo: data/gustavo/private.json in Herdr's folder, "grafana": {"api": {"us": url, "eu": url}}. The
service account token is the one the Grafana MCP setup stores in the login keychain; it goes in a
header, never in a process list. Errors print as {"error": ...} with exit code 0, so the mod reads
one shape.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REGIONS = ("us", "eu")
PRIVATE = os.path.join(os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app"), "data/gustavo/private.json")
TIMEOUT_S = 20


def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(0)


def token(region):
    service = f"grafana-service-account-token-{region}"
    r = subprocess.run(
        ["security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", service, "-w"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        fail(f"No Grafana token for {region.upper()} in the keychain. Add it with: grafana-token {region} <token>")
    return r.stdout.strip()


def get(base, secret, path):
    req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {secret}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            return json.loads(res.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        try:
            body = json.loads(body).get("error") or json.loads(body).get("message") or body
        except ValueError:
            pass
        raise RuntimeError(f"HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Can't reach Grafana ({e.reason}). Is Tailscale connected?")


def query(base, secret, spec):
    def one(q):
        params = urllib.parse.urlencode(
            {"query": q["expr"], "start": spec["start"], "end": spec["end"], "step": spec["step"]}
        )
        path = f"/api/datasources/proxy/uid/{urllib.parse.quote(q.get('ds') or 'victoriametrics')}/api/v1/query_range?{params}"
        try:
            body = get(base, secret, path)
            if body.get("status") != "success":
                return q["id"], {"error": body.get("error") or "query failed"}
            return q["id"], {"series": body["data"]["result"]}
        except Exception as e:  # each query reports its own failure
            return q["id"], {"error": str(e)}

    with ThreadPoolExecutor(max_workers=12) as pool:
        return dict(pool.map(one, spec["queries"]))


def main():
    if len(sys.argv) < 4 or sys.argv[1] not in REGIONS or sys.argv[2] not in ("get", "query"):
        fail("usage: grafana.py <us|eu> get <path> | query <json>")
    region, verb, arg = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        with open(PRIVATE) as f:
            base = json.load(f)["grafana"]["api"][region].rstrip("/")
    except (OSError, ValueError, KeyError) as e:
        fail(f"No Grafana address for {region} in {PRIVATE} ({e})")
    secret = token(region)
    try:
        out = get(base, secret, arg) if verb == "get" else query(base, secret, json.loads(arg))
    except Exception as e:
        fail(str(e))
    print(json.dumps(out, separators=(",", ":")))


main()
