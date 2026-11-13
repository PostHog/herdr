# Resume agents

Brings Claude Code back in its terminals after you restart or shut down your computer.

Herdr keeps your spaces, tabs and panes through a restart, but a terminal that was lost comes back as a plain shell: herdr-core never runs its program again.
This piece remembers which Claude Code session each terminal was running, and resumes it there with `claude --resume`.

## What you see

Nothing, until you restart.
The mod runs in a block of no size and draws nothing.
The `Pull-Requests`, `claude-usage` and `Dopamine-Squirrel` layouts in this repo carry that block as the last child of their root.
If you use one of them without enabling this piece, `herdr-app status` lists the mod as missing, and nothing else changes.
For another layout, clone it and add this block as the last child of its root:

```json
{ "id": "resume-agents", "type": "block", "content": { "mod": "resume-agents" }, "size": { "px": 0 } }
```

Use one such block per layout: two in the same layout would both type the resume command.

After a restart, when you open Herdr, each terminal that was running Claude Code gets this typed into its new shell:

```sh
cd '<the folder Claude Code started in>' && claude --resume <session id>
```

It lands in the shell's history, so you can see what ran.

## How it behaves

- Every 5 seconds, for each local terminal running Claude Code, it reads `~/.claude/sessions/<pid>.json`, which Claude Code writes for every running session.
  It keeps the session id, the folder and the terminal's shell pid as labels on the terminal (`resume-agents.claude.*`), so they survive a restart with the terminal.
  The session follows `/clear` and `/resume`.
- A labelled terminal whose shell pid changed was recovered by herdr-core, so the mod types the resume command into it, once.
- If you quit Claude Code and the shell stays open for 20 seconds, the labels go, and that terminal stays a shell after a restart.
  A shutdown ends everything faster than that, so it keeps the labels.
- It only runs while the Herdr window is open, in a layout that has its block.
  Switching to another layout stops it until you switch back.
- Terminals on other machines are skipped: their Claude Code sessions live on that machine.
- Claude Code only. Other agents come back as shells.

## Built from

- `mods/resume-agents/main.js`: a `View` that renders an empty `div()` and runs the sweep on a 5-second `cx.timer`.
- `terminals()` from the `herdr` module to find candidates, then `hc get`, `hc label` and `hc send` for the shell pid, the labels and the typed command.
- `mod.json`: `{ "place": "none" }`, so only a layout places it.
