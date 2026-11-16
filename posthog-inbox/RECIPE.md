# PostHog inbox

The PostHog self-driving inbox in Herdr's sidebar, with tasks in their own git worktrees.
Herdr's main layout, with the agents list replaced by two lists: Tasks, the work you picked up or started, each with its agent, git and pull-request state, and Inbox, the PostHog reports waiting for you.
A report is read in a pane, started locally (a worktree, a space and an agent), handed to a PostHog cloud task, or sorted by keyboard in a triage round.

## What you see

- The left sidebar, 300 px wide, in the `chrome` color: the brand bar (46 px), the spaces list (weight 1), this mod (weight 3), the footer (69 px). The rest of the window is Herdr's main layout unchanged.
- **Tasks**, a 31 px header in 11.5 px `dim` text with a `+` button (New task). With no tasks it says "Pick up a report below, or start a task with +."
  - A task is a 46 px row with 8 px corners. Line one is the agent's status mark and the title. Line two, 11.5 px `dim`, is `repo · branch` (or "cloud task") on the left and tokens on the right:
    `no worktree` (`blocked`), `±3` uncommitted files (`ansi3`), `↑2` unpushed commits (`ansi2`), `☁ in progress` for a cloud run (`working` while queued or in progress, `blocked` when failed), `#123` with ` draft`, ` merged` or ` closed`, then `conflict`, `✗2` failing checks, `…` pending or `✓` passed, `appr` or `changes`.
  - The status mark is drawn as Herdr's agents list draws it: a spinner (working), a `!` tile (blocked), a filled dot (done), a ring (idle), a dash when the task has no space. A task with no worktree shows `☁`.
  - The task whose space is shown has the `selected` background.
  - A report being started shows above the tasks as a row with a spinner and its current step ("Creating the worktree…"). A failed one shows a `!`, the error in `blocked`, and goes on a click.
  - "Archived (n)" folds open to the last 20 archived tasks, 26 px rows in `dim`.
- **Inbox**, a header that says "Inbox · 25 of 61" or "Inbox · 12", how long ago it loaded ("4m", or "Refreshing…"), a triage button and a refresh button.
  - A report is a 46 px row. Line one is a priority tile (22 by 16 px: P0 `ansi1`, P1 `ansi3`, P2 `ansi4`, else `dim`, on the same color at 15%) and the title. Line two is PostHog's reason it's yours (else the summary), then its state ("starting…", "in Tasks", `#123`, "yours", "claimed", "needs input"), then its age ("now", "12m", "3h", "2d").
  - The report shown in the pane has the `selected` background. A report with a task has a `muted` title.
  - "Show 25 more" loads the next page.
  - Instead of rows it says what's missing: "Add a PostHog personal API key to connect your inbox:" and the config path, the error in `blocked`, "Loading…", or "Nothing is waiting for you."
    When a refresh fails with a list already there, the list stays under "Showing the list from 4m ago." and the error.
  - "No personal ranking yet: PostHog's recommended order." shows when PostHog ranked the list without your personal ranking.
- Under 160 px wide the sidebar is a rail: one 32 by 26 px cell per task with its status mark, then the inbox count. A click on the count widens the sidebar to 300 px.
- **The report pane**, a tab named "Inbox": a header with the priority tile, the title (16 px semibold), a tag on its right that says who holds it ("Claimed by you" in `accent`, "Claimed by <name>" in `ansi3`, "Unclaimed" in `dim`, each on its color at 15%), a facts line (status, work state, repository, scout, "14 signals", "updated 3h"), PostHog's reason, and buttons: "Start locally" (or "Go to task" when its task has a space), "Start in cloud", "Open in PostHog".
  Below, selectable markdown up to 820 px wide: the summary, "Suggested next steps", "Pull requests", and the "Work log".
- **Dialogs**, in the `popover` color with 18 px padding: a title with "Esc" on the right, a scrolling body, then a status line and buttons.
  - Start locally (540 by 520): the checkout path with Browse…, "Pull request #n" or "A new branch" when the report has an open pull request, the branch, the agent, and "Claim the report" or "Don't claim".
  - Start in cloud (580 by 560): the report's actions, each with a Run button and its reason when it can't run, then "Or ask" with a text area. It says "Each run is a PostHog cloud task, billed to your organization."
  - New task (540 by 660): title, instructions, repository (the configured ones and Browse…), "Locally, in a worktree" or "In PostHog's cloud", then branch and agent for a local one.
  - Archive task and Open a draft pull request (480 by 300): each line says what will happen, and what would be lost in `blocked`.
- **Menus**, 230 px popups of 28 px rows, on a right-click. A task's: go to its space, read the report, open the report, the cloud task or the pull request, "Open a draft pull request…", "Archive…". A report's: read, "Start now", "Start locally…", "Start in cloud…", "Claim" or "Release my claim", "Dismiss…", "Snooze until it recurs", "Not mine…", "Open in PostHog".
- **Triage** (1100 by 720): a 40 px top bar with "Triage", three filters with counts (All, Claimed by me, Suggested to me), "3 of 41", and a count per kind of mark. A 310 px list of 30 px rows on the left (mark glyph, priority, title, "yours"), the chosen report's card on the right, and a footer of key hints that also work as buttons.

