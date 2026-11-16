# Hogpilot

A side panel for CSMs that shows hogpilot's book of accounts, and the card for the account the focused terminal is working on.

Hogpilot is PostHog's internal account-memory tool for CSMs: it distills agent sessions into facts and signals per customer and keeps them in a local store.
This panel reads that store. It needs hogpilot installed and its book synced (`hp doctor` says whether it is).

## What you see

- **The book.** One row per active account, most open signals first, then the most ARR at stake.
  Each row has a dot (grey with no open signals, the theme's working colour with some, red when $50k or more is at stake) and a line with its signal count, ARR at stake and remembered facts.
- **The card.** Click a row, or work in a terminal that belongs to an account, and the panel shows `hp context <org>` for it as Markdown.
  It follows focus: a terminal whose folder is inside an account folder (see Settings), or a tab or space named after an account, picks that account.
  Clicking a row pins it instead; "← Book" goes back.
- **Buttons on the card.** "Ask Claude" opens a new tab running Claude Code with a prompt to catch up on that account.
  "Dossier" opens the account's dossier, when you have an accounts folder.
- **Status line.** When hogpilot last captured facts from a session, and a red note if its team pull is failing (hover for the error).
  A toast says when a new capture lands.

It refreshes every 5 minutes, when `~/.config/hogpilot/distill.log` changes, and on ↻.

## Placing it

The mod has `"place": "none"`, so a layout has to place it.
The usual spot is the right-hand panel, as one more child of its `panel-body` stack, next to `files` and `changes`:

```json
{ "id": "hogpilot", "type": "block", "content": { "mod": "hogpilot" } }
```

Clone the layout you use first if it's one of Herdr's own, since those are replaced on every start.
Then show it with `herdr-app do layout.select '{"stack":"panel-body","child":"hogpilot"}'` and `herdr-app do layout.show '{"id":"panel"}'`, or give it a button in your tab bar.
`hog.svg` is there for that button.

## Settings

All optional, in `data/hogpilot.json` under Herdr's home (`~/.config/herdr-app/data/hogpilot.json`):

```json
{
  "accounts": "~/Notes/Customers/Accounts",
  "claudeFolder": "~/Notes/Customers",
  "notesPanel": false,
  "hp": "~/.local/bin/hp"
}
```

- `accounts`: a folder with one folder per account, each holding `<Name>/<Name>.md` with a `posthog_org_id: <org uuid>` line (Obsidian frontmatter works).
  This turns on following terminals by folder, and the Dossier button. Without it, the panel matches accounts by tab and space names only.
- `claudeFolder`: where "Ask Claude" starts. Without it, the focused terminal's folder.
- `notesPanel`: `true` opens dossiers in a `notes` mod in the same `panel-body` stack. Otherwise they open in the file's default app.
- `hp`: where the hp CLI is. Defaults to `~/.local/bin/hp`, where hogpilot installs it.

The panel reads the file on each refresh, so ↻ picks up a change.

## Built from

- `mods/hogpilot/main.js`: a `View`. The book is one query on `~/.local/state/hogpilot/state.db` (tables `book`, `account_signals`, `memory_facts`) through `/usr/bin/sqlite3` with `PRAGMA query_only`, so it can't write.
  It doesn't use `-readonly`: the store is in WAL mode, and a read-only open fails when no other connection has the WAL files open.
- The card is `hp context <org_id>`. Dossiers come from a `grep` for `posthog_org_id:` across the accounts folder.
- The status line is the tail of `~/.config/hogpilot/distill.log`, watched with `watchFolder`.
- `mods/hogpilot/hog.svg`: a compass icon for a tab-bar button.
