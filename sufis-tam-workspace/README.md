# sufis-tam-workspace

Sufi's Herdr setup for TAM work: your book of accounts in the sidebar, with tasks and their Claude chats under each account, an account pane beside the chat, a book-wide Opportunities board, opp editing that writes to Salesforce, and a Share button on every Claude chat.

It's built on the account pane (PostHog/claude-code-account-pane, internal): that plugin's sync writes the JSON this setup reads. Without it you get the task tree and chats, but no account data.

## What you get

- **Accounts** (sidebar): one row per account where you're the TAM, from `~/work/accounts/roster.json` (falls back to the account pane's `book.json`).
  - Each account folds open into folders and tasks. A task holds Claude chats, saved as Claude sessions, so they come back after a restart.
  - Clicking a task goes to its running chat, else resumes its last one, else starts one in the account's folder. A new chat knows the task and account, and is told never to write to Salesforce, Customer Analytics or Slack unless you ask.
  - Dots: yellow, breathing (an agent is working on it), light red (waiting on you), blue (finished, or marked unread).
  - Hover for "+" (new task) and the archive toggle. Right-click for rename, pin, unread, delete and more. Ticking a task archives it. Each task shows its age (5m, 3h, 2d).
  - `cmd-k` searches accounts and tasks. `cmd-shift-n` opens New task.
- **Work** (sidebar, under Accounts): workspaces that aren't accounts, each a folder in `~/work` with its own tasks. "All accounts" is always there, for book-wide work. Its **Opportunities** folder opens a board of every open opp across your accounts.
- **Account pane**: on the right while a chat in an account has focus (the tab bar's Account Info button hides it). Clicking an account's name opens the same pane as a full-width Overview tab. Tabs: Overview, Spend, Opps, Signals, People, Notes.
- **Opportunities board**: columns for close date passed, closing in the next two weeks, next step past due, and later. A Renewals switch hides renewal opps.
- **Opp cards everywhere**:
  - Red: a close date that has passed, or a next step date that has passed.
  - Orange: a close date within 14 days, or a next step within 2 days.
  - Yellow: no amount, or exactly $100k (Salesforce's placeholder).
  - A pencil opens **Edit opportunity**: name, type, stage, probability, total credit, discount rate, close and next step dates (typed or picked from a calendar), and Next Steps (USE THIS ONE) with "+ Dated update".
  - Save sends only the fields you changed to Salesforce, through a background `claude -p` run that may use only the Salesforce update tool. It then updates the account's `opps.json` so the card changes before the next sync.
- **Share** (every Claude chat's header): pick a format (5-bullet summary, Slack message for your team or the customer, medium summary, full write-up) and where it goes (the chat, a Google Doc, a Customer Analytics note, a Slack draft). It types the ask into that chat and submits it. Slack is draft-only. The wording is in `mods/tam-pane/share.js`.

## Install

1. Install and set up the account pane plugin, so `~/accounts` or `~/work/accounts` has your accounts.
2. Put your accounts in `~/work/accounts`. If they're in `~/accounts`, move them and leave a link so the plugin's sync still finds them:

   ```sh
   mkdir -p ~/work/all-accounts
   mv ~/accounts ~/work/accounts && ln -s work/accounts ~/accounts
   ```

   Claude keeps sessions per folder, so chats started in the old folders won't resume from the new ones.
3. Enable the piece: `./install.sh enable sufis-tam-workspace`, then `herdr-app do layout.switch '{"name":"tam"}'`.
4. Merge `keys.json` (`cmd-shift-n`, `cmd-k`) into `~/.config/herdr-app/keys.json` by hand. `cmd-k` is free in Herdr's defaults, but check yours.
5. Write `~/.config/tam-herdr/config.json`. The links and Customer Analytics prompts need it, and it stays out of this repo:

   ```json
   {
     "posthog_project_url": "https://<posthog host>/project/<Customer Analytics project id>",
     "slack_url": "https://<workspace>.slack.com",
     "salesforce_url": "https://<org>.lightning.force.com",
     "work_spaces": [{ "name": "Side project", "folder": "side-project" }]
   }
   ```

   Ask anyone in CS for the values. Without them, the Customer Analytics, Slack and Salesforce links are left out, and everything else works. `work_spaces` adds folders under `~/work` to the Work section; create each folder first.

## Make it yours

- `mods/tam-pane/share.js`: the Share formats, destinations and their prompts.
- `mods/tam-account-pane/main.js`: `TEAM_SKILLS`, the team skills the pane's buttons run.
- `mods/tam-account-pane/opp-edit.js`: `TYPES` and the stage lists (`stagesFor`), which follow PostHog's Salesforce picklists.
- `mods/tam-accounts/main.js`: the system prompt every new chat gets (`startChat`).

## Worth knowing

- **Writes to Salesforce.** Edit opportunity's Save is the only part of this piece that writes anywhere outside your machine. It runs `claude -p` with `--allowedTools` set to `mcp__claude_ai_Salesforce_sobject-mutations__updateSobjectRecord` only, so it needs the claude.ai Salesforce connector. Field history: Salesforce keeps who changed Next Steps (USE THIS ONE) and when, but not the old text (it's a long text field). It doesn't track Next Step Date at all.
- **Share submits.** Picking a destination sends the ask into the chat (`hc send`), and the chat acts on it. The prompts ask for drafts only, and for the customer Slack format, to leave internal details out. Read the draft before you send it.
- The tab bar (`tam-tabs`) and top-left header (`tam-chrome`) are copies of Herdr's `tabs` and `workspace-chrome`. They won't pick up Herdr's later changes to those two mods.
- The sync's opp query needs Probability, Type, Total_Credit_Amount__c and Discount_Rate__c for the edit dialog to open with current values. Until the account pane plugin fetches those, they open blank, and Save only sends what you fill in.
