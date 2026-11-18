// Asks before closing a tab, and ticks off any to-do item whose helper lives in
// what's being closed (see links.js). Opened three ways:
//   cmd-w (mod.open:ella-close-guard)          → the focused tab
//   the tab bar's ✕ (props {tab})         → that tab
//   a pane header's ✕ / cmd-shift-w       → props {pane}: that pane
// Enter confirms, Esc cancels.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, focused, panes, spaces, home, readTextFile, writeTextFile } from "herdr";
import { linkedItems, tick, slug } from "./links.js";
import { parse } from "./todo-list.js";

const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// What the pane header calls it: the agent's or shell's name, else the title.
const paneName = (p) => (p && (((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name)) || "this pane";

export default class CloseGuard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.dir = `${home()}/morning-launch`;
    const p = props() ?? {};
    const f = focused();
    this.pane = p.pane ?? null;
    this.tab = this.pane ? null : p.tab ?? f?.tab ?? null;
    this.name = this.pane
      ? paneName(panes().find((x) => x.pane === this.pane))
      : spaces().flatMap((s) => s.tabs).find((t) => t.id === this.tab)?.name ?? "this tab";
    this.items = null; // null while loading
    this.raw = null;
    cx.spawn(async (cx) => {
      await this.load();
      cx.notify();
    });
  }

  terminals() {
    return panes().filter((x) => (this.pane ? x.pane === this.pane : x.tab === this.tab) && x.terminal).map((x) => x.terminal);
  }

  async load() {
    this.raw = await readTextFile(`${this.dir}/todo.md`).catch(() => null);
    const records = {};
    for (const item of parse(this.raw).filter((i) => !i.done)) {
      const key = slug(item.text);
      const rec = await readTextFile(`${this.dir}/todo-prep/${key}.json`).catch(() => null);
      try { records[key] = rec ? JSON.parse(rec) : null; } catch { records[key] = null; }
    }
    this.items = linkedItems(this.raw, records, this.terminals());
  }

  // Tick, close, and only then shut the dialog: work queued after closeOverlay
  // never runs, because the dialog's script goes away with it.
  async yes() {
    if (this.busy) return;
    this.busy = true;
    const overlay = props().overlay;
    if (this.items?.length) {
      // If todo.md changed since we read it, read again rather than lose the edit.
      for (let tries = 0; tries < 3; tries++) {
        try { await writeTextFile(`${this.dir}/todo.md`, tick(this.raw, this.items.map((i) => i.text), today()), this.raw); break; }
        catch { this.raw = await readTextFile(`${this.dir}/todo.md`).catch(() => null); }
      }
    }
    if (this.pane) run("pane.close", { pane: this.pane });
    else if (this.tab) run("tab.close", { id: this.tab, confirmed: true });
    closeOverlay(overlay);
  }

  render(cx) {
    const t = theme();
    if (this.items === null) return div().size_full().bg(t.popover);
    const n = this.items.length;
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex()
      .id("close-guard")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.yes();
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(18).gap(10).rounded(8).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().truncate().text_size(15).font_semibold().text_color(t.foreground).child(`Close ${this.pane ? "" : "tab "}“${this.name}”?`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().flex_1().min_h(0).gap(4).overflow_y_scrollbar().text_color(t.muted)
        .child(div().child(n ? `This also ticks off ${n === 1 ? "this to-do" : `these ${n} to-dos`}:` : "Anything running in it stops."))
        .children(this.items.map((i, k) => div().id(`cg-${k}`).truncate().text_size(12).text_color(t.foreground).child(`✓ ${i.text}`))))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("no", "Cancel", t.raised, t.foreground, () => closeOverlay(props().overlay)))
        .child(button("yes", n ? "Close & tick off" : "Close", t.solid, t.solid_foreground, () => this.yes())));
  }
}
