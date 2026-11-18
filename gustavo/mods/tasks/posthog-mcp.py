"""Calls tools of PostHog's MCP server (https://mcp.posthog.com/mcp) and prints their results.

    posthog-mcp.py <tool> [json arguments]
    posthog-mcp.py --batch '[["<tool>", {arguments}], ...]'   (one MCP session for all of them)

Prints {"ok": true, "result": <the tool's JSON, or its text>}, with --batch {"ok": true,
"results": [{"ok": true, "result": ...} | {"ok": false, "error": ...}, ...]}, or {"ok": false,
"error": ..., "code": ...} when the session itself failed; always exits 0 so the caller reads the
reason. code "no_token" = nothing in the keychain, "auth" = PostHog refused the key, "scope" =
the key lacks a scope the tool needs.

Auth is a PostHog personal API key in the login keychain (service "herdr-posthog"), read here
and sent only to mcp.posthog.com. The session is read-only (x-posthog-read-only), pinned to the
PostHog project (x-posthog-project-id). Tools go through the server's `exec` tool as
`call --json <tool> <arguments>`, as Claude Code calls them: in "tools" mode the server answers
with its compact text format, and the tool schemas drop the `output_format` that would ask for JSON.

Run with /usr/bin/python3 -I: standard library only. Herdr kills an exec after 30 s, so every
request has a deadline well under that.
"""

import json
import subprocess
import sys
import urllib.error
import urllib.request

URL = "https://mcp.posthog.com/mcp"
PROJECT_ID = "2"  # PostHog's own project on US cloud, where the support tickets live
KEYCHAIN_SERVICE = "herdr-posthog"
TIMEOUT_S = 12


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
        raise Failure("No PostHog API key in the keychain", "no_token")
    return r.stdout.strip()


def messages(body, content_type):
    """JSON-RPC messages from a response: plain JSON, or the data lines of an SSE stream."""
    if "text/event-stream" in content_type:
        out = []
        for line in body.splitlines():
            if line.startswith("data:"):
                data = line[5:].strip()
                if data:
                    out.append(json.loads(data))
        return out
    return [json.loads(body)] if body.strip() else []


class Session:
    def __init__(self, key):
        self.headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": "herdr-support-hero/1",
            "x-posthog-project-id": PROJECT_ID,
            "x-posthog-read-only": "true",
        }
        self.next_id = 0

    def post(self, payload):
        req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=self.headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
                sid = res.headers.get("Mcp-Session-Id")
                if sid:
                    self.headers["Mcp-Session-Id"] = sid
                return messages(res.read().decode(), res.headers.get("Content-Type", ""))
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise Failure(f"PostHog MCP said {e.code}: {detail}", "auth" if e.code in (401, 403) else "http") from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise Failure(f"Can't reach PostHog MCP: {getattr(e, 'reason', e)}", "network") from None

    def request(self, method, params):
        self.next_id += 1
        for msg in self.post({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}):
            if msg.get("id") != self.next_id:
                continue  # a notification sent along the way
            if "error" in msg:
                raise Failure(f"{method}: {msg['error'].get('message', msg['error'])}")
            return msg.get("result", {})
        raise Failure(f"{method}: no answer from PostHog MCP")

    def notify(self, method):
        self.post({"jsonrpc": "2.0", "method": method})


def connect():
    s = Session(token())
    s.request("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "herdr-support-hero", "version": "1"},
    })
    s.notify("notifications/initialized")
    return s


def call(s, tool, arguments):
    command = f"call --json {tool} {json.dumps(arguments, separators=(',', ':'))}"
    result = s.request("tools/call", {"name": "exec", "arguments": {"command": command, "context": "Herdr support hero panel"}})
    text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    if result.get("isError"):
        if "missing the required scope" in text:
            raise Failure("The API key is missing the ticket:read scope", "scope")
        raise Failure(f"{tool}: {text[:300]}")
    if "structuredContent" in result:
        return result["structuredContent"]
    try:
        return json.loads(text)
    except ValueError:
        return text


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    try:
        s = connect()
        if sys.argv[1] == "--batch":
            results = []
            for tool, arguments in json.loads(sys.argv[2]):
                try:
                    results.append({"ok": True, "result": call(s, tool, arguments)})
                except Failure as e:
                    if e.code in ("auth", "network", "scope"):
                        raise
                    results.append({"ok": False, "error": str(e)})
            out = {"ok": True, "results": results}
        else:
            out = {"ok": True, "result": call(s, sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})}
    except Failure as e:
        out = {"ok": False, "error": str(e), "code": e.code}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