## How it behaves

- **The inbox** is `inbox-reports-list` with `view: "for_you"`, `sort: "personal"`, 25 at a time. It loads when the sidebar starts, every 5 minutes, and on the refresh button. The last list is kept in `localStorage`, so the rows are there before the first reply. Later pages pass the first page's `ranking_id` to stay in its order.
- A second list (`assignee: "mine"`, open statuses) gives the reports you claimed, kept in shared state for every view.
- **A click on a report** shows it in the "Inbox" tab of the space you're in, or makes that tab. The pane retrieves the report, then its work log (`inbox-report-artefacts-list`, 100 entries). The entries `ranking_score`, `reviewer_corrections` and `safety_judgment` are left out.
- **Start locally** and **Start now**:
  1. Finds the repository's main checkout, its GitHub `owner/name` and its base branch (`origin/HEAD`, else `origin/main`, else `origin/master`), and fetches the base.
  2. Adds a worktree at `~/.herdr/worktrees/<repo>/<branch slug>` on a new branch `inbox/<title slug>` (`task/<title slug>` for a task from scratch), made with `--no-track`. For a report with an open pull request it makes `pr-<number>` and runs `gh pr checkout`.
  3. Claims the report (`inbox-reports-claim`), unless someone else holds it or you chose "Don't claim". A failed claim is a warning, and the task still starts.
  4. Opens a space in the worktree with the agent, the prompt as its first message. For a report, the prompt names the report, tells the agent to read the work log and verify the diagnosis against the code before changing anything, then to implement and commit on the branch.
  - "Start now" uses the defaults with no dialog: the report's repository from `repos` (else `default_repo`), the configured agent, and the report's open pull request when it has one. The space you were in stays shown.
- **Start in cloud** runs one of the report's actions (`inbox-report-actions-run`) or "ask" with your message (2000 characters at most). A cloud task from scratch is `tasks-create-and-run`. Both become a task row with `☁`.
- **Tasks stay live.** Every 5 s, while the window is active, the sidebar checks the tasks that are due, one at a time: git status every 30 s, the pull request (`gh pr view`) every 90 s until it's merged, the cloud run (`tasks-retrieve`) every 60 s until it's completed, failed or cancelled.
- **A pull request found on a task's branch** is attached to the report once, when this task claimed it. A cloud run's pull request is kept on the task. When it merges, a notification says "Pull request merged".
- **A click on a task** shows its space, on the tab its terminal is in. With no space it opens one in the worktree, else the cloud task, else the pull request.
- **Open a draft pull request** pushes the branch and runs `gh pr create --draft`, with the report's URL as the body. It's refused with uncommitted changes or no commits.
- **Archive** closes the task's space, removes the worktree (the branch stays), and releases your claim when nothing was merged and the report isn't resolved. With uncommitted changes the button says "Discard and archive" and the removal is forced.
- **Dismiss** asks why: Already fixed, No action needed (the report becomes resolved), Analysis is wrong, Unclear, Intentional behaviour, Not relevant (suppressed). It warns when that closes an open pull request. **Snooze** sets the report back to `potential`. **Not mine** asks why (Not my area, Someone else is on it, No bandwidth) and takes you off its reviewers.
- **Jobs.** A menu or a triage round closes before its work ends, so start, claim, release, dismiss, snooze and leave are queued in shared state, and the sidebar does them one at a time. The report's row says "starting…" meanwhile. A job older than 15 minutes is dropped, not done late.
- **Triage** goes through the inbox plus your claims, without the reports already in Tasks.
  - `j`, `k`, the arrows and space move. `tab` changes the filter. `o` opens PostHog. `esc` closes.
  - `s` starts the report now and `c` claims it or releases your claim. Both happen at once, as jobs.
  - `d`, `z` and `n` only mark the report (dismiss and not mine ask for a reason with `1` to `6`). The same key again takes the mark off.
  - `enter` shows the marks for review, and `enter` again applies them to PostHog one by one. Then it says how many were applied and lists what failed.
  - Marks are kept in shared state, so a round can be left and resumed.
- Every PostHog write follows a click or a key.

## Built from

- `layouts/inbox.json`: Herdr's `main` layout with the sidebar at 300 px and `sidebar-lists` holding `spaces` (weight 1, min 90) and `{ "mod": "ph-inbox" }` (weight 3, min 120) where the agents list was. `layouts/inbox.svg` is its preview.
- `mods/ph-inbox/`, with `mod.json` `{ "place": "none", "title": "Inbox" }`, so only a layout, a tab or an overlay places it. `main.js` picks the view from `props().view`:
  - none: the sidebar (`sidebar.js`).
  - `report`: the pane (`report.js`). `{ id }` pins it to one report.
  - `pickup`, `cloud`, `new`, `action`, `menu`, `report-menu`: the dialogs and menus (`dialogs.js`).
  - `triage`: the round (`triage.js`).
  - `flows.js` has what the buttons do and the jobs, `git.js` the worktrees and pull requests, `store.js` the task records, `ui.js` the shared drawn parts, `ph.js` the PostHog calls and the config.
