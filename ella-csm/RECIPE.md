# ella-csm

A customer success setup: painted scenes with matching colours, a book-of-accounts sidebar, a to-do list whose items each get a Claude helper, and Slack alerts and calendar calls that turn into prepped work on their own.

`README.md` covers what each part is, how to install it and what to change for your own book. This file says how it behaves and what it's built from, for an agent rebuilding or adapting it.

## Layout

`layouts/ella.json` is a clone of Herdr's `main` with a background image (`mods/ella-scenes/images/<scene>.jpg`, fit cover) and the frame opened up so it shows: root padding and gap 12, and the sidebar blocks, tab bar and status bar drawn as cards (`background: chrome, radius 12, border, shadow md`). The sidebar's list area is one block, `ella-sidebar`. The tab bar is `ella-tabs`, the pane header is `ella-pane` and the status bar is `ella-status`. Files and Changes stay as Herdr ships them.

## Mods

- `ella-scenes`: popup grid of scenes from `scenes.json` (`id`, `label`, `theme`, `image`, `thumb`, `swatch`, `buttons`). Clicking one sets the shown layout's root background, saves the theme as the dark theme in `settings.json`, runs `app.theme`, and shares the six button colours as `style.buttons`. On a read-only layout it clones it first. The popup needs a fixed root height.
- `ella-status`: one swatch per scene, which runs `~/.local/bin/herdr-style <id>` (same steps as the picker, from a script). It re-reads `scenes.json` and `~/.config/herdr-app/ella-style.json` every 4 s and shares the current scene's `buttons`. The Metabase dot runs `~/.local/bin/mb-status` every 15 min.
- `ella-pane`: clone of `pane`. Buttons on Claude panes send the prompts in `asks.js` with `hc send`, adding the space name in account spaces. Button colours come from `style.buttons`, falling back to theme ansi slots. "?" shows `pane-gist --cached` on hover and refreshes on click. Minimise runs `terminal.park` and adds the terminal to shared `pane.minimised`. Close opens `ella-close-guard`.
- `ella-tabs`: clone of `tabs`, with an alerts chip that opens `ella-alerts`, a minimised chip that opens `ella-minimised`, and ☁ that opens `ella-away`.
- `ella-sidebar`: hosts the sections as nested views (`cx.new(Class)`) in one `overflow_y_scrollbar`, each a card with a 16 px drag strip. Heights go in shared `sidebar.heights` and folds in `sidebar.folded`. Herdr won't import modules from outside a mod's folder, so each section's code is copied into `sections/<name>/`; `sync.sh` hard-links them from the section mods, and `tests/ella-sidebar.test.mjs` fails on drift. Nested sections don't get their own `mod.json` file grants or localStorage.
- Section mods (`ella-spaces`, `ella-accounts`, `ella-agents`, `ella-pond`, `ella-todo`): also usable on their own. `fold.js` is identical in each, and its `SECTIONS` list must include every section.
  - `ella-accounts` reads `~/book/spaces/cadence.json` (days since last touch, renewal) and `~/book/spaces/alerts.json` (scout posts per account), both written by `book-spaces`.
  - `ella-pond`: `look.js` holds the pure logic (mood from agent state, placement, leaf colour per space). Herdr's `on_size_change` widths aren't divided by app zoom but drawn sizes are, so it unzooms them.
  - `ella-todo`: `list.js` parses and serialises `~/morning-launch/todo.md`. `- [x]` lines carry `<!-- done:DATE -->`, and Slack-sourced lines carry `<!-- slack:URL -->`, which the slug ignores. The slug is djb2-xor in base 36 and must match `todo_slug()` in `book-spaces`. Each new open item runs `~/morning-launch/todo-agent <slug> <text>`, and the row shows `~/morning-launch/todo-prep/<slug>.json` status. Items with no Slack record run `todo-slack`, one at a time. `heard.js` shows pending meeting commitments from `~/morning-launch/heard/heard.json`.
- `ella-close-guard`: a dialog for cmd-w, the tab ✕, the pane ✕ and cmd-shift-w. Confirming ticks every open to-do whose helper terminal is in what's closing. It ticks and closes the dialog first and shuts the terminals last, because work queued after `closeOverlay` never runs. `todo-list.js` is a copy of `ella-todo/list.js`.
- `ella-morning`: tab content for the morning launcher. It lists `~/morning-launch/tasks/<day>/NN-*.md` and ticks each one when `NN-*.done.md` appears.
- `ella-alerts`, `ella-minimised`, `ella-away`, `ella-handover`: small popups. `ella-handover` shows a markdown file read-only and isn't wired to a button.

## Outside Herdr

- `book-spaces` (launchd every 2 min) does four things:
  - Ten minutes before each external calendar meeting with a book account, it opens an account space with a prep prompt.
  - After the call, it reads the Granola transcript and sends what you committed to.
  - It refreshes `cadence.json`. The queries for this, and the Customer Analytics project id, come from `~/.config/ella-csm/` (`internal.json`, `sql/*.sql`), which is kept out of the public repo.
  - Every 30 min in work hours it refreshes `alerts.json` and runs `alert-todos`. That reads new posts in your scout channels and top-level posts tagging you in the shared alert channels (since the last run minus an hour, 12 h on the first run). Sonnet decides add or skip, checking for duplicates against open and done-today items. It adds at most 8 lines per run as `- [ ] Account: … <!-- slack:URL -->`, and writes `todo-links/<slug>.json` with `how: "alert"`. `todo-agent` sees that record and starts the helper with `todo-alert-preamble.md`: confirm the alert at the source, compare with the account's normal pattern, give the likely cause, and open the handover with "Action needed:" or "No action:".
- `todo-agent`: a Haiku yes/no check on whether Claude can prep the item (Sonnet when unclear), then a Claude pane in one shared "to-do helpers" space, three across. Handovers go to `todo-prep/<slug>.md`.
- `todo-slack`: uses a pasted Slack link if there is one. Otherwise a headless Sonnet Slack search runs, and the result counts only if exactly one distinct permalink comes back. Put the prompt before `--allowedTools`, which takes several values and would swallow it.
- `heard.py` (launchd): finds commitments in Granola transcripts, but only on your own Microphone lines and only with a verbatim quote, and writes them to `heard.json` as pending.
- `pane-gist`: a one-sentence summary of a Claude session, from its transcript, via Haiku. `pane-gist-all` (launchd every 2 min) refreshes the cache.
- `launch.sh` (launchd 7:30 weekdays): opens a day space with an `ella-morning` tab and one tab per task file that `/plan-tomorrow` wrote.

## Reaches outside its folder

It reads and writes `~/morning-launch`, `~/book/spaces`, the shown layout file and `settings.json`. It runs `~/.local/bin` scripts, `claude` (headless, with Slack and Granola connectors), `hp`, `hogli` and `hc`. The helpers are draft-only and never send anything outward.
