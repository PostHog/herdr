# TAM workspace

A Herdr layout for TAMs where accounts, their tasks and each task's Claude chats live in the sidebar, the focused account's data sits beside the chat, and every open opp across the book is one click away and editable in place.
There's no preview.png: every screen of it shows customer names. `layouts/tam.svg` sketches the layout.

## What you see

- **Left sidebar** (268px column, dividers 1px `border`, each section resizable and scrolling on its own):
  - `brand` (46px): `tam-chrome`, Herdr's top-left header without the logo or title: search and sidebar toggle.
  - `accounts` (weight 2): `tam-accounts`. "Accounts (N)" header with a search button, then one collapsible row per account.
    Under an account: its folders (folder icon), then tasks. A task row is: age (`5m`, `3h`, `2d`, `1w`, `1M`, at least 24px wide, never wrapping), checkbox (a pin when pinned), title, status dot.
    The task that's showing lists its running chats beneath it, lined up with its checkbox.
  - `work-section` (weight 1): a second `tam-accounts` with props `{section: "work"}`. "Work" header, then "All accounts" (with its Opportunities folder) and any workspaces from the config.
  - `spaces` and `agents` (weight 1 each): Herdr's own.
  - `sidebar-footer` (69px): `workspace-chrome` with `{footer: true}`.
- **Right side**, top to bottom:
  - `tabs` (42px): `tam-tabs`, Herdr's tab bar plus an "Account Info" button between + and Files, shown only while an account chat is focused.
  - `work-body` row: the active tab (panes framed, header mod `tam-pane`), Herdr's Files/Changes `panel` (368px, hidden), and `account-panel` (340px, hidden until an account chat is focused): `tam-account-pane`.
  - `status` (28px): `workspace-status`.
- **Account pane**: the account's name and links (Customer Analytics, Stripe, Slack, Salesforce, Metabase, Admin, Billing admin), then tabs Overview, Spend, Opps, Signals, People, Notes.
  As a full-width Overview tab ("Account · Overview"), the links and team sit beside the name, the Overview lays out opportunities and signals | spend | people in three columns (two or one when narrower), and the other tabs split into one to three columns by width.
- **Opportunities board** ("Opportunities · Overview"): a header with the opp count and total, the accounts with no opps synced, a Renewals switch and the sync status. Then compact cards in columns: close date passed (only when any) | closing in the next two weeks | next step past due | later. One column per group at 300px or more each, else they wrap.
- **Opp card**: name (a Salesforce link) with a pencil on the right; stage, amount, close date; next step date and the next step.
  Close date: `#c0392b` if passed, `#f07c2b` within 14 days. Next step date: `#c0392b` if passed, `#f07c2b` within 2 days. Amount: `#e8b422` when missing, 0 or exactly 100000.

## How it behaves

- **Task dots**, from the agents in the task's chats: working `#e8b422` breathing, blocked `#f28b82`, done or unread `#4c8df6`. Done clears once you look at the chat. Folded accounts and folders show one dot per task inside.
- **Clicks**:
  - An account's name opens its Overview tab (one tab, reused and renamed). Its chevron folds it.
  - A task goes to its blocked chat, else its running one, else resumes its last chat (`claude --resume`), else starts one.
  - A chat row goes to the chat, or reopens it when closed (dim).
  - "All accounts" opens a placeholder Overview. Its Opportunities folder opens the board (its chevron folds it). Other workspaces fold when clicked.
