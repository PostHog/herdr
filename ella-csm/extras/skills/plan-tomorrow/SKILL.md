---
name: plan-tomorrow
description: Turn Ella's to-do list (photo, screenshot or typed) into task prompts that the morning launcher opens as separate Claude Code sessions at 7:30 the next working day. Use when she says "plan tomorrow", shares her to-do list for tomorrow, or asks to queue tasks for the morning.
---

# Plan tomorrow

Ella shares her to-do list in the evening. You turn each item into a self-contained prompt, she approves, and you write one file per task. At 7:30 on weekdays `~/morning-launch/launch.sh` (launchd job `com.ella-csm.morning-launch`) opens a Herdr space for the day ("morning · mon 16 nov") with a "today" checklist tab and one tab per file, each running `claude --permission-mode auto` with the prompt plus `~/morning-launch/preamble.md` (unattended, draft-only rules). Each session ticks itself off on the checklist by writing `NN-<slug>.done.md` (its handover) next to its prompt file; `run-task.sh` tells it the path. You don't need to repeat the preamble's rules in each prompt.

Her Herdr to-do list lives in `~/morning-launch/todo.md` (markdown checklist; open items are `- [ ]`). When she runs this skill, read it first and offer its open items alongside whatever she shares, so nothing on it gets forgotten. Don't tick or remove items yourself; she ticks them in Herdr. When you add an item that came from a Slack message (an alert, a scout post, someone's ask), end its line with the message permalink as `<!-- slack:https://posthog.slack.com/archives/… -->` so the Herdr panel shows a "slack ↗" button; keep that comment on any line you rewrite.

## Steps

1. Read the list. If it's a photo, transcribe it and show her the transcription with anything you couldn't read marked, so a misread doesn't become a wasted session.
2. Work out the target day: the next weekday (Friday evening → Monday). If she names a day, use that.
3. For each item that needs Claude, write a prompt. Skip items that are purely hers (a call, a personal errand) and say which you skipped.
   - If it names a book account, run `hp id <name>` to confirm the account and include the org_id in the prompt.
   - Say what "done" looks like and where the output goes: a CA note on the account, a Superhuman or Slack draft, a local file, an artifact on artifacts.posthog.com (private).
   - Point at the relevant skill or memory when one exists (e.g. billing credits → the billing-credits lookup in memory; post-call work → customer-call-pack).
   - Keep the scope to what she wrote. If an item is ambiguous, ask her rather than guessing.
   - Note anything that will need her in the morning, e.g. a Metabase login (`hogli metabase:login` is user-only), so she knows which tabs will be waiting.
4. Show her the prompts as a short numbered list (title + one or two sentences of what the session will do) and wait for her to approve or edit them.
5. On approval, write `~/morning-launch/tasks/<YYYY-MM-DD>/NN-<slug>.md`, one per task. The first line of each file is `# <Short title>`, which becomes the Herdr tab, checklist row and session name. Keep titles short (account + task, e.g. `# Wonka credits`).
6. Confirm in one line: how many tasks, which day, and that she can run `~/morning-launch/launch.sh <date> --force` to start them by hand.

## Notes

- Never write to a date folder that already has a `.launched` marker without telling her; that day has already run.
- She can add a task later by asking you to add one to tomorrow's folder.
- Logs are in `~/morning-launch/logs/<date>.log`.
