# Space tree

The `Pull-Requests` layout with one tree in place of the spaces and agents lists: spaces, then their agents, then each agent's sub-agents.

## What you see

- With another machine added (`hc machine ls`), spaces sit under a header per machine: "This computer" first, then each machine by name, with a dot that's green while connected, its state when it isn't (loading, asleep), a `+` for a new space there, and a chevron that folds it.
  With the `coder-devbox` piece enabled, a devbox's header also gets that piece's globe and right-click menu.
  A machine with no spaces offers "New space there".
- Each space is a row with its avatar, its name and a chevron that folds it.
  The avatar is an icon picked with "Change icon" in the space's right-click menu. Without one, it's the GitHub avatar of the repo's owner (from the `origin` remote, `github.com/<owner>.png`, downloaded once a day into `data/space-tree/avatars/` under Herdr's home), else the space's first letter on its color, as in Herdr's own list.
  The picker has all 1,539 Lucide icons (downloaded the first time it opens), a hand-picked 95 first, and a search field that matches their names and Lucide's tags ("money" finds the dollar sign). Up, down and Tab move through the matches, with the highlighted icon's name under the grid; Enter or a click picks, and the first tile goes back to the default (the GitHub avatar, or the letter).
  Each space keeps its own icon, so worktrees of one repo can look different.
  Folded, it shows its most urgent agent's status.
- Under a space, one row per agent, tab by tab: the program's icon, the tab's name or what the program says it's doing, then a branch tag and the agent's status.
  A tab split into panes gets a row per pane.
  Terminals that aren't agents stay out of the tree, except ones that started sub-agents; the tab bar above the panes still has every tab.
  The terminal button beside the header's `+` shows every terminal, and remembers the choice.
- The branch tag shows only when the terminal isn't on the space's branch, or sits in a git worktree (in the theme's magenta).
  For Claude Code it follows the worktree the session moved into, read from the session's transcript, since Claude Code's process stays in the main checkout.
- In the branch tag's place, a terminal on one of your open PRs (from the `pull-requests` panel) shows the PR instead: matched by branch, or by head commit for an agent on a detached checkout. It shows as `#number`, with `+N` when more than one matches, colored by the PR's state: red for conflicts, failing checks, changes requested or a failed merge queue; blue while checks run; cyan in the merge queue; yellow waiting on review or behind its base; green ready; dim for a draft. Hover for its title and state; a click opens it on GitHub.
- Sub-agents (terminals an agent started with `hc run`) sit under their agent with tree lines, and fold with its chevron.
- A terminal row does what a tab does in Herdr's tab bar: click to show it, double-click to rename the tab, drag onto another row of the same space to move the tab there, right-click for the tab menu.
  Its X, shown on hover and on the focused row, closes the tab, or just that pane when the tab is split.
  A tab's zoomed pane says `Z`.
- A sub-agent row focuses its pane, or peeks at it when it has none; its X closes the pane or ends the sub-agent.
- A space row selects the space on click and opens its menu on right-click: Herdr's space menu plus "Change icon". On hover, its `+` opens Herdr's new-tab menu there.
- The bar above the panes is Herdr's own tab bar, after the `back-forward` piece's arrows.
- `agent.next` and `agent.prev` follow the tree's order.
- The status bar at the bottom is Herdr's, plus a hint for each global key bound to a mod this repo installed (`mod.open:<mod>` or `<mod>.<command>`, read from `keys()` and `.posthog-herdr-files`), named by the mod's `mod.json` title, beside the palette's "commands" hint. A click runs it. Enabling or disabling a piece updates the hints within 5 seconds.

## Built from

- `layouts/Space-Tree.json`: `pull-requests/layouts/Pull-Requests.json` with its `spaces` and `agents` blocks replaced by one `space-tree` block. It needs the `pull-requests` piece for the PR panel and page.
  It also places a `back-forward` block left of the bar and a compact `ph-inbox` bar (40 px) above the PR panel, and the `claude-usage` strip (140 px) above the sidebar footer; the tree shows each block while its piece's mod is installed and hides it otherwise, checking every 2 seconds, so turning a piece on or off in the piece picker shows or hides its block.
- `mods/space-tree/main.js`: reads `spaces()`, `panes()`, `terminals()` and the PR panel's `prs.cache.mine`; `git remote get-url origin` once per repo, and `curl` for its owner's avatar once a day, shared with the picker as `space-tree.avatars`; every 10 seconds `git rev-parse` per folder in view (each folder at most every 30 seconds), and for Claude Code `hc get`, `~/.claude/sessions/<pid>.json` and the tail of the transcript, on the terminal's own machine. A remote pane's folder comes from `terminals()` when `panes()` has none.
- `mods/space-tree-menu/main.js`: the space items of Herdr's `menu` mod, plus "Change icon".
- `mods/space-tree-icon/main.js`: the icon picker, a virtual list so only the rows on screen are drawn. It keeps each space's choice in Herdr's shared state (`space-tree.icons`, space id to icon name).
- `mods/space-tree-icon/lucide.js`: the icons aren't in this repo. The first time the picker opens, it downloads `lucide-static` 0.460.0 from npm (4.7 MB, ISC), checks its SHA-256, and unpacks `icons/`, `tags.json` and `LICENSE` into `data/space-tree-icon/lucide-0.460.0/` under Herdr's home. Until then, the picker says it's downloading, and the tree shows the default for spaces with a picked icon.
- `mods/space-tree-status/main.js`: Herdr's `workspace-status` mod (0.1.18) with the piece shortcut hints.
