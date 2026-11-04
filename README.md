# PostHog Herdr layouts and mods

Layouts and mods for [Herdr](https://herdr.dev) that people at PostHog made for themselves and share here.
Each top-level folder is one piece. You pick the pieces you want, and `install.sh` links them into your Herdr config, so a `git pull` brings you your teammates' updates.

| Piece | What it is |
| --- | --- |
| [`posthog`](posthog/RECIPE.md) | Herdr's main layout plus a sidebar panel for your PRs, the Trunk merge queue and your reviews. |

## Install

```sh
git clone https://github.com/PostHog/herdr.git
cd herdr
./install.sh
```

The first run asks which pieces to enable. Then pick a layout with `cmd-shift-l`, or:

```sh
herdr-app do layout.switch '{"name":"posthog"}'
```

`ctrl-alt-shift-escape` always takes you back to Herdr's default layout.

The `posthog` piece needs the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`).
For the merge queue it also needs Trunk: a `PostHog/posthog` checkout, and `trunk` on your PATH or from that checkout's flox environment, after `trunk login`.
Without Trunk, the rest of the panel works and the Queue tab says what's missing.

## Update

```sh
./install.sh
```

This pulls the latest, relinks your pieces, and makes Herdr reload them.
It asks about pieces added since your last run.
It skips the pull when your checkout has local changes.

## Choose what you have

```sh
./install.sh list               # every piece, [x] when enabled here
./install.sh enable <piece>     # link it
./install.sh disable <piece>    # unlink it
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
3. Link it and try it: `./install.sh enable my-piece`, then `herdr-app check ~/.config/herdr-app/mods/<name>`.
4. Open a PR.

`install.sh` symlinks `.js` and `.json` files and copies everything else, because Herdr won't load an SVG through a symlink, and other assets likely behave the same.
Herdr also doesn't watch files through symlinks, so it won't reload your mod when you save.
Run `./install.sh --no-pull` after a change: it reloads the code and refreshes the copied files.

This repo is public. Keep tokens, customer data and internal URLs out of it, including screenshots.
