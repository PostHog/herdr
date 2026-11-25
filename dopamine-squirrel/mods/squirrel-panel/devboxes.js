// The Devboxes tab: one row per PostHog devbox, with Stop and Start, the folder synced to it
// and the panes working in that folder (click one to go to it).
// squirrel-topbar reads the boxes into shared "squirrel.devboxes" every minute (devboxes.js there).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, shared, setShared, panes, agents } from "herdr";
import { NAMES, ROW, COLS } from "./shared.js";

export const DEVBOXES = "squirrel.devboxes";
const BOX_TARGET = "squirrel.devbox-target";
const BOX_ACTIONS = "squirrel.devbox-actions";

const untilText = (ms) => {
  const m = Math.max(0, (ms - Date.now()) / 60000);
  return m < 60 ? `${Math.round(m)}m` : `${Math.round(m / 60)}h`;
};
const folderName = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop() || "—";

export const devboxViews = {
  devboxesView(t) {
    const c = this.cells(t);
    const data = shared(DEVBOXES) ?? {};
    // squirrel-topbar runs the stop or start and keeps its progress here (devboxes.js there).
    const actions = shared(BOX_ACTIONS) ?? {};
    const elapsed = (since) => { const sec = Math.max(0, Math.round((Date.now() - since) / 1000)); return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`; };
    const boxes = data.boxes ?? [];
    const W = { box: 190, status: 124, size: 190, stops: 70, app: 60, action: 64 };
    const columns = h_flex().flex_none().h(COLS).px(10).gap(10).items_center()
      .child(c.head(W.box, "BOX")).child(c.head(W.status, "STATUS", true)).child(c.head(W.size, "SIZE"))
      .child(c.head(W.stops, "STOPS IN")).child(c.headFlex("LOCAL CODE SYNCED TO IT")).child(c.head(W.app, "APP")).child(div().w(W.action).flex_none());

    const statusChip = (box) => {
      const busy = actions[box.name]?.verb;
      if (busy) return c.chip(W.status, `${busy === "stop" ? "stopping" : "starting"} ${elapsed(actions[box.name].since)}`, c.yellow);
      if (box.status === "running") return c.chip(W.status, "running", c.green);
      if (box.status === "stopped") return c.chip(W.status, "stopped", t.dim);
      if (box.status === "failed") return c.chip(W.status, "failed", c.red);
      return c.chip(W.status, box.status, c.yellow);
    };
    // Panes whose folder is the synced one, or inside it: their code is what the box runs.
    const names = shared(NAMES) ?? {};
    const titles = new Map(agents().map((a) => [a.pane, (a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim()]));
    const panesIn = (folder) => !folder ? [] : panes()
      .filter((p) => p.terminal && p.cwd && (p.cwd === folder || p.cwd.startsWith(`${folder}/`)))
      .map((p) => ({ pane: p.pane, name: names[p.pane] || titles.get(p.pane) || p.title || p.terminal }));
    const syncCell = (box) => {
      const s = box.sync;
      if (!s) return div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("none, the box runs its own copy of the repo");
      const problem = s.error ? "error" : s.conflicts ? `${s.conflicts} conflicts` : s.state === "paused" ? "paused" : null;
      const from = s.from?.replace(/\/+$/, "") ?? null;
      const users = panesIn(from);
      return h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().id(`sync-${box.name}`).flex_none().max_w(220).truncate().text_size(11.5).text_color(t.foreground)
          .tooltip(s.error ?? from ?? "").child(folderName(from)))
        .when(Boolean(problem), (el) => el.child(c.tag(problem, s.error || s.conflicts ? c.red : c.yellow)))
        .when(users.length === 0, (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child("no pane open there")))
        .children(users.slice(0, 3).map((u) => div().id(`sync-pane-${box.name}-${u.pane}`).flex_none().max_w(180).truncate().px(6).h(17)
          .flex().items_center().rounded(3).border(1).border_color(t.accent).text_size(10.5).text_color(t.accent)
          .hover((st) => st.bg(t.hover)).cursor_pointer().tooltip("Go to this pane")
          .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { pane: u.pane }); }).child(u.name)))
        .when(users.length > 3, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${users.length - 3}`)));
    };
    const appCell = (box) => box.status !== "running" ? c.cell(W.app, "—")
      : box.app === "healthy" ? c.cell(W.app, "up", c.green)
      : box.app === "initializing" ? c.cell(W.app, "starting", c.yellow)
      : c.cell(W.app, "off");
    const button = (box) => {
      const verb = box.status === "running" ? "stop" : box.status === "stopped" || box.status === "failed" ? "start" : null;
      const busy = Boolean(actions[box.name]?.verb);
      if (!verb || busy) return div().w(W.action).flex_none();
      return div().id(`box-${verb}-${box.name}`).w(W.action).flex_none().h(20).flex().items_center().justify_center().rounded(4)
        .border(1).border_color(t.border).text_size(11).text_color(verb === "stop" ? c.red : c.green)
        .hover((s) => s.bg(t.hover)).cursor_pointer()
        .tooltip(verb === "stop" ? "Stop the box. The disk is kept and billing stops." : "Start the box. Takes a few minutes.")
        .on_click(() => { setShared(BOX_TARGET, box.name); run(`squirrel-topbar.devbox_${verb}`); })
        .child(verb === "stop" ? "Stop" : "Start");
    };

    let body, content;
    if (data.error && !boxes.length) {
      body = div().px(10).py(8).text_size(11.5).text_color(c.red).child(data.error);
      content = ROW + 8;
    }
    else if (!boxes.length) {
      body = div().px(10).py(8).text_size(11.5).text_color(t.dim).child(data.at ? "No devboxes. Create one with hogli devbox:start." : "Loading devboxes…");
      content = ROW + 8;
    }
    else {
      let extra = 0;
      body = v_flex().children(boxes.map((box) => {
        const error = actions[box.name]?.error;
        if (error) extra += 18;
        return v_flex().child(h_flex().h(ROW).px(10).gap(10).items_center().border_b(1).border_color(t.border)
          .child(div().w(W.box).flex_none().truncate().text_size(11.5).text_color(t.foreground).child(box.name))
          .child(statusChip(box))
          .child(c.cell(W.size, [box.type, box.region].filter(Boolean).join(", ") || "—"))
          .child(c.cell(W.stops, box.stopsAt ? untilText(box.stopsAt) : "—"))
          .child(syncCell(box))
          .child(appCell(box))
          .child(button(box)))
          .when(Boolean(error), (el) => el.child(div().h(18).px(10).truncate().text_size(10.5).text_color(c.red).child(error)));
      }));
      content = boxes.length * ROW + extra;
    }
    return { columns, body, content };
  },
};
