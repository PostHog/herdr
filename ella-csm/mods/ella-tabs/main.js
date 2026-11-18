// Clone of the shipped tabs bar; the only change is that the tab ✕ asks first,
// through mods/close-guard (which also ticks off linked to-dos), and a ☁ away button
// opens mods/away (a job for Claude on the devbox). In an account's
// space, the right of the bar shows its renewal and days since the last touch
// (from ~/book/spaces/cadence.json, see cadence.js), and a bell when the scouts
// posted about it this week (alerts.js); click it for the list (mods/alerts).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, home, readTextFile, watchFolder, terminals } from "herdr";
import { KEY as MINIMISED, liveMinimised } from "./minimised.js";
import { FILE, parse, daysSince, band, bandColor, touched, renewal } from "./cadence.js";
import { ALERTS_FILE, SEEN_KEY, parseAlerts, unseen } from "./alerts.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.cadence = {};
    this.alerts = {};
    const load = (cx) => cx.spawn(async (cx) => {
      this.cadence = parse(await readTextFile(`${home()}/${FILE}`).catch(() => null));
      this.alerts = parseAlerts(await readTextFile(`${home()}/${ALERTS_FILE}`).catch(() => null));
      cx.notify();
    });
    // Reading an alert marks it read in shared state, which doesn't redraw this bar.
    // Same for panes minimised from their header (the "minimised" chip).
    this.seen = JSON.stringify([shared(SEEN_KEY) ?? {}, shared(MINIMISED) ?? []]);
    cx.timer.every(1000, (cx) => {
      const now = JSON.stringify([shared(SEEN_KEY) ?? {}, shared(MINIMISED) ?? []]);
      if (now !== this.seen) { this.seen = now; cx.notify(); }
    });
    load(cx);
    cx.timer.every(10 * 60000, load);
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(`${home()}/book/spaces`); } catch { return; }
        load(cx);
      }
    });
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // "renews 26 mar 2027 · 6d" — renewal in amber within 90 days, pink once ended;
  // the dot and days in the cadence colour.
  accountChip(acc, t) {
    const days = daysSince(acc.last_touch);
    const color = bandColor(t, band(days));
    const r = renewal(acc);
    return h_flex().id("account-chip").h(26).px(9).gap(7).flex_none().items_center().rounded(6).text_size(12)
      .bg(t.chrome).text_color(t.muted).tooltip(`${acc.name} · touched ${touched(acc)}`)
      .child(div().text_color(r.ended ? t.ansi1 : r.soon ? t.ansi3 : t.muted).child(r.text))
      .child(div().text_color(t.dim).child("·"))
      .child(div().size(7).rounded(4).bg(color))
      .child(div().text_color(color).child(days === null ? "no touch" : `${days}d`));
  }

  // 🔔 3 (accent) when there are new scout posts about this account, 🔔 5 (dim) when
  // you've read them all; nothing when the scouts were quiet all week.
  alertBell(acc, t) {
    const list = this.alerts[acc.slug];
    if (!list?.length) return null;
    const fresh = unseen(list, shared(SEEN_KEY) ?? {});
    return h_flex().id("alerts-open").h(26).px(8).gap(4).flex_none().items_center().rounded(6).text_size(12)
      .when(fresh > 0, s => s.bg(t.accent).text_color(t.background).font_semibold())
      .when(!fresh, s => s.text_color(t.dim))
      .hover(s => s.opacity(0.85))
      .tooltip(fresh ? `${fresh} new from the scouts: ${list[0].title}` : `${list.length} scout post${list.length > 1 ? "s" : ""} this week, all read`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => openOverlay({ mod: "ella-alerts", kind: "dialog", width: 560, height: 460, props: { slug: acc.slug, name: acc.name } }))
      .child("🔔").child(String(fresh || list.length));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "ella-close-guard", kind: "dialog", width: 420, height: 230, props: { tab: c.id } }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const acc = space ? this.cadence[space.name] : null;
    const minimised = liveMinimised(shared(MINIMISED), terminals());
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .when(Boolean(acc), el => el.child(this.accountChip(acc, t)))
      .when(Boolean(acc && this.alertBell(acc, t)), el => el.child(this.alertBell(acc, t)))
      .when(minimised.length > 0, el => el.child(h_flex().id("minimised-open").h(26).px(9).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).text_color(t.muted).tooltip("panes you minimised, still running: click to bring one back")
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "ella-minimised", kind: "popup", width: 280, height: Math.min(60 + minimised.length * 46, 420) }))
        .child("▾").child(`${minimised.length} minimised`)))
      .child(h_flex().id("away-open").h(26).px(9).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .text_color(t.muted).tooltip("hand a job to Claude on the devbox: it keeps going with your laptop shut")
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "ella-away", kind: "dialog", width: 540, height: 250 }))
        .child("☁").child("away"))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/ella-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/ella-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/ella-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
