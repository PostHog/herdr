# PostHog Herdr layouts and mods

Layouts and mods for [Herdr](https://herdr.dev) that people at PostHog made for themselves and share here.
Each top-level folder with a `RECIPE.md` is one piece. You pick the pieces you want, and `install.sh` copies them into your Herdr config and keeps them up to date with your teammates' changes.

| Piece | What it is |
| --- | --- |
| [`pull-requests`](pull-requests/README.md) | A PR panel for Herdr's sidebar: your PRs, the Trunk merge queue and your reviews. The `Pull-Requests` layout adds a full-page PR workspace (`cmd-shift-g`) with review ranking, workflows, Keep healthy (an agent that keeps your chosen PRs mergeable), and agent fixes and reviews on this computer or a Herdr machine. It uses `flat-spaces`, a spaces list that doesn't fold worktree spaces under their repo. |
| [`claude-usage`](claude-usage/RECIPE.md) | Herdr's main layout plus a strip with your live Claude plan limits, and token counts per session. |
| [`dopamine-squirrel`](dopamine-squirrel/README.md) | Jake Ruth's opinionated, ADHD-proof setup for a vertical monitor: a top bar and one panel for running agents (context %, cost, plan limits), review requests with triage, your PRs and the Trunk merge queue. Some buttons use Jake's PostHog skills; the README says which. Pick the parts you want. |
| [`resume-agents`](resume-agents/RECIPE.md) | Brings Claude Code back in its terminals after you restart or shut down your computer. The shared layouts above already make room for it. |
| [`space-tree`](space-tree/RECIPE.md) | The `Pull-Requests` layout with one sidebar tree: spaces (with each repo's own icon), their terminals and agents, and each agent's sub-agents, grouped by machine. The tabs move from the top bar into the tree. Needs `pull-requests`. |

## Install

```sh
git clone https://github.com/PostHog/herdr.git
cd herdr
./install.sh
```

The first run asks which pieces to enable. Then pick a layout with `cmd-shift-l`, or:

```sh
herdr-app do layout.switch '{"name":"Pull-Requests"}'
```

`ctrl-alt-shift-escape` always takes you back to Herdr's default layout.

The `pull-requests` piece needs the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`).
For the merge queue it also needs Trunk: a `PostHog/posthog` checkout, and `trunk` on your PATH or from that checkout's flox environment, after `trunk login`.
Without Trunk, the rest of the panel works and the Status page says what's missing.

Agent fixes and reviews also need `claude` on the machine they run on. Settings, on the full page, sets the repos (`owner/*` covers a whole org), where agents and Trunk run, and each repo's checkout. Merge `pull-requests/keys.json` (`cmd-shift-g`) into yours by hand.

The `claude-usage` piece needs Claude Code logged in with a Claude subscription.
Its Connect button changes your Claude Code `statusLine` setting to a wrapper that keeps your own statusline, and Disconnect puts the setting back.

## Update

```sh
./install.sh
```

This pulls the latest and copies what changed. Herdr reloads it by itself.
It asks about pieces added since your last run.
It skips the pull when your checkout has local changes.

## Choose what you have

```sh
./install.sh list               # every piece, [x] when enabled here
./install.sh enable <piece>     # install it
./install.sh disable <piece>    # remove it
```

`cmd-shift-l` cycles through every layout in Herdr's config folder.
That's Herdr's own `main`, `terminals` and `win98`, which Herdr puts back on every start, plus the pieces you enabled.
Herdr has no setting to hide a layout from the cycle, so enabling a piece is how you add its layout.

What you enabled is kept per machine in `~/.config/herdr-app/.posthog-herdr-enabled`.
If something of yours is in the way, the script moves it to `~/.config/herdr-app/.posthog-herdr-backup/` first.
It only removes files it placed itself, which it lists in `~/.config/herdr-app/.posthog-herdr-files`.

## Add a piece

1. Make a folder named after the piece, laid out like Herdr's config folder:

   ```text
   my-piece/
     RECIPE.md          required: what it is, how it behaves, what it's built from
     preview.png        a screenshot
     layouts/<name>.json
     mods/<name>/main.js, mod.json, ...
     keys.json          optional: key bindings people merge by hand
   ```

   Herdr's own guide, `~/.config/herdr-app/AGENTS.md`, covers layouts, mods and the `RECIPE.md` format.
   The first sentence of `RECIPE.md` is the summary `install.sh` shows, so keep it short.
2. Pick names that no other piece uses and that Herdr doesn't ship (`main`, `terminals`, `win98`, `agents`, `tabs`, `spaces`, and the rest under `~/.config/herdr-app/mods/`). The script skips a name Herdr ships, because Herdr would overwrite it.
3. Install it and try it: `./install.sh enable my-piece`, then `herdr-app check ~/.config/herdr-app/mods/<name>`.
4. Open a PR.

Herdr runs the copies in its config folder, not the files here, so saving in the repo changes nothing yet.
Run `./install.sh --no-pull` after a change: it copies what changed, and Herdr reloads it.
Symlinks don't work: Herdr refuses a module or an image that resolves outside its own folder.

This repo is public. Keep tokens, customer data and internal URLs out of it, including screenshots.
