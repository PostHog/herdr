#!/usr/bin/env python3
"""Minimal PostHog MCP client for the ph-inbox Herdr mod. Stdlib only.

    phmcp.py call <tool> [json-args]   call one MCP tool, print its JSON result
    phmcp.py tools                     list the tool names the server offers
    phmcp.py check                     verify the config and the key

The key is read from ~/.config/posthog-inbox/config.json ("api_key") or
POSTHOG_PERSONAL_API_KEY, never from argv. Success prints JSON on stdout and
exits 0; failure prints {"error", "code"?, "status"?} on stdout and exits 1,
so the mod can show the reason.
"""

import json
import os
import sys
import urllib.error
import urllib.request

CONFIG_DIR = os.path.expanduser("~/.config/posthog-inbox")
CONFIG = os.path.join(CONFIG_DIR, "config.json")
CACHE = os.path.join(CONFIG_DIR, "cache.json")
DEFAULT_URL = "https://mcp.posthog.com/mcp"
PROTOCOL = "2025-06-18"
TIMEOUT = 90


class Failure(Exception):
    def __init__(self, error, code=None, status=None):
        super().__init__(error)
        self.payload = {"error": error}
        if code:
            self.payload["code"] = code
        if status:
            self.payload["status"] = status


def load_config():
    config = {}
    if os.path.exists(CONFIG):
        try:
            with open(CONFIG) as f:
                config = json.load(f)
        except (OSError, ValueError) as e:
            raise Failure(f"{CONFIG} is not valid JSON: {e}", code="bad_config")
    key = config.get("api_key") or os.environ.get("POSTHOG_PERSONAL_API_KEY")
    if not key or key.startswith("phx_REPLACE"):
        raise Failure(f"No PostHog personal API key. Put one in {CONFIG} as \"api_key\".", code="no_key")
    return key, config.get("url") or DEFAULT_URL


def read_cache():
    try:
        with open(CACHE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_cache(cache):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CACHE, "w") as f:
            json.dump(cache, f)
    except OSError:
        pass


class Client:
    def __init__(self, key, url):
        self.key = key
        self.url = url
        self.session = None
        self.next_id = 0

    def post(self, body):
        headers = {
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": "ph-inbox-herdr/0.1",
            "MCP-Protocol-Version": PROTOCOL,
        }
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                self.session = res.headers.get("Mcp-Session-Id") or self.session
                return res.headers.get("Content-Type", ""), res.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")[:500]
            if e.code in (401, 403):
                raise Failure(f"PostHog refused the API key ({e.code}). {text}".strip(), code="unauthorized", status=e.code)
            raise Failure(f"PostHog MCP returned {e.code}. {text}".strip(), code="http", status=e.code)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise Failure(f"Could not reach {self.url}: {getattr(e, 'reason', e)}", code="network")

    def request(self, method, params=None):
        self.next_id += 1
        want = self.next_id
        body = {"jsonrpc": "2.0", "id": want, "method": method}
        if params is not None:
            body["params"] = params
        kind, text = self.post(body)
        for message in messages(kind, text):
            if message.get("id") == want:
                if "error" in message:
                    err = message["error"]
                    raise Failure(err.get("message", "MCP error"), code=f"rpc{err.get('code', '')}")
                return message.get("result", {})
        raise Failure(f"No reply to {method} from the MCP server.", code="protocol")

    def notify(self, method):
        self.post({"jsonrpc": "2.0", "method": method})

    def start(self):
        self.request("initialize", {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "ph-inbox-herdr", "version": "0.1"},
        })
        self.notify("notifications/initialized")

    def tool_names(self):
        names, cursor = [], None
        while True:
            result = self.request("tools/list", {"cursor": cursor} if cursor else {})
            names += [t["name"] for t in result.get("tools", [])]
            cursor = result.get("nextCursor")
            if not cursor:
                return names

    def call(self, name, arguments):
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        if result.get("isError"):
            raise Failure(text.strip() or f"{name} failed", code="tool")
        return text


def messages(kind, text):
    """The JSON-RPC messages in a reply: one JSON body, or an event stream of them."""
    if "text/event-stream" not in kind:
        try:
            data = json.loads(text) if text.strip() else []
        except ValueError:
            raise Failure(f"Unreadable reply from the MCP server: {text[:200]}", code="protocol")
        return data if isinstance(data, list) else [data]
    out, buf = [], []
    for line in text.splitlines() + [""]:
        if line.startswith("data:"):
            buf.append(line[5:].lstrip())
        elif not line.strip() and buf:
            try:
                out.append(json.loads("\n".join(buf)))
            except ValueError:
                pass
            buf = []
    return out


def first_json(text):
    """The first JSON value in a tool's text (the server may append notes after it)."""
    start = min((i for i in (text.find("{"), text.find("[")) if i >= 0), default=-1)
    if start < 0:
        return {"text": text}
    try:
        return json.JSONDecoder().raw_decode(text[start:])[0]
    except ValueError:
        return {"text": text}


def call_tool(client, tool, args):
    """Call `tool` directly when the server lists it, else through its `exec` wrapper."""
    cache = read_cache()
    mode = cache.get("mode", {}).get(client.url)
    if mode is None:
        names = client.tool_names()
        mode = "direct" if tool in names else "exec" if "exec" in names else "direct"
        cache.setdefault("mode", {})[client.url] = mode
        write_cache(cache)
    if mode == "exec":
        text = client.call("exec", {
            "command": f"call --json {tool} {json.dumps(args, separators=(',', ':'))}",
            "context": "Desktop inbox panel listing and acting on reports for its owner",
            "llm_model": "unknown",
        })
    else:
        text = client.call(tool, args)
    return first_json(text)


def main(argv):
    if len(argv) < 2 or argv[1] not in ("call", "tools", "check"):
        raise Failure("usage: phmcp.py call <tool> [json] | tools | check", code="usage")
    key, url = load_config()
    client = Client(key, url)
    client.start()
    if argv[1] == "tools":
        return client.tool_names()
    if argv[1] == "check":
        return {"ok": True, "url": url, "tools": len(client.tool_names())}
    if len(argv) < 3:
        raise Failure("call needs a tool name", code="usage")
    try:
        args = json.loads(argv[3]) if len(argv) > 3 else {}
    except ValueError as e:
        raise Failure(f"arguments are not JSON: {e}", code="usage")
    return call_tool(client, argv[2], args)


if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv)))
    except Failure as f:
        print(json.dumps(f.payload))
        sys.exit(1)