- **Hover**: "+" (new task, or a new chat on a task) and an archive icon that shows or hides archived tasks (or closed chats) there. Hidden by default, remembered per folder.
- **Right-click**: the account, folder, task or chat menu (new task or folder, rename, pin, unread, go to agent, show in Finder, open in Customer Analytics, delete with confirmation, remove a chat from its task).
- **Keys** (`keys.json`): `cmd-shift-n` → `tam-accounts.new-task` (New task dialog, account list open), `cmd-k` → `tam-accounts.search`. `herdr-app do tam-accounts.opps` opens the board.
- **New chat**: a tab "Account · chat name" in `~/work/accounts/<folder>`, running `claude --session-id <uuid> --append-system-prompt <context>` after `hc label <t> tam.task=… tam.account=… tam.chat=<session>`. A task's first chat gets the task's title pasted into its input (not sent).
- **Account pane visibility**: `tam-accounts` checks every 300ms. It shows `account-panel` while the focused terminal is labelled with an account, or sits in an account's folder, unless `shared("account.panel") === false`, which the Account Info button toggles.
- **Pane buttons**: Draft, the team-skill buttons and Sync now paste their prompt into the focused chat without sending it (clipboard, restored after a second). From an Overview tab, they open a new chat instead: in the account's folder, or `~/work/all-accounts` from the board.
- **Edit opportunity** (a 520px dialog): Save is disabled until something changes and every field is valid (dates `YYYY-MM-DD`, percentages 0–100, amounts ≥ 0). It then runs `claude -p` (Haiku, `--allowedTools` the Salesforce update tool only, `--no-session-persistence`, 2-minute timeout). On "OK" it patches the row in `opps.json` and closes. Otherwise it shows Salesforce's error.
- **Share** popup (250px): five formats (the last one picked is remembered) and four destinations. Picking a destination runs `hc send <terminal> <prompt>` detached, focuses the pane and closes.

## Built from

- `layouts/tam.json`: a clone of Herdr's `main` (0.1.16), with `titlebar: none`, `traffic_lights: [12, 16]` and the tree above.
- `mods/tam-accounts`: both sidebar sections, its own menus (`props.menu`) and dialogs (`props.dialog`).
  - Reads `~/work/accounts/roster.json` (`accounts: [{name, folder, account_id, org_id}]`), else `book.json`.
  - Reads and writes `<folder>/tasks.json` (`{folders, tasks, archive}`, each task `{id, title, created_at, pinned?, unread?, chats: [{session, name, cwd?}]}`), retrying once if it changed underneath.
  - `watchFolder` on each root, `terminals()` labels, `agents()`, `nextCommand()`, `setShared("work.folders")`, `run("tab.new" | "tab.select" | "tab.rename" | "layout.show" | "layout.hide" | "pane.focus" | "terminal.paste")`.
- `mods/tam-account-pane`: the pane, the Overview tab (`props.folder`), the board (`props.folder: "all-accounts:opportunities"`) and the edit dialog (`props.editOpp`, `opp-edit.js`).
  - Reads `account.json`, `opps.json`, `spend.json`, `signals.json`, `people.json`, `scouts.json` and `ca-notes.json` from each account folder, and `.sync/status.json`.
  - Writes only `quicknote.md`, `signal-state.json` and, after a save, `opps.json`.
- `mods/tam-pane`: a clone of Herdr's `pane` header, with the Share button and popup (`props.share`, `share.js`).
- `mods/tam-tabs`, `mods/tam-chrome`: clones of `tabs` and `workspace-chrome`.
- Shipped mods used: `spaces`, `agents`, `files`, `changes`, `workspace-chrome`, `workspace-status`, `menu`, `new-menu`, and icons from `workspace-chrome` and `pane`.
- Programs: `claude`, `hc` (`~/.local/bin/hc`), `pbcopy`/`pbpaste`, `open`.
- `~/.config/tam-herdr/config.json`: `posthog_project_url`, `slack_url`, `salesforce_url`, `work_spaces`.

## Watch out

- `props()` read after an `await` can belong to another copy of the mod. The edit dialog keeps its overlay id from `init`.
- Salesforce answers a successful update with an empty body (`{"value":""}`). Tell the headless run that's success, or it reports an error.
- The update tool is deferred in headless Claude: the prompt has to load it with ToolSearch first.
- A tab's folder must exist, or `tab.new` fails with "cannot start /bin/zsh". The board isn't an account folder.
- `columns()` returns an array: spread it into `.children` or `.child(...)` throws.
- Claude keeps sessions per folder, so a chat records its `cwd` and resumes there.
- macOS only as written (`pbcopy`, `open`, `traffic_lights`).

## Done when

- `herdr-app check` passes for all five mods, and `layout.switch {name: "tam"}` shows both sidebar sections.
- Focusing a chat started from an account's task shows the account pane, and Account Info hides it.
- Clicking All accounts › Opportunities shows the board, and the Renewals switch changes the counts.
- An opp's pencil opens the dialog. Changing one field reads "1 change to save to Salesforce", and Save closes it after the update.
- Share › Bullet summary › Here in the chat submits the ask in that chat.
