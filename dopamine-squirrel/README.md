# Dopamine Squirrel 🐿️

Jake Ruth's opinionated, ADHD-proof Herdr setup: one top bar and one panel for everything that pulls your attention. Built for a vertical monitor, fine on a wide one. Always growing; take the parts you like.

```sh
./install.sh enable dopamine-squirrel
```

## Top bar

![Top bar](screenshots/top-bar.gif)

Review count, a fact-check button (paste a Slack link or screenshot, Claude checks it before you hit send), one-click standup, and a slow neon glow (sped up here).

A bell for reminders: `cmd-shift-r`, type "monday 8am review the deploy PR" and Claude reads the time and task. Tick "Use this conversation" and it pulls what the task needs from the Claude pane you're in. Nothing saves until you confirm. When one comes due you get a toast and a Mac notification, and Start opens Claude with the task typed in. Reminders are in `data/squirrel/reminders.json`, so a force quit can't lose them.

## Pane headers

Each Claude pane shows its account's dragon, model and effort. Click the dragon to move that conversation to your other account, same history. A collapsed pane with a reply you haven't opened gets a glowing Unread chip. Work Claude left running in the background shows as quiet text ("1 shell in background"), so the spinner only means it's replying.

## Running agents · `cmd-1`

![Running agents](screenshots/agents.png)

Every agent with its cost, context %, and what it's running in the background (shells, monitors, helpers), grouped by tab. Helpers say whose they are. On top, your Claude plan limits (5h, week, Fable, credits) for each subscription.

## Devboxes · `cmd-2`

Your PostHog devboxes: running or stopped, when each auto-stops, which folder is synced to it and which panes work in that folder, with Stop and Start. Needs `hogli devbox:setup`.

## Reviews · `cmd-3`

![Reviews](screenshots/reviews.png)

PRs waiting on you. **DONE** hides one for good, **WATCH** hides it until it changes. **CC** opens Claude on the PR, or resumes your last review of it. Clear the queue for confetti.

A PR that asked you or your team stays here after you comment or request changes, until you approve it. It gets `↻ new commits` when the author pushes after your review.

Team review requests get an AI tag: **You care** or **Not important**. Click a tag to flip it, and expand the row to add a note on why. Before each tagging round, Opus rebuilds the rules from your base rules and all your feedback, then open PRs are tagged again. The header shows how many tags you've left unflipped. Base rules: `~/.config/herdr-app/review-triage.md` (copy `mods/squirrel-topbar/review-triage.md` to start). Learned rules: `~/.config/herdr-app/review-triage.learned.md`. Tagging runs `claude -p` with no tools on your default Claude login.

Below them, PRs that asked for you by name, or team PRs tagged You care, that merged without your review, to glance at and tick off.

## My PRs · `cmd-4`

![My PRs](screenshots/my-prs.gif)

Your open PRs in any repo, the Trunk merge queue, and what merged this week, with a visualizer for the wins. Click a row to read its comments.

## Keys

| | |
| --- | --- |
| `cmd-1` `cmd-2` `cmd-3` `cmd-4` | Running agents, Devboxes, Reviews, My PRs |
| `cmd-b` | Show or hide the panel |
| `cmd-t` `cmd-shift-d` | New pane, straight into Claude on the account you pick (1, 2, Enter for the last); quit it to get a shell |
| `cmd-shift-t` | New tab |
| `cmd-r` | Rename a pane |
| `cmd-w` | Close a pane (asks first) |
| `cmd-a` | The selected pane fills its column; the others shrink to their header |
| `cmd-s` / `cmd-shift-s` | Only the panes above / below shrink; the selected pane takes their space |
| `cmd-shift-a` | Open panes (and the selected one) get equal heights |
| Same key within 5 s | Undo the last of those four |
| `cmd-shift-r` | Add a reminder in plain words |
| `cmd-alt-r` | Show reminders (the bell) |

## Heads up: some of this is Jake's

These assume Jake's setup. Change them in `~/.config/herdr-app/squirrel.json`, or skip them.

- **Standup button:** Jake's `standup` skill from the PostHog MCP, in his second Claude subscription.
- **CC review button:** Jake's `explaining-prs` skill from the PostHog MCP.
- **Merge queue:** PostHog's Trunk queue and a `PostHog/posthog` checkout.
- **Plan limits:** Jake's two Claude subscriptions.
- **Cloud-task PRs in My PRs:** PostHog cloud tasks, read with your `posthog-cli login`.

---

## For agents

Setting this up or taking a part of it? [RECIPE.md](RECIPE.md) has setup, every setting, the Claude statusline and how the pieces talk to each other.

| Part | Files |
| --- | --- |
| Top bar | `mods/squirrel-topbar/main.js` |
| GitHub fetching (every 5 min, all repos) | `mods/squirrel-topbar/github.js` |
| PRs from PostHog cloud tasks | `mods/squirrel-topbar/cloud.js` |
| Neon glow | `mods/squirrel-topbar/glow.js` |
| Agent cards, context %, cost | `mods/squirrel-panel/agents.js`, `statusline.sh` |
| Plan limits (`/usage` every 3 min) | `mods/squirrel-panel/usage.js` |
| Reviews, triage, CC button | `mods/squirrel-panel/reviews.js`, `table.js` |
| AI review tags | `mods/squirrel-topbar/triage-ai.js`, `review-triage.md` |
| My PRs, merge queue | `mods/squirrel-panel/my-prs.js` |
| Devboxes | `mods/squirrel-panel/devboxes.js`, `mods/squirrel-topbar/devboxes.js` |
| Visualizer | `mods/squirrel-panel/visualizer.js` |
| Confetti | `mods/squirrel-confetti/` |
| GitHub refresh error popup | `mods/squirrel-error/` |
| Reopen a closed Claude pane | `mods/squirrel-reopen/` |
| Pick the Claude account for a new pane | `mods/squirrel-account/`, `mods/squirrel-dragon/` |
| Pane headers, rename | `mods/squirrel-pane-header/`, `mods/squirrel-rename/` |
| Pane resize keys | `mods/squirrel-topbar/fit.js` |
| Move a conversation to the other account (click the dragon) | `mods/squirrel-topbar/switch.js` |
| Reminders: add, bell, firing, Mac notifications | `mods/squirrel-remind/`, `mods/squirrel-reminders/`, `mods/squirrel-topbar/reminders.js`, `reminders.py`, `recent-talk.py`, `com.squirrel.reminders.plist` |
| Layout, keys | `layouts/Dopamine-Squirrel.json`, `keys.json` |

What changes colour, since screenshots can't show it:
- Status chips: green when approved or passing, yellow when waiting or running, red when failing or changes are requested.
- Context % and plan limit bars: green, yellow from 50%, red from 80%.
- WAITING turns red after 48 hours. Clicked PR links turn purple.
- A WATCH PR that comes back gets an amber edge and a `↻` tag.
- Remove turns red while waiting for its confirming click.
