// Turn notes: a short Haiku note for each finished turn of the focused Claude Code terminal,
// newest first. Notes are cached per session in data/turn-notes/, so each is made once.

import { View, div } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { appHome, exec, focused, hc, home, readTextFile, theme, writeTextFile } from "herdr";

const NOTE_DIR = () => appHome() + "/data/turn-notes";
// Notes for older turns aren't made, so opening a long session doesn't fire dozens of calls.
const MAX_TURNS = 20;
const SYSTEM =
  "You index turns of a chat between a person and a coding agent, for notes beside the chat. Reply with only " +
  'one line of JSON: {"label": "...", "points": ["...", "..."]}. label: 2-5 words naming what the turn did or settled, like ' +
  '"Trimmed PR body" or "Toolbar build 60% faster". points: 1-3 terse fragments (at most 6 words each) with the key facts: ' +
  "numbers, files, decisions, what is still open. Points are markdown: **bold** the key number or outcome, `code` for files, " +
  "branches and commands. Sentence case, no trailing periods.";
// No settings, hooks, MCP servers or session file: a one-line job shouldn't pay for them or show up in history.
const ISOLATE = ["--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--tools", ""];

export default class TurnNotes extends View {
  init(_props, cx) {
    this.terminal = null;
    this.session = null;
    this.turns = [];
    this.busy = false;
    this.notes = {};
    this.failed = new Set();
    this.making = false;
    cx.timer.every(4000, (cx) => this.load(cx));
  }

  load(cx) {
    const address = this.terminal;
    if (!address || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        // Look the process up each time: Claude may start after the terminal, or be restarted in it.
        const g = await hc(["get", address, "--json"]).catch(() => null);
        let pid = "";
        try { pid = String(JSON.parse(g.stdout).foreground?.pid || ""); } catch {}
        const r = pid ? await exec("/usr/bin/python3", ["-I", `${appHome()}/mods/turn-notes/turns.py`, pid]) : null;
        const d = r?.code === 0 ? JSON.parse(r.stdout || "{}") : {};
        if (address !== this.terminal) return;
        if (d.session !== this.session) {
          this.session = d.session || null;
          this.notes = {};
          this.failed = new Set();
          if (this.session) {
            try { this.notes = JSON.parse(await readTextFile(`${NOTE_DIR()}/${this.session}.json`)) || {}; } catch {}
          }
        }
        this.turns = d.turns || [];
        this.busy = Boolean(d.busy);
        this.next(cx);
        cx.notify();
      } finally {
        this.loading = false;
      }
    });
  }

  // Finished turns, newest first. While Claude works, the last turn isn't finished.
  done() {
    const turns = this.busy ? this.turns.slice(0, -1) : this.turns;
    return turns.slice(-MAX_TURNS).reverse();
  }

  // One note at a time, newest turn first.
  next(cx) {
    if (this.making || !this.session) return;
    const turn = this.done().find((x) => !this.notes[x.key] && !this.failed.has(x.key));
    if (!turn) return;
    this.making = true;
    const session = this.session;
    cx.spawn(async (cx) => {
      let note = null;
      try {
        const input = "Person: " + turn.user + "\n\n" + turn.said;
        const r = await exec("claude", ["-p", "--model", "haiku", ...ISOLATE, "--system-prompt", SYSTEM, input],
          { cwd: home(), timeout: 60000 });
        const m = r.code === 0 && (r.stdout || "").match(/\{[\s\S]*\}/);
        const v = m && JSON.parse(m[0]);
        const clean = (x) => String(x || "").trim().replace(/\.$/, "");
        if (v?.label) note = { label: clean(v.label), points: (Array.isArray(v.points) ? v.points : []).map(clean).filter(Boolean).slice(0, 3) };
      } catch {}
      this.making = false;
      if (session !== this.session) return;
      // A failed turn waits until the session changes, rather than retrying every few seconds.
      if (!note) this.failed.add(turn.key);
      else {
        this.notes = { ...this.notes, [turn.key]: note };
        await this.save(session);
      }
      cx.notify();
      this.next(cx);
    });
  }

  // Two copies may write notes for the same session: merge with what's on disk, retry once if it moved.
  async save(session) {
    const file = `${NOTE_DIR()}/${session}.json`;
    await exec("mkdir", ["-p", NOTE_DIR()]).catch(() => {});
    for (let tries = 0; tries < 2; tries++) {
      let raw = null, disk = {};
      try { raw = await readTextFile(file); disk = JSON.parse(raw) || {}; } catch {}
      this.notes = { ...disk, ...this.notes };
      try { await writeTextFile(file, JSON.stringify(this.notes), raw); return; } catch {}
    }
  }

  note(t, key, n) {
    return v_flex().gap(4).pl(10).border_l(2).border_color(t.border)
      .child(div().text_size(12.5).line_height(1.35).font_semibold().text_color(t.foreground).child(n.label))
      .when(n.points.length > 0, (e) => e.child(div().text_size(12).line_height(1.45).text_color(t.muted)
        .child(TextView.markdown("note-" + key, n.points.map((x) => "- " + x).join("\n")))));
  }

  render(cx) {
    // Clicking this panel can take focus off the terminal: keep showing the last one.
    const address = focused()?.terminal;
    if (address && address !== this.terminal) {
      this.terminal = address;
      this.session = null;
      this.turns = [];
      this.load(cx);
    }
    const t = theme();
    const notes = this.done().filter((x) => this.notes[x.key]);
    const body = !this.session
      ? div().text_size(12).text_color(t.dim).child("No Claude Code in this terminal")
      : notes.length === 0
        ? div().text_size(12).text_color(t.dim).child(this.making ? "Writing notes…" : "No finished turns yet")
        : v_flex().gap(14).children(notes.map((x) => this.note(t, x.key, this.notes[x.key])));
    return div().id("turn-notes").size_full().bg(t.chrome).overflow_y_scrollbar().p(12).child(body);
  }
}
