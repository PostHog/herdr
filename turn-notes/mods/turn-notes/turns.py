#!/usr/bin/env python3
"""Print the turns of the Claude Code session a process is running, as JSON.

usage: turns.py <pid>

{"session": id, "busy": bool, "turns": [{"key", "user", "said"}]}, oldest first.
"""
import json, os, re, sys

NOISE = re.compile(r'<(system-reminder|command-name|command-message|command-args|local-command-stdout|'
                   r'local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|herdr-mode)>.*?</\1>', re.S)


def project_dir(cwd):
    return os.path.join(os.path.expanduser('~/.claude/projects'), re.sub(r'[^A-Za-z0-9]', '-', cwd))


def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    # A tool result comes back as a user entry: it continues the turn, it doesn't start one.
    if any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
        return None
    return '\n'.join(c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text')


def main():
    try:
        info = json.load(open(os.path.expanduser(f'~/.claude/sessions/{sys.argv[1]}.json')))
        sid = info['sessionId']
        path = os.path.join(project_dir(info['cwd']), sid + '.jsonl')
    except Exception:
        print('{}'); return
    turns = []
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get('isSidechain') or e.get('isMeta') or e.get('isCompactSummary'):
                    continue
                msg = e.get('message') or {}
                if e.get('type') == 'user':
                    text = text_of(msg.get('content'))
                    if text is None:
                        continue
                    text = NOISE.sub('', text).strip()
                    if text:
                        turns.append({'key': e.get('uuid') or str(len(turns)), 'user': text[:1500], 'said': []})
                elif e.get('type') == 'assistant' and turns:
                    for c in msg.get('content') or []:
                        if c.get('type') == 'text' and c.get('text', '').strip():
                            turns[-1]['said'].append('Agent: ' + c['text'].strip())
                        elif c.get('type') == 'tool_use':
                            turns[-1]['said'].append('Tool: ' + c.get('name', ''))
    except OSError:
        pass
    for t in turns:
        said = '\n'.join(t['said'])
        t['said'] = '…' + said[-3000:] if len(said) > 3000 else said
    print(json.dumps({'session': sid, 'busy': info.get('status') == 'busy', 'turns': turns}))


main()
