# Dopamine Squirrel 🐿️

Jake Ruth's opinionated, ADHD-proof Herdr setup: one top bar and one panel for everything that pulls your attention. Built for a vertical monitor, fine on a wide one. Always growing; take the parts you like.

```sh
./install.sh enable dopamine-squirrel
```

## Top bar

![Top bar](screenshots/top-bar.gif)

Review count, a fact-check button (paste a Slack link or screenshot, Claude checks it before you hit send), one-click standup, and a slow neon glow (sped up here).

## Running agents · `cmd-1`

![Running agents](screenshots/agents.png)

Every agent with its cost, context %, and what it's running in the background (shells, monitors, helpers), grouped by tab. Helpers say whose they are. On top, your Claude plan limits (5h, week, Fable, credits) for each subscription.

## Reviews · `cmd-2`

![Reviews](screenshots/reviews.png)

PRs waiting on you. **DONE** hides one for good, **WATCH** hides it until it changes. **CC** opens Claude on the PR, or resumes your last review of it. Clear the queue for confetti.

A PR that asked you or your team stays here after you comment or request changes, until you approve it. It gets `↻ new commits` when the author pushes after your review.

Team review requests get an AI tag: **You care** or **Not important**. Click a tag to flip it, and expand the row to add a note on why. Before each tagging round, Opus rebuilds the rules from your base rules and all your feedback, then open PRs are tagged again. The header shows how many tags you've left unflipped. Base rules: `~/.config/herdr-app/review-triage.md` (copy `mods/squirrel-topbar/review-triage.md` to start). Learned rules: `~/.config/herdr-app/review-triage.learned.md`. Tagging runs `claude -p` with no tools on your default Claude login.

Below them, PRs that asked for you by name, or team PRs tagged You care, that merged without your review, to glance at and tick off.

## My PRs · `cmd-3`

![My PRs](screenshots/my-prs.gif)

Your open PRs in any repo, the Trunk merge queue, and what merged this week, with a visualizer for the wins. Click a row to read its comments.

## Keys

| | |
| --- | --- |
| `cmd-1` `cmd-2` `cmd-3` | Running agents, Reviews, My PRs |
| `cmd-b` | Show or hide the panel |
| `cmd-t` `cmd-shift-d` | New pane, straight into Claude; quit it to get a shell |
| `cmd-shift-t` | New tab |
| `cmd-r` | Rename a pane |
| `cmd-w` | Close a pane (asks first) |

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
| Visualizer | `mods/squirrel-panel/visualizer.js` |
| Confetti | `mods/squirrel-confetti/` |
| GitHub refresh error popup | `mods/squirrel-error/` |
| Reopen a closed Claude pane | `mods/squirrel-reopen/` |
| Pane headers, rename | `mods/squirrel-pane-header/`, `mods/squirrel-rename/` |
| Layout, keys | `layouts/Dopamine-Squirrel.json`, `keys.json` |

What changes colour, since screenshots can't show it:
- Status chips: green when approved or passing, yellow when waiting or running, red when failing or changes are requested.
- Context % and plan limit bars: green, yellow from 50%, red from 80%.
- WAITING turns red after 48 hours. Clicked PR links turn purple.
- A WATCH PR that comes back gets an amber edge and a `↻` tag.
- Remove turns red while waiting for its confirming click.
