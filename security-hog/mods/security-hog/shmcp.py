#!/usr/bin/env python3
"""Minimal SecurityHog MCP client for the security-hog Herdr mod. Stdlib only.

    shmcp.py login                     sign in through the browser (OAuth, PKCE)
    shmcp.py status                    whether a sign-in is saved, and until when
    shmcp.py logout                    forget the saved sign-in
    shmcp.py call <tool> [json-args]   call one MCP tool, print its JSON result
    shmcp.py tools                     list the tool names the server offers

The sign-in is kept in ~/.config/security-hog/auth.json (mode 600) and never
goes on a command line. Success prints JSON on stdout and exits 0; failure
prints {"error", "code"?, "status"?} on stdout and exits 1.
"""

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

CONFIG_DIR = os.path.expanduser("~/.config/security-hog")
CONFIG = os.path.join(CONFIG_DIR, "config.json")
AUTH = os.path.join(CONFIG_DIR, "auth.json")
PROTOCOL = "2025-06-18"
CLIENT_NAME = "Herdr security-hog"
TIMEOUT = 90
LOGIN_WAIT = 300
EXPIRY_MARGIN = 60


class Failure(Exception):
    def __init__(self, error, code=None, status=None):
        super().__init__(error)
        self.payload = {"error": error}
        if code:
            self.payload["code"] = code
        if status:
            self.payload["status"] = status


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise Failure(f"{path} is not valid JSON: {e}", code="bad_config")


def write_auth(auth):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    fd = os.open(AUTH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(auth, f)
    os.chmod(AUTH, 0o600)


def mcp_url():
    url = read_json(CONFIG).get("url") or ""
    if not url.startswith("https://") and not url.startswith("http://localhost"):
        raise Failure(f"Put SecurityHog's MCP address in {CONFIG} as \"url\". SecurityHog's README has it.", code="no_url")
    return url


def unreachable(url, reason):
    host = urllib.parse.urlparse(url).hostname
    return Failure(f"Could not reach {host}: {reason}. SecurityHog's MCP server is only on PostHog's Tailscale network.", code="network")


def http(url, data=None, headers=None, form=False):
    body = None
    headers = dict(headers or {})
    headers.setdefault("User-Agent", "security-hog-herdr/0.1")
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, res.headers, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise unreachable(url, getattr(e, "reason", e))


def metadata(url):
    origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlparse(url))
    status, _, text = http(f"{origin}/.well-known/oauth-authorization-server")
    if status != 200:
        raise Failure(f"SecurityHog's login metadata returned {status}.", code="http", status=status)
    return json.loads(text)


def pkce():
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def register(meta):
    status, _, text = http(meta["registration_endpoint"], {
        "client_name": CLIENT_NAME,
        "redirect_uris": ["http://127.0.0.1/callback"],
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    })
    if status not in (200, 201):
        raise Failure(f"SecurityHog refused to register this app ({status}). {text[:300]}".strip(), code="http", status=status)
    return json.loads(text)["client_id"]


def wait_for_code(server, state):
    got = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            query = dict(urllib.parse.parse_qsl(parsed.query))
            if query.get("state") == state:
                got.update(query)
            ok = "code" in got
            message = "Signed in to SecurityHog. You can close this tab and go back to Herdr." if ok else \
                f"SecurityHog login failed: {query.get('error_description') or query.get('error') or 'unexpected answer'}."
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(f"<!doctype html><meta charset=utf-8><title>SecurityHog</title>"
                             f"<p style='font:15px system-ui;margin:4rem auto;max-width:30rem'>{message}</p>".encode())

        def log_message(self, format, *args):
            pass

    server.RequestHandlerClass = Callback
    server.timeout = 5
    deadline = time.time() + LOGIN_WAIT
    while not got and time.time() < deadline:
        server.handle_request()
    return got


