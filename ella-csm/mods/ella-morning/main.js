// Today's morning-launcher tasks as a checklist. A task is ticked off when its
// session writes NN-slug.done.md (its handover) next to its prompt file; until
// then the row shows the session's live status.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { agents, terminals, run, theme, props, home, exec, readTextFile, watchFolder, closeOverlay } from "herdr";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const pretty = (day) => { const [y, m, d] = day.split("-").map(Number); const x = new Date(y, m - 1, d); return `${DAYS[x.getDay()]} ${d} ${MONTHS[m - 1]}`; };

export default class Morning extends View {
  init(_props, cx) {
    this.day = props()?.day || today();
    this.dir = `${home()}/morning-launch/tasks/${this.day}`;
    this.tasks = [];
    this.state = {};
    this.open = {};
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(this.dir); } catch { return; }
        this.refresh(cx);
      }
    });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("ls", ["-1", this.dir]).catch(() => null);
      const names = r && r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      const has = new Set(names);
      const files = names.filter((n) => n.endsWith(".md") && !n.endsWith(".done.md")).sort();
      const tasks = [];
      for (const f of files) {
        const base = f.replace(/\.md$/, "");
        const text = (await readTextFile(`${this.dir}/${f}`).catch(() => null)) ?? "";
        const title = (text.split("\n")[0] || base).replace(/^#\s*/, "").trim();
        const doneFile = `${base}.done.md`;
        const handover = has.has(doneFile) ? await readTextFile(`${this.dir}/${doneFile}`).catch(() => null) : null;
        tasks.push({ file: f, title, done: has.has(doneFile), handover });
      }
      const raw = await readTextFile(`${this.dir}/.herdr.json`).catch(() => null);
      try { this.state = raw ? JSON.parse(raw) : {}; } catch { this.state = {}; }
      this.tasks = tasks;
      cx.notify();
    });
  }

  // What the row says when there's no handover yet, from the session's live state.
  live(task) {
    const where = this.state.tasks?.[task.file];
    if (!where) return { key: "waiting", label: "not started" };
    const a = agents().find((x) => x.address === where.terminal);
    if (a?.status === "working") return { key: "working", label: "working" };
    if (a?.status === "blocked") return { key: "blocked", label: "needs you" };
    if (a) return { key: "stopped", label: "stopped, no handover yet" };
    const t = terminals().find((x) => x.address === where.terminal);
    if (t && t.state === "live") return { key: "working", label: "starting" };
    return { key: "closed", label: "session closed" };
  }

  go(task) {
    const tab = this.state.tasks?.[task.file]?.tab;
    if (!tab) return;
    run("tab.select", { id: tab });
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  row(task, i, t) {
    const st = task.done ? { key: "done", label: "ticked off" } : this.live(task);
    const color = { done: t.done, working: t.working, blocked: t.blocked }[st.key] ?? t.dim;
    const box = task.done
      ? div().size(18).rounded(9).bg(t.done).flex().items_center().justify_center().text_size(11).text_color(t.accent_foreground).child("✓")
      : st.key === "working"
        ? svg("mods/workspace-chrome/spinner.svg").size(16).text_color(t.working).spin(900)
        : div().size(18).rounded(9).border(2).border_color(color);
    const open = this.open[task.file];
    return v_flex().gap(6).p(10).rounded(10).bg(open ? t.raised : t.surface).border(1).border_color(st.key === "blocked" ? t.blocked : t.border)
      .child(h_flex().id(`row-${i}`).gap(10).items_center().cursor_pointer()
        .on_click(() => this.go(task))
        .child(div().w(20).flex().justify_center().child(box))
        .child(v_flex().flex_1().gap(2)
          .child(div().text_size(14).truncate().text_color(task.done ? t.muted : t.foreground).when(task.done, (el) => el.line_through()).child(task.title))
          .child(div().text_size(12).text_color(color).child(st.label)))
        .when(task.done && !!task.handover, (el) => el.child(
          div().id(`ho-${i}`).px(8).py(3).rounded(6).text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); this.open[task.file] = !open; cx.notify(); })
            .child(open ? "hide" : "handover"))))
      .when(open && !!task.handover, (el) => el.child(
        div().pl(30).text_size(13).text_color(t.foreground).child(TextView.markdown(`md-${i}`, task.handover))));
  }

  render(cx) {
    const t = theme();
    const total = this.tasks.length;
    const done = this.tasks.filter((x) => x.done).length;
    const pct = total ? done / total : 0;
    return v_flex().size_full().bg(t.canvas).p(18).overflow_y_scrollbar().child(v_flex().w_full().max_w(720).gap(14)
      .child(v_flex().gap(4)
        .child(div().text_size(20).font_semibold().text_color(t.foreground).child(`morning · ${pretty(this.day)}`))
        .child(div().text_size(13).text_color(t.muted).child(
          total ? (done === total ? `all ${total} ticked off 🌱` : `${done} of ${total} ticked off`) : "no tasks for today")))
      .when(total > 0, (el) => el.child(
        div().h(6).w_full().rounded(3).bg(t.surface).child(div().h(6).rounded(3).bg(t.done).w(`${Math.round(pct * 100)}%`))))
      .children(this.tasks.map((task, i) => this.row(task, i, t)))
      .child(div().text_size(11).text_color(t.dim).child("click a task to jump to its tab. ticks happen by themselves when a session writes its handover.")));
  }
}
