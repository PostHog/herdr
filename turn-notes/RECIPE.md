# Turn notes

A column on the right with a short note for each finished turn of the Claude Code terminal you're in, newest first.

Each note is a label of a few words and up to three points: the numbers, files and decisions from that turn.
Haiku writes them with `claude -p`, one at a time, for the last 20 turns.

## How it behaves

- It follows the focused terminal. Clicking elsewhere keeps the last terminal's notes.
- A turn gets its note once Claude finishes it.
- Notes are saved per session in `data/turn-notes/`, so each one is written once.
- Each note is a separate `claude -p` call with no settings, hooks, MCP servers or session history, so it doesn't show up in `claude --resume`. It counts toward your Claude plan.
- It reads transcripts on this computer only, so it shows nothing for Claude running on a Herdr machine.

Needs `claude` on your PATH, logged in.
