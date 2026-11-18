# ella-csm

Your Name's Herdr setup for customer success work: painted backgrounds with matching colours, a sidebar built around a book of accounts, a to-do list where every item gets a Claude helper that preps it, Slack alerts that turn into to-dos with the investigation already done, and meeting prep that opens itself before each customer call.

![Scenes](preview.png)

It's built for one person's book, so parts of it need your own details before they work. The mods and the layout install like any other piece here. The background jobs and scripts live outside Herdr's folder, so `extras/setup.sh` puts those in place, and "Make it yours" below lists everything to change. Handing this folder to Claude Code and asking it to set the piece up for you works well: point it at this README and `RECIPE.md`.

## What's in it

**In Herdr** (the `ella` layout; `./install.sh enable ella-csm`):

- **Scenes.** Nine painted backgrounds (sunset, meadow, forest rain, starry night, seaside, cherry blossom, autumn, snowy village, forest), each with a colour theme. Swatches in the status bar switch background and colours together, and `cmd-shift-y` opens a picker with thumbnails. The pane-header buttons take shades of one colour from the scene.
- **Sidebar** (`ella-sidebar`): one scrolling column of cards for Spaces, Accounts, Agents, Pond and To-do. Each card folds and can be dragged taller or shorter.
  - **Accounts** (`ella-accounts`): your book, coloured by how long since you last touched each account, with a badge when a scout has posted about it. Click the badge for the alerts.
  - **Pond** (`ella-pond`): a small creature per running agent. Blue and drifting when working, grey and asleep when idle, pink and bobbing when it needs you, green when done. Hover for what it's doing, click to jump to it.
  - **To-do** (`ella-todo`): a checklist kept in `~/morning-launch/todo.md`. Each new item starts a helper that preps it in a shared "to-do helpers" space, and the row shows its status (checking, prepping, needs you, prep ready). Items that came from Slack get a "slack ↗" button that opens the source message. Commitments you made in meetings show up as suggestions you can accept or swipe away.
- **Pane header** (`ella-pane`): buttons on Claude panes for verify, log to Customer Analytics, draft a reply, a "?" that says in one sentence what the session is doing, minimise, and a thank-you. The wording of each button's prompt is in `mods/ella-pane/asks.js`.
- **Tabs** (`ella-tabs`): tab bar with an alerts chip, a "▾ N minimised" chip, and a ☁ button that hands the current job to Claude on your devbox.
- **Status bar** (`ella-status`): scene swatches and a Metabase login dot that turns pink when a region's login runs out.
- **Close guard** (`ella-close-guard`): closing a tab or pane asks first, and ticks off any to-do whose helper lived there.
- **Morning board** (`ella-morning`): a checklist tab for the tasks the morning launcher opened, each ticking itself off when its session writes a handover.
- Small popups: `ella-alerts`, `ella-minimised`, `ella-away`, `ella-handover`.

**Outside Herdr** (`extras/`; `zsh extras/setup.sh`):

- `bin/book-spaces`: runs every two minutes. Opens an account space with call prep ten minutes before each customer meeting on your calendar, adds what you said you'd do after the call, keeps the Accounts colours up to date, reads scout alerts every 30 minutes in work hours, and turns new posts about your accounts into to-do items.
- `morning-launch/`: the to-do helpers (`todo-agent`, `run-todo.sh` and their preambles), the Slack link finder (`todo-slack`), meeting commitments from Granola (`heard/heard.py`), and the 7:30 morning launcher (`launch.sh`, `run-task.sh`).
- `skills/plan-tomorrow`: `/plan-tomorrow` turns tonight's to-do list into sessions that start at 7:30 tomorrow.
- `bin/pane-gist`, `pane-gist-all`: the one-sentence summary behind the "?" button.
- `bin/herdr-style`: switches scenes from a terminal (`herdr-style meadow`).
- `bin/mb-status`, `bin/away`, `bin/acct-space`, `bin/codex-pane`: the Metabase dot, the devbox handover, account spaces, and a Codex review pane.
- `launchd/`: the four background jobs (book spaces, meeting commitments, morning launcher, pane summaries).
- `backgrounds/`: the scripts that made the scenes and button colours, if you want to paint your own (`gen_painted.py` needs `GEMINI_API_KEY`).

## Install

