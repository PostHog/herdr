# PostHog Herdr layouts and mods

Layouts and mods for [Herdr](https://herdr.dev) that people at PostHog made for themselves and share here.
Each top-level folder with a `RECIPE.md` is one piece, apart from retired ones (below). You pick the pieces you want, and `install.sh` copies them into your Herdr config and keeps them up to date with your teammates' changes.

| Piece | What it is |
| --- | --- |
| [`pull-requests`](pull-requests/RECIPE.md) | A PR panel for Herdr's sidebar: your PRs, the Trunk merge queue and your reviews. Two layouts: `github-and-trunk` has just the panel, and `Pull-Requests` adds a full-page PR workspace (`cmd-shift-g`) with review ranking, workflows, and agent fixes and reviews on this computer or a Herdr machine. It also ships `flat-spaces`, a spaces list that doesn't fold worktree spaces under their repo, for layouts that opt into it. |

`github-and-trunk` used to be its own piece. It's part of `pull-requests` now, and `./install.sh` moves you over if you had it enabled. Its old folder stays for a while so older copies of `install.sh` keep working; `./install.sh` never lists or offers it.

## Install

```sh
git clone https://github.com/PostHog/herdr.git
cd herdr
./install.sh
```

The first run asks which pieces to enable. Then pick a layout with `cmd-shift-l`, or:

```sh
herdr-app do layout.switch '{"name":"Pull-Requests"}'      # panel plus the full page
herdr-app do layout.switch '{"name":"github-and-trunk"}'   # just the panel
```

`ctrl-alt-shift-escape` always takes you back to Herdr's default layout.

The `pull-requests` piece needs the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`).
For the merge queue it also needs Trunk: a `PostHog/posthog` checkout, and `trunk` on your PATH or from that checkout's flox environment, after `trunk login`.
Without Trunk, the rest of the panel works and the Queue tab says what's missing.

Agent fixes and reviews also need `claude` on the machine they run on. Settings, on the full page, sets the repos (`owner/*` covers a whole org), where agents and Trunk run, and each repo's checkout. In `github-and-trunk`, the panel's `⤢` opens the full page as a dialog. Merge `pull-requests/keys.json` (`cmd-shift-g`) into yours by hand.

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

A retired piece's name still works: `enable github-and-trunk` enables `pull-requests`, and `disable github-and-trunk` removes what it placed without enabling anything.

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
2. Pick names that no other piece uses, including retired ones like `github-and-trunk`, and that Herdr doesn't ship (`main`, `terminals`, `win98`, `agents`, `tabs`, `spaces`, and the rest under `~/.config/herdr-app/mods/`). The script skips a name Herdr ships, because Herdr would overwrite it.
3. Install it and try it: `./install.sh enable my-piece`, then `herdr-app check ~/.config/herdr-app/mods/<name>`.
4. Open a PR.

Herdr runs the copies in its config folder, not the files here, so saving in the repo changes nothing yet.
Run `./install.sh --no-pull` after a change: it copies what changed, and Herdr reloads it.
Symlinks don't work: Herdr refuses a module or an image that resolves outside its own folder.

This repo is public. Keep tokens, customer data and internal URLs out of it, including screenshots.
