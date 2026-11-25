#!/usr/bin/python3
"""Prints the end of a Claude conversation as plain talk: what the person typed and what Claude
replied, without tool calls, tool output or thinking. Newest last, at most MAX characters.

  recent-talk.py TRANSCRIPT.jsonl
"""
import json, os, sys

MAX = 12000
TAIL = 4_000_000


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


path = sys.argv[1]
with open(path, "rb") as f:
    f.seek(max(0, os.path.getsize(path) - TAIL))
    lines = f.read().decode("utf-8", "replace").splitlines()[1:]

talk = []
for line in lines:
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if e.get("type") not in ("user", "assistant") or e.get("isMeta") or e.get("isSidechain"):
        continue
    text = text_of((e.get("message") or {}).get("content")).strip()
    if not text or text.startswith("<") or text.startswith("This session is being continued"):
        continue
    talk.append(("Person: " if e["type"] == "user" else "Claude: ") + text)

out, size = [], 0
for t in reversed(talk):
    if size + len(t) > MAX:
        break
    out.append(t)
    size += len(t)
print("\n\n".join(reversed(out)))