```sh
./install.sh enable ella-csm      # the mods and the ella layout
zsh ella-csm/extras/setup.sh --dry-run
zsh ella-csm/extras/setup.sh      # scripts, themes, skill, launchd jobs (not started)
```

Merge `ella-csm/keys.json` into `~/.config/herdr-app/keys.json` by hand: it binds `cmd-w` and `cmd-shift-w` to the close guard and `cmd-shift-y` to the scene picker. Then switch to the layout with `cmd-shift-l` (it's called `ella`).

`setup.sh` never overwrites a file you already have; it lists what it kept. It copies the launchd jobs but doesn't start them, and prints the commands for when you're ready.

## What it needs

- Claude Code (`claude` on your PATH), logged in, with the Slack and Granola connectors. The helpers run it headless.
- `hogpilot` (`hp`) with your book synced: the Accounts list, call prep and helpers all start from `hp book show` and `hp context`.
- The `acct` launcher from the CS account-tab-launcher skill, which `book-spaces` reads account names from and `acct-space` hooks into.
- `hogli` logged into Metabase for the status dot (optional; the dot just stays grey without it).
- A PostHog devbox for the ☁ away button (optional).
- `herdr-app` and `hc` in `~/.local/bin`.

## Make it yours

Each of these is a placeholder or something specific to Ella's book:

1. The internal bits: the Accounts colours read PostHog's internal Customer Analytics data, and meeting commitments get logged to Customer Analytics notes. The queries and the project number aren't in this public repo. Ask Ella (or anyone in customer success) for the `ella-csm-internal` folder and copy it to `~/.config/ella-csm/`, so you have `internal.json` and `sql/cadence.sql`, `sql/domains.sql` and `sql/sites.sql`. Without it, everything else works and the log says which file is missing.
2. `extras/bin/book-spaces`: `ME` (your email), `ELLA_SLACK` (your Slack member ID, from your Slack profile → ⋮ → Copy member ID), `ALERT_CHANNELS` (your own scout channels' IDs), `SHARED_CHANNELS` (the shared alert channels: look up each channel's ID under its name → About), `CHANNEL_ACCOUNT`, `ALIASES` and `NAMES` (spellings of your accounts), `LOCAL` (your time zone). Leave out any shared channel you find too noisy.
3. `extras/morning-launch/heard/granola-mcp.json`: create it with `{"mcpServers": {"granola": {"type": "http", "url": "https://mcp.granola.ai/mcp"}}}`. In `heard.py`, put your name where it says "Your Name".
4. `extras/bin/away`: `WORKSPACE` is your devbox's name.
5. The prompts talk to Claude about Ella ("Ella wants to come back to a verdict…"). Swap in your name and pronouns in `morning-launch/*.md`, `heard/heard.py`, `bin/book-spaces`, `bin/away` and `skills/plan-tomorrow/SKILL.md`. The prompts also tell helpers to follow your CLAUDE.md and memory, and to start with the hogpilot card, so they work best if you have those.
6. `mods/ella-pane/asks.js`: the button prompts are written for how Ella works (CA notes, her drafting style). Reword them to how you work.

The helpers are draft-only: the preambles tell them never to send anything outward (no Slack posts, emails or customer-visible changes). Keep that line if you change them.

Be careful with the Slack alerts. A post in a shared channel that tags you becomes a to-do item, and its helper runs unattended in Claude Code's auto mode with your connectors. Anyone who can post in those channels can therefore put text in front of an agent acting as you. The draft-only instruction in the preamble is the only guard. Only add channels where you trust who posts, and read each helper's handover before you act on it.

## Tests

```sh
for t in ella-csm/tests/*.mjs; do node $t; done     # the mods' logic, and that copied files haven't drifted
python3 ella-csm/extras/tests/test_alert_todos.py   # Slack alerts → to-dos, against throwaway folders
python3 ella-csm/extras/morning-launch/tests/test_heard.py
```

The shell tests in `extras/tests` and `extras/morning-launch/tests` drive a running Herdr and the installed scripts, so run them after `setup.sh`.

Some files exist in several copies because Herdr won't let one mod import another (for example `todo/list.js` and `close-guard/todo-list.js`). The tests fail when the copies drift. After editing a section mod, run `mods/ella-sidebar/sync.sh` in your Herdr folder to update the sidebar's copy.

## Where the pictures came from

The backgrounds were generated with Google's Gemini image model from text prompts describing each scene in a soft hand-painted style. They're for your own desktop.
