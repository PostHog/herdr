// History: a bar on top of the main area with back and forward, like a browser's, and where you are.
//
// A place is the main area's view (Work, Inbox, Grafana, Dungeon: the "main-stack" children) and, in
// Work, the task (space) and session (tab) shown. Each place you stay on for a moment joins the
// history; places passed through on the way (a click that switches view, then task, then session)
// don't. Going back or forward to a task or session that's gone skips it. Keys can run history.back
// and history.forward.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, checking, focused, layout, nextCommand, run, setShared, spaces, theme } from "herdr";

const VIEWS = "main-stack";
const NAMES = { main: "Work", inbox: "Inbox", grafana: "Grafana", dungeon: "Dungeon" }; // the views worth going back to
const SETTLE_MS = 700; // how long a place must stay shown to join the history
const MAX = 100;
const REVEAL = "tasks.reveal"; // tells the tasks sidebar to unfold a task and select a session

const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null));
const cleanTitle = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// Where you are now: { view, space, tab } (space and tab only in Work), or null on a view not kept.
function here() {
  const view = findNode(layout(), VIEWS)?.active ?? "main";
  if (!NAMES[view]) return null;
  if (view !== "main") return { view };
  const f = focused();
  return { view, space: f?.space ?? null, tab: f?.tab ?? null };
}
const same = (a, b) => Boolean(a && b) && a.view === b.view && a.space === b.space && a.tab === b.tab;

// A place's parts, by today's names: ["Work", task, session]. Gone ones keep the names they had.
function crumbs(p) {
  if (p.view !== "main") return [NAMES[p.view]];
  const s = spaces().find((x) => x.id === p.space);
  const tab = s?.tabs.find((x) => x.id === p.tab);
  const lead = tab && agents().find((a) => a.tab === tab.id);
  const tabName = tab ? (tab.named ? tab.name : cleanTitle(lead?.title) || `Session ${tab.index}`) : p.tabName;
  return ["Work", s?.name ?? p.spaceName, tabName].filter(Boolean);
}

// Whether a place can still be shown: its task and session are still open.
function alive(p) {
  if (p.view !== "main") return true;
  const s = spaces().find((x) => x.id === p.space);
  return Boolean(s) && (!p.tab || s.tabs.some((x) => x.id === p.tab));
}

export default class History extends View {
  init(_props, cx) {
    this.list = [];
    this.at = -1;
    try { ({ list: this.list, at: this.at } = JSON.parse(localStorage.getItem("history") ?? '{"list":[],"at":-1}')); } catch { /* starts empty */ }
    this.waiting = null; // a place shown now that hasn't stayed long enough yet
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "back") this.go(-1);
        if (c === "forward") this.go(1);
        cx.notify();
      }
    });
  }

  save() {
    try { localStorage.setItem("history", JSON.stringify({ list: this.list, at: this.at })); } catch { /* kept for this run only */ }
  }

  // Adds the place shown now, if it stayed: whatever was forward of the current one is dropped.
  settle() {
    const p = here();
    if (!p || !same(p, this.waiting) || same(p, this.list[this.at])) return;
    const [, spaceName, tabName] = crumbs(p);
    this.list = [...this.list.slice(0, this.at + 1), { ...p, spaceName, tabName }].slice(-MAX);
    this.at = this.list.length - 1;
    this.save();
  }

  // Shows the nearest place still open, `step` (-1 back, +1 forward) at a time; gone ones are dropped.
  go(step) {
    let i = this.at + step;
    while (i >= 0 && i < this.list.length && !alive(this.list[i])) {
      this.list.splice(i, 1);
      if (step < 0) { i--; this.at--; } // behind the current one: it moved down one too
    }
    if (i < 0 || i >= this.list.length) { this.save(); return; }
    this.at = i;
    this.save();
    const p = this.list[i];
    run("layout.select", { stack: VIEWS, child: p.view });
    if (p.view !== "main" || !p.space) return;
    run("space.select", { id: p.space });
    if (!p.tab) return;
    setShared(REVEAL, { space: p.space, tab: p.tab, at: Date.now() });
    run("tab.select", { id: p.tab });
  }

  render(cx) {
    const t = theme();
    const p = here();
    if (p && !same(p, this.list[this.at]) && !same(p, this.waiting)) {
      this.waiting = p;
      cx.timer.after(SETTLE_MS, (cx) => { this.settle(); cx.notify(); });
    }
    const back = this.list[this.at - 1], fwd = this.list[this.at + 1];
    const button = (id, icon, target, step) => div().id(id).flex_none().w(26).h(26).rounded(6).flex().items_center().justify_center()
      .text_color(target ? t.muted : t.dim).opacity(target ? 1 : 0.4)
      .when(Boolean(target), (el) => el.cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
        .tooltip(`${step < 0 ? "Back to" : "Forward to"} ${crumbs(target).join(" › ")}`)
        .on_click((_e, cx) => { this.go(step); cx.notify(); }))
      // Its own clicks: the bar around it drags the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(svg(`mods/history/${icon}.svg`).size(15));
    const parts = p ? crumbs(p) : [];
    return h_flex().id("root").size_full().items_center().gap(2).px(8).text_size(12)
      .child(button("hist-back", "arrow-left", back, -1))
      .child(button("hist-fwd", "arrow-right", fwd, 1))
      .child(h_flex().flex_1().min_w(0).ml(8).gap(6).items_center()
        .children(parts.flatMap((name, i) => [
          ...(i ? [div().flex_none().text_color(t.dim).child("›")] : []),
          div().min_w(0).truncate().text_color(i === parts.length - 1 ? t.foreground : t.muted).child(name),
        ])));
  }
}
