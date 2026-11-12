import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, updates, nextCommand, home } from "herdr";
import { fetchGh, GH_EVERY_MS } from "./github.js";
import { glow } from "./glow.js";
import { loadSettings, squirrelSettings } from "./settings.js";

// A WATCH triage mark ({at, watch}) lets a PR back in on new commits, a new comment or a re-request.
function cameBack(p, mark) {
  if (!mark?.watch) return false;
  return Date.parse(p.requestedAt) > mark.at || Date.parse(p.headAt) > mark.at || p.activity.some((a) => Date.parse(a.at) > mark.at);
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class SquirrelTopbar extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => { for (;;) { await loadSettings(); await fetchGh(); await cx.sleep(GH_EVERY_MS); } });
    // squirrel.json edits show up within 30 seconds.
    cx.spawn(async (cx) => { for (;;) { await cx.sleep(30000); await loadSettings(); } });
    cx.spawn(async (cx) => { for (;;) { await cx.sleep(50); cx.notify(); } });
    // cmd-w lands here: closing a pane asks first, so a stray keypress never kills an agent.
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "gh_refresh" || c?.name === "gh_refresh") fetchGh();
        for (const v of ["agents", "reviews", "mine"]) {
          if (c === `show_${v}` || c?.name === `show_${v}`) { setShared("squirrel.view", v); run("layout.show", { id: "agents-panel" }); }
        }
        if (c === "close_pane" || c?.name === "close_pane") {
          openOverlay({ mod: "confirm", kind: "dialog", width: 340, height: 150,
            props: { title: "Close this pane?", detail: "Anything running in it stops.", command: { name: "pane.close" } } });
        }
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

  // GitHub icon with the count of PRs waiting on me; opens the GitHub view in the agents panel.
  ghBadge(t, stop) {
    const gh = shared("squirrel.github") ?? {};
    const triaged = shared("squirrel.triaged") ?? {};
    const count = (gh.prs ?? []).filter((p) => !p.draft && (!triaged[p.url] || cameBack(p, triaged[p.url]))).length;
    return h_flex().id("gh-badge").h(26).px(7).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).text_color(gh.error ? t.blocked : count ? t.foreground : t.dim).hover(s => s.bg(t.hover))
      .on_mouse_down("left", stop)
      .on_click(() => {
        setShared("squirrel.view", "reviews");
        run("layout.show", { id: "agents-panel" });
      })
      .child(svg("icons/gh.svg").size(14))
      .when(count > 0, el => el.child(div().px(5).h(16).flex().items_center().rounded(8).bg(t.blocked).text_color(t.background).text_size(10.5).font_semibold().child(String(count))))
      .when(Boolean(gh.error), el => el.child("!"));
  }

  // One click starts the standup: Claude (standupCommand) with the standup skill from the PostHog MCP. A second click focuses that pane.
  standup(cx) {
    const existing = panes().find((p) => p.pane === shared("squirrel.standup-pane"));
    if (existing) { run("tab.select", { id: existing.tab }); run("pane.focus", { pane: existing.pane }); return; }
    if (this.standupStarting) return;
    this.standupStarting = true;
    cx.notify();
    const before = new Set(panes().map((p) => p.pane));
    const { standupCommand, standupSkill } = squirrelSettings();
    const argv = [...standupCommand.map((a) => a.replace(/~/g, home())),
      `Load my ${standupSkill} skill from the PostHog MCP (learn project:${standupSkill}) and draft today's standup.`];
    run("pane.split", { direction: "down", argv });
    cx.spawn(async (cx) => {
      for (let i = 0; i < 50; i++) {
        const added = panes().find((p) => !before.has(p.pane));
        if (added) {
          setShared("squirrel.standup-pane", added.pane);
          setShared("squirrel.pane-names", { ...(shared("squirrel.pane-names") ?? {}), [added.pane]: "Standup" });
          break;
        }
        await cx.sleep(100);
      }
      this.standupStarting = false;
      cx.notify();
    });
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
      // An unnamed tab takes the live title of its focused pane, else its first agent's (Claude Code sets it to the session topic).
      const tabPanes = panes().filter(p => p.tab === c.id && p.terminal);
      const lead = tabPanes.find(p => p.focused) ?? tabPanes.find(p => p.program?.agent) ?? tabPanes[0];
      const live = (lead?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const name = c.named ? c.name : live || program?.name || "Terminal";
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
        .child(div().max_w(260).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    // The window buttons sit in squirrel-topbar above this row, so no room is kept for them here.
    const root = layout(), w = window();
    // This is the window's top row, so it clears the macOS window buttons.
    const lights = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && Boolean(root?.traffic_lights);
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).when(Boolean(lights), el => el.pl(80)).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border).relative()
      .on_size_change((size, cx) => { if (Math.round(size.width) !== this.barWidth) { this.barWidth = Math.round(size.width); cx.notify(); } })
      .child(glow(this.barWidth ?? 1200, 40))
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.length > 1 ? shown.map(item) : []))
      .child(button("tab-new", "+", () => openOverlay({ mod: "squirrel-new-menu", kind: "popup", width: 250, height: 300 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(this.ghBadge(t, stop))
      .child(div().id("standup").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.ansi3)
        .hover(s => s.bg(t.hover)).tooltip("Start today's standup").on_mouse_down("left", stop).on_click((_e, cx) => this.standup(cx))
        .child(this.standupStarting ? svg("mods/workspace-chrome/spinner.svg").size(14).spin(900) : svg("mods/squirrel-topbar/megaphone.svg").size(15)))
      .child(button("search", svg("mods/workspace-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" })))
      .child(button("machine", svg("mods/workspace-chrome/server.svg").size(15), () => run("mod.open", { name: "machine-add" })))
      .child(button("settings", svg("mods/workspace-chrome/settings.svg").size(15), () => run("app.settings"))
        .when(Boolean(updates().app.ready), el => el.relative().child(div().absolute().top(4).right(4).size(6).rounded_full().bg(t.accent))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/squirrel-topbar/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/squirrel-topbar/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/squirrel-topbar/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
