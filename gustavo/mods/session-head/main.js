// The header of a session's pane (the gustavo layout's main tab block), in the sidebar's terms:
// the session (its name, as the Tasks list shows it), its task, the folder and the agent's status.
// Herdr's own `pane` header splits, zooms and closes panes, and closing a lone pane closes the
// space; here work is tasks and sessions, so the one button closes the session, after asking.
// Props from the app: { pane, terminal }. Click: focus the pane.
// Over a session pinned beside the shown tab (the tasks mod's side-by-side columns) the layout
// gives { terminal } alone: the same header for that terminal, and × only takes it off the view.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, agents, terminals, machines, props, run, theme, home, openOverlay, setShared, shared, layout } from "herdr";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// Whether sessions are shown beside the open tab (the tasks mod's "side-" columns in the "main" row).
function besideOpen() {
  const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((f, c) => f ?? find(c, id), null));
  return (find(layout(), "main")?.children ?? []).some((c) => c.id?.startsWith("side-"));
}

// "Only this": the tasks mod shows this session alone and takes the columns away.
function onlyButton(t, id, addr) {
  return div().id(id).p(3).rounded(4).text_color(t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip("Show only this session")
    .on_click((_e, cx) => {
      cx.stop_propagation();
      setShared("tasks.unpinning", addr);
      run("tasks.only");
    })
    .child(svg("mods/session-head/only.svg").size(13));
}

export default class SessionHead extends View {
  init() { this.hovered = false; }

  render(cx) {
    const t = theme();
    const pinned = !props()?.pane && props()?.terminal;
    if (pinned) return this.renderPinned(t, props().terminal);
    const p = panes().find((x) => x.pane === props()?.pane);
    if (!p) return div();
    const space = spaces().find((s) => s.tabs.some((tab) => tab.id === p.tab));
    const tab = space?.tabs.find((x) => x.id === p.tab);
    const lead = agents().find((a) => a.tab === p.tab);
    // On a devbox Herdr lost, the agent isn't known; the button then reconnects the devbox.
    const lost = Boolean(space?.machine) && machines().find((m) => m.name === space.machine)?.layout === "unavailable";
    const live = (lead?.title ?? p.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const name = (tab?.named ? tab.name : live) || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    // Its Claude account (the tasks mod tracks them), once there's more than one.
    const accounts = shared("tasks.accounts") ?? [];
    const acct = accounts.length > 1 ? (shared("tasks.sessionAccounts") ?? {})[p.terminal] : null;
    const who = accounts.find((a) => a.name === acct);
    return h_flex()
      .id(`sh-${p.pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((on, cx) => { this.hovered = on; cx.notify(); })
      .on_click(() => run("pane.focus", { pane: p.pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(320).font_medium().text_color(t.foreground).child(name))
      .when(Boolean(acct), (el) => el.child(div().id(`sh-acct-${p.pane}`).flex_none().px(6).h(18).flex().items_center().rounded(5)
        .bg(acct === "main" ? t.raised : t.selected).text_size(10.5).font_medium().text_color(acct === "main" ? t.muted : t.foreground)
        .tooltip(who?.email ? `Claude account ${acct}: ${who.email}${who.org ? ` (${who.org})` : ""}` : `Claude account ${acct}`)
        .child(acct)))
      .when(Boolean(space), (el) => el.child(div().flex_none().truncate().max_w(240).text_color(t.muted).child(space.name)))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", (el) => el.child(svg("mods/session-head/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(Boolean(p.terminal) && besideOpen(), (el) => el.child(onlyButton(t, `sh-only-${p.pane}`, p.terminal)))
      // Restart: Claude stops and resumes the same conversation in this tab (tasks mod restartSession).
      .when(this.hovered && Boolean(tab) && (Boolean(lead) || Boolean(space?.machine)), (el) => el.child(div().id(`sh-restart-${p.pane}`).p(3).rounded(4).text_color(lost ? t.ansi1 : t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(lost ? `Herdr lost ${space.machine}: reconnect it` : "Restart Claude and resume this conversation")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          setShared("tasks.restarting", tab.id);
          run("tasks.restart-tab");
        })
        .child(svg("mods/session-head/restart.svg").size(13))))
      .when(this.hovered && Boolean(tab), (el) => el.child(div().id(`sh-close-${p.pane}`).p(3).rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close this session")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          // Through the tasks mod, which keeps the task open when this is its last session.
          setShared("tasks.closing", tab.id);
          openOverlay({
            mod: "confirm", kind: "dialog", width: 400, height: 190,
            props: { title: `Close ${name}?`, detail: "Its agent stops and its tab closes. The task stays.", command: { name: "tasks.close-tab", args: {} } },
          });
        })
        .child(svg("mods/session-head/close.svg").size(14))));
  }

  // A session shown beside the tab: its tab's pane gives the name, task and status when it has one
  // (a sub-agent has none, then the terminal itself does).
  renderPinned(t, addr) {
    const p = panes().find((x) => x.terminal === addr);
    const term = terminals().find((x) => x.address === addr);
    const space = p && spaces().find((s) => s.tabs.some((tab) => tab.id === p.tab));
    const tab = space?.tabs.find((x) => x.id === p.tab);
    const lead = agents().find((a) => a.address === addr);
    const live = (lead?.title ?? p?.title ?? term?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const name = (tab?.named ? tab.name : live) || term?.name || p?.program?.name || addr;
    const pic = icon(p?.program ?? term?.program, 14, t.dim);
    const st = p?.status ?? lead?.status ?? null;
    const id = addr.replace(/[^A-Za-z0-9]/g, "-");
    return h_flex()
      .id(`sh-side-${id}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .rounded_t(10)
      .text_size(12)
      .on_hover((on, cx) => { this.hovered = on; cx.notify(); })
      .on_click(() => run("pane.focus", { terminal: addr }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(320).font_medium().text_color(t.foreground).child(name))
      .when(Boolean(space), (el) => el.child(div().flex_none().truncate().max_w(240).text_color(t.muted).child(space.name)))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p?.cwd ?? term?.cwd)))
      .when(st === "working", (el) => el.child(svg("mods/session-head/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .child(onlyButton(t, `sh-only-${id}`, addr))
      .child(div().id(`sh-unpin-${id}`).p(3).rounded(4).text_color(this.hovered ? t.muted : t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Stop showing it here (the session keeps running in its task)")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          setShared("tasks.unpinning", addr);
          run("tasks.unpin");
        })
        .child(svg("mods/session-head/close.svg").size(14)));
  }
}
