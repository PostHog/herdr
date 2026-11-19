# Coder devbox

Your PostHog devbox's hogli commands and its PostHog UI forward on its machine header in the spaces sidebar.

A Herdr machine whose ssh target ends in `.coder` (Coder's default) or starts with `coder.` (what `hogli devbox:setup` writes) is a Coder devbox. This piece adds two things to its header in `flat-spaces` (the `pull-requests` piece's spaces list), and nothing else to the window.

## What you see

- **A globe icon** (13 px, `mods/coder-devbox/globe.svg`) on a connected devbox's header, before its `+`, in `dim`.
  A click forwards the PostHog UI with `hogli devbox:forward` and opens it in your browser.
  While the forward runs, the globe is `accent` and its tooltip gives the local port; a click opens the page.
  It is a spinning ring while the forward starts.
- **A menu** on a right-click anywhere on a devbox's header, connected or not: a 240 px popup in the `popover` color with 28 px rows.
  - The box's name in 11.5 px `dim`.
  - "Open PostHog UI", with `localhost:18342` in `accent` while it's forwarded or "starting…", and "Stop forwarding" under it while a forward runs.
    When the forward fails, hogli's last line shows under it in `blocked`.
  - "Claude Remote Control", with "open" in `accent` while its space on the box exists. Dim while the box isn't connected.
  - A divider, then: Status, Check box setup, Logs, Sync my checkout, Log in to Claude, Log in to GitHub, Log in to Trunk, Apply dotfiles, Open in VS Code, Open in Cursor, Restart, Update template, Free disk space, Doctor, and Stop devbox in `blocked`.
    A row whose command isn't in the checkout's `hogli.yaml` is left out, so an older checkout doesn't show commands it can't run.
  - "Looking for your PostHog checkout…" while it looks, or, with none found, where it looked, in `blocked`. The rows stay dim until then.
- A click on "Open PostHog UI" from the globe opens the same menu, which closes itself once the browser opens.

## How it behaves

- The box's hogli target comes from its ssh target, `<workspace>.coder` or `coder.<workspace>` (yours) or `[<agent>.]<workspace>.<owner>.coder` (someone else's), and your Coder username from `coder whoami`.
  Your `devbox-<you>-<label>` is `<label>` and your `devbox-<you>` is `@<you>`; someone else's are `@<owner>/<label>` and `@<owner>`.
  The owner is never guessed by splitting the name, so hyphenated usernames work. A box not named `devbox-<owner>[-label]` can't be targeted, and the menu says so; Doctor still runs.
- hogli runs from your PostHog checkout's `bin/hogli` through your login shell (`$SHELL -lic`), so `coder` and the venv are found as in your terminal.
  The checkout is `checkouts["PostHog/posthog"]` from the `pull-requests` settings when set, else the first of `~/workspace/posthog`, `~/posthog`, `~/code/posthog`, `~/src/posthog`, `~/dev/posthog`, `~/projects/posthog`, `~/repos/posthog`, `~/git/posthog`, or a local space's folder, that has `bin/hogli`.
- **The UI forward** is `hogli devbox:forward <target>` started as a background herdr-core terminal (`hc run --bg`), labelled `coder-devbox.ui=<machine>`.
  hogli picks the local port (8010 for your default box, a port kept per box in 18000–18999 for labelled ones), so it's the same one the CLI gives you.
  The terminal runs a small `sh` script around hogli (with `PYTHONUNBUFFERED=1`): when hogli prints its URL, the script waits for the port to answer, labels its own terminal `coder-devbox.port=<port>` (`hc label "$HC_TERMINAL_ID"`), and opens `http://localhost:<port>`.
  So the forward finishes starting and opens the browser even when the menu has closed. If the port doesn't answer within 90 seconds, the script ends the terminal.
  The menu waits for the label and closes; when the terminal ends instead, it shows the terminal's last line and removes it. A finished forward is also removed before the next one starts.
  The terminal has no `herdr.space` label, so it stays out of your spaces, and it keeps running when the window closes. "Stop forwarding" kills it.
- **Open in VS Code / Cursor** run `hogli devbox:open --vscode|--cursor <target>` while the menu stays open, its row saying "opening…"; the menu closes when it succeeds and shows the error when it fails.
- **The other commands** open a terminal tab running `bin/hogli <command> <target>` in the local space whose folder is the checkout, or a new "PostHog" space there on this computer (`machine: ""`).
  The tab becomes a shell in the checkout when hogli finishes, so the output stays. Doctor runs without a target.
  Stop devbox, Restart and Update run in that tab, so hogli's own prompts and output are where you can see them.
- **Log in to Claude / GitHub / Trunk** run `hogli devbox:claude:login`, `hogli devbox:gh:login` and `hogli devbox:trunk:login` in that tab, so the login link or device code is where you can see it.
- **Check box setup** runs `hogli devbox:check`, which lists the logins and dotfiles the box still needs. **Apply dotfiles** runs `hogli devbox:dotfiles` for a box that couldn't clone a private dotfiles repo at start.
- **Claude Remote Control** opens a space named "Claude Remote Control" on the box (`space.new` with its `machine`) that runs `claude remote-control` in `~/posthog`. When it stops, Enter starts it again and Ctrl-D leaves a shell.
  The session lives as long as that terminal. A second click goes to the existing space instead of starting another.
- `flat-spaces` shows the globe and the menu only when `mods/coder-devbox/main.js` exists, so the spaces list is unchanged without this piece.
- It runs programs: `hc`, `nc`, `test`, `coder whoami`, your login shell with `bin/hogli`, and `open` (`xdg-open` on Linux). It reads `data/prs-config.json` and the checkout's `hogli.yaml`.

## Built from

- `mods/coder-devbox/main.js`: the menu, opened with `openOverlay({ mod: "coder-devbox", kind: "popup", props: { machine, target, action } })`; `action: "ui"` starts the forward at once.
- `mods/coder-devbox/hogli.js`: the target, the checkout search, starting and stopping the forward, and the command lines.
- `mod.json`: `{ "place": "none" }`, so it only shows as that popup.
- In `pull-requests/mods/flat-spaces/main.js`: the globe (`devboxChip`), the right-click on a devbox's header, and `devboxUi`, which finds the forward in `terminals()` by its label.