def login():
    url = mcp_url()
    meta = metadata(url)
    auth = read_json(AUTH)
    client_id = auth.get("client_id") if auth.get("client_used") and auth.get("issuer") == meta.get("issuer") else None
    client_id = client_id or register(meta)
    server = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    redirect_uri = f"http://127.0.0.1:{server.server_address[1]}/callback"
    verifier, challenge = pkce()
    state = secrets.token_urlsafe(24)
    authorize = meta["authorization_endpoint"] + "?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "resource": url,
    })
    try:
        if not webbrowser.open(authorize):
            raise Failure(f"Could not open a browser. Open this link to sign in: {authorize}", code="browser")
        got = wait_for_code(server, state)
    finally:
        server.server_close()
    if not got:
        raise Failure("The sign-in timed out. Start it again.", code="login_timeout")
    if "code" not in got:
        raise Failure(f"SecurityHog login failed: {got.get('error_description') or got.get('error')}", code="login_denied")
    if got.get("iss") and got["iss"] != meta.get("issuer"):
        raise Failure("The sign-in answer came from an unexpected server.", code="login_denied")
    status, _, text = http(meta["token_endpoint"], {
        "grant_type": "authorization_code",
        "code": got["code"],
        "code_verifier": verifier,
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "resource": url,
    }, form=True)
    if status != 200:
        raise Failure(f"SecurityHog refused the sign-in ({status}). {text[:300]}".strip(), code="login_denied", status=status)
    token = json.loads(text)
    expires_at = int(time.time()) + int(token.get("expires_in", 8 * 3600))
    write_auth({"issuer": meta.get("issuer"), "client_id": client_id, "client_used": True,
                "access_token": token["access_token"], "expires_at": expires_at})
    return {"ok": True, "expires_at": expires_at}


def saved_token():
    auth = read_json(AUTH)
    token = auth.get("access_token")
    if not token:
        raise Failure("Sign in to SecurityHog.", code="login")
    if auth.get("expires_at", 0) - EXPIRY_MARGIN < time.time():
        raise Failure("Your SecurityHog sign-in expired. Sign in again.", code="login")
    return token, auth.get("expires_at")


def forget_token():
    auth = read_json(AUTH)
    if auth.pop("access_token", None):
        auth.pop("expires_at", None)
        write_auth(auth)


class Client:
    def __init__(self, token, url):
        self.token = token
        self.url = url
        self.next_id = 0

    def request(self, method, params=None):
        self.next_id += 1
        want = self.next_id
        body = {"jsonrpc": "2.0", "id": want, "method": method}
        if params is not None:
            body["params"] = params
        status, headers, text = http(self.url, body, {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL,
        })
        if status in (401, 403):
            forget_token()
            raise Failure("SecurityHog no longer accepts this sign-in. Sign in again.", code="login", status=status)
        if status >= 400:
            raise Failure(f"SecurityHog MCP returned {status}. {text[:300]}".strip(), code="http", status=status)
        for message in messages(headers.get("Content-Type", ""), text):
            if message.get("id") == want:
                if "error" in message:
                    err = message["error"]
                    raise Failure(err.get("message", "MCP error"), code=f"rpc{err.get('code', '')}")
                return message.get("result", {})
        raise Failure(f"No reply to {method} from the MCP server.", code="protocol")

    def start(self):
        self.request("initialize", {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "security-hog-herdr", "version": "0.1"},
        })

    def tool_names(self):
        return [t["name"] for t in self.request("tools/list", {}).get("tools", [])]

    def call(self, name, arguments):
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        if result.get("isError"):
            raise Failure(text.strip() or f"{name} failed", code="tool")
        try:
            return json.loads(text)
        except ValueError:
            return {"text": text}


def messages(kind, text):
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


def main(argv):
    command = argv[1] if len(argv) > 1 else None
    if command == "login":
        return login()
    if command == "logout":
        forget_token()
        return {"ok": True}
    if command == "status":
        try:
            _, expires_at = saved_token()
            return {"signed_in": True, "expires_at": expires_at}
        except Failure:
            return {"signed_in": False}
    if command not in ("call", "tools"):
        raise Failure("usage: shmcp.py login | status | logout | tools | call <tool> [json]", code="usage")
    token, _ = saved_token()
    client = Client(token, mcp_url())
    client.start()
    if command == "tools":
        return client.tool_names()
    if len(argv) < 3:
        raise Failure("call needs a tool name", code="usage")
    try:
        args = json.loads(argv[3]) if len(argv) > 3 else {}
    except ValueError as e:
        raise Failure(f"arguments are not JSON: {e}", code="usage")
    return client.call(argv[2], args)


if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv)))
    except Failure as f:
        print(json.dumps(f.payload))
        sys.exit(1)