- `phmcp.py`: an MCP client in Python's standard library, run as `python3 phmcp.py call <tool> <json>`. It speaks streamable HTTP to `https://mcp.posthog.com/mcp` (`url` in the config changes it), calls the tool directly when the server lists it and through the server's `exec` tool when it doesn't, and remembers which in `~/.config/posthog-inbox/cache.json`. It prints JSON, with `{"error", "code"}` and exit 1 on failure.
- `~/.config/posthog-inbox/config.json` (mode 600): `api_key`, `default_repo`, `repos`, `agent`. Only `phmcp.py` reads the key (or `POSTHOG_PERSONAL_API_KEY`). The mod reads the rest.
- PostHog MCP tools: `inbox-reports-list`, `inbox-reports-retrieve`, `inbox-report-artefacts-list`, `inbox-reports-claim`, `inbox-reports-set-state`, `inbox-reports-leave-reviewers`, `inbox-report-actions-list`, `inbox-report-actions-run`, `tasks-create-and-run`, `tasks-retrieve`.
- Shared state: `ph-inbox.tasks` (the task records, with only what can't be read back live), `ph-inbox.report` (the report the pane shows), `ph-inbox.mine` (the reports you claimed), `ph-inbox.jobs`, `ph-inbox.triage` (the marks).
- `herdr` functions: `exec`, `appHome`, `home`, `readTextFile`, `props`, `theme`, `layout`, `window`, `spaces`, `panes`, `focused`, `shared`, `setShared`, `openOverlay`, `closeOverlay`, `notify`, `knownAgents`, `pickFolder`, `nextCommand`, and `run` with `space.new`, `space.select`, `space.close`, `tab.new`, `tab.select`, `layout.resize`.
- Commands it answers: `ph-inbox.new`, `ph-inbox.triage`, `ph-inbox.refresh`.
- Programs: `python3`, `git`, `gh`.
- Art: `refresh.svg` in the mod, and `plus`, `layers`, `spinner`, `chevron-down` and `chevron-right` from the shipped `workspace-chrome` mod.

## Watch out

- The mod reaches the network (PostHog's MCP server, with your personal API key), runs programs (`python3`, `git`, `gh`) and reads `~/.config/posthog-inbox/config.json`, which is outside its folder.
- The key never goes on a command line: `phmcp.py` reads it from the config or the environment.
- A mod reads its layout or overlay props with `props()` from `herdr`. `init`'s first argument is not them.
- A loop on `nextCommand()` must touch `cx` before acting. Otherwise a loop left over from an older build of the mod acts too.
- Each copy of the mod (the sidebar, a pane, a dialog) has its own `localStorage`. What they share goes through `shared` and `setShared`.
- Work that must outlive a popup can't run in it: the popup closes and its task ends. That's what the jobs are for.
- The new branch needs `--no-track`, or its first push goes to the base branch.
- Git reads for the status use `--no-optional-locks -c core.fsmonitor=false`, so a poll every 30 s neither takes the index lock nor wakes a folder watch.
- A report that names its repository starts there or not at all: without a checkout for it in `repos`, "Start now" fails and says so.
- A report's row still names you as the assignee right after a release. Triage remembers which reports were yours so it doesn't say you hold them.
- Dismissing a report closes its open pull request. Both places that dismiss say so first.
- Archive releases a claim only when the claim is still this task's and nothing landed.
- Cloud runs are billed to your organization. Both dialogs that start one say so.
- `herdr-app check` only renders the sidebar. Show another view as a tab to look at it: `herdr-app do tab.new --mod ph-inbox --props '{"view":"new"}'`.
- It assumes `origin` is the GitHub remote, and Unix paths, so it doesn't run on Windows.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/ph-inbox` passes.
- `python3 ~/.config/herdr-app/mods/ph-inbox/phmcp.py check` prints `{"ok": true, ...}` with the number of tools.
- With no key, the Inbox says "Add a PostHog personal API key to connect your inbox:" and the config path.
- With a key, the Inbox lists your reports, and a click on one shows it in the "Inbox" tab with its work log.
- "Start now" on a report makes a worktree under `~/.herdr/worktrees/`, a space in it with the agent working from the report's prompt, and a task row. In PostHog the report is claimed by you.
- After the agent commits and "Open a draft pull request…" runs, the task row shows the pull request's number and the report lists the pull request.
- Archive removes the worktree and the space, keeps the branch, and releases the claim when nothing was merged.
- In triage, `d` then `1` marks a report, `enter` twice applies it, and the report is gone from the inbox.
