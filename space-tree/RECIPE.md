# Space tree

The `Pull-Requests` layout with one tree in place of the spaces and agents lists: spaces, then their terminals and agents, then each agent's sub-agents.

## What you see

- Each space is a row with its avatar, name, machine and branch (main and master go unsaid), and a chevron that folds it.
  Folded, it shows its most urgent agent's status.
- Under a space, one row per terminal, tab by tab: the program's icon, the tab's name or what the program says it's doing, then a branch tag and the agent's status.
  A tab split into panes gets a row per pane.
- The branch tag shows only when the terminal isn't on the space's branch, or sits in a git worktree (in the theme's magenta).
  For Claude Code it follows the worktree the session moved into, read from the session's transcript, since Claude Code's process stays in the main checkout.
- Sub-agents (terminals an agent started with `hc run`) sit under their agent with tree lines, and fold with its chevron.
- Clicking a space selects it; clicking a terminal focuses its pane, or peeks at a sub-agent without one. Right-clicking a space opens its menu.
- `agent.next` and `agent.prev` follow the tree's order.

## Built from

- `layouts/Space-Tree.json`: `pull-requests/layouts/Pull-Requests.json` with its `spaces` and `agents` blocks replaced by one `space-tree` block. It needs the `pull-requests` piece for the PR panel and page.
- `mods/space-tree/main.js`: reads `spaces()`, `panes()` and `terminals()`; every 10 seconds `git rev-parse` per folder in view (each folder at most every 30 seconds), and for Claude Code `hc get`, `~/.claude/sessions/<pid>.json` and the tail of the transcript.
