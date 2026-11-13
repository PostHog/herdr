# Space tree

The `Pull-Requests` layout with one tree in place of the spaces and agents lists: spaces, then their terminals and agents, then each agent's sub-agents.

## What you see

- Each space is a row with its avatar, name, machine and branch (main and master go unsaid), and a chevron that folds it.
  The avatar is the repo's own icon when it has one: the icon its web setup declares (a `<link rel="icon">` in its HTML, or Gatsby's manifest `icon`), else the best favicon, touch icon or `<repo>-icon` file it tracks in git.
  It sits on a small white tile with the theme's border, as browsers draw favicons, so dark and light logos both read in either theme.
  Without one, or for a space on another machine, it's the first letter on the space's color, as in Herdr's own list.
  Folded, it shows its most urgent agent's status.
- Under a space, one row per terminal, tab by tab: the program's icon, the tab's name or what the program says it's doing, then a branch tag and the agent's status.
  A tab split into panes gets a row per pane.
- The branch tag shows only when the terminal isn't on the space's branch, or sits in a git worktree (in the theme's magenta).
  For Claude Code it follows the worktree the session moved into, read from the session's transcript, since Claude Code's process stays in the main checkout.
- Sub-agents (terminals an agent started with `hc run`) sit under their agent with tree lines, and fold with its chevron.
- A terminal row does what a tab does in Herdr's tab bar: click to show it, double-click to rename the tab, drag onto another row of the same space to move the tab there, right-click for the tab menu.
  Its X, shown on hover and on the focused row, closes the tab, or just that pane when the tab is split.
  A tab's zoomed pane says `Z`.
- A sub-agent row focuses its pane, or peeks at it when it has none; its X closes the pane or ends the sub-agent.
- A space row selects the space on click and opens its menu on right-click. On hover, its `+` opens Herdr's new-tab menu there.
- The bar above the panes keeps only Herdr's new-tab menu, the Files and Changes buttons and, where the platform draws none, the window buttons. The scroll wheel on it still steps through tabs.
- `agent.next` and `agent.prev` follow the tree's order.

## Built from

- `layouts/Space-Tree.json`: `pull-requests/layouts/Pull-Requests.json` with its `spaces` and `agents` blocks replaced by one `space-tree` block, and its `tabs` block by `space-tree-bar`. It needs the `pull-requests` piece for the PR panel and page.
- `mods/space-tree/main.js`: reads `spaces()`, `panes()` and `terminals()`; every 10 seconds `git rev-parse` per folder in view (each folder at most every 30 seconds), and for Claude Code `hc get`, `~/.claude/sessions/<pid>.json` and the tail of the transcript.
- `mods/space-tree/icons.js`: scores the candidates `git ls-files` returns and copies the winner into `data/space-tree/icons/` under Herdr's home, named by its hash (an `.ico` becomes a PNG through macOS's `sips`). Each repo is looked at again every six hours.
- `mods/space-tree-bar/main.js`: Herdr's `tabs` mod (0.1.14) without the tab list, keeping its per-space panel memory.
