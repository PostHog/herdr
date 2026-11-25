// The bell's popup: reminders that came due (Start, Snooze, Dismiss), the ones still to come, and the
// last ones handled. Start opens Claude with the task typed in, not sent. The list is squirrel-topbar's
// (shared "squirrel.reminders"); every change goes back to it as a command (remind_act).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, run } from "herdr";
import { lensLayer, lensThread } from "./lens.js";

const W = 520, H = 460;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3600000, DAY = 24 * HOUR;

function when(ms) {
  const d = new Date(ms), h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${h}:${m} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

function tomorrowAt9() {
  const d = new Date(Date.now() + DAY);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

const SNOOZE = [["1h", () => Date.now() + HOUR], ["3h", () => Date.now() + 3 * HOUR], ["Tomorrow 9am", tomorrowAt9],
  ["+1 day", () => Date.now() + DAY], ["+1 week", () => Date.now() + 7 * DAY]];

export default class SquirrelReminders extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.snoozing = null;
    cx.spawn(async (cx) => { for (;;) { await cx.sleep(66); cx.notify(); } });
  }

  act(id, action, at) {
    setShared("squirrel.remind-act", { id, action, at });
    run("squirrel-topbar.remind_act");
    if (action === "start") closeOverlay(props().overlay);
  }

  render(cx) {
    const t = theme();
    const all = (shared("squirrel.reminders") ?? []).filter((r) => r.status !== "deleted");
    const due = all.filter((r) => r.status === "due").sort((a, b) => a.at - b.at);
    const upcoming = all.filter((r) => r.status === "upcoming").sort((a, b) => a.at - b.at);
    const past = all.filter((r) => r.status === "started" || r.status === "dismissed").sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0)).slice(0, 15);

    const small = (id, label, onClick, strong) => h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .bg(strong ? t.solid : t.raised).text_color(strong ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
    const heading = (text, n) => div().px(4).pt(10).pb(4).text_size(11).font_semibold().text_color(t.dim).child(`${text}${n ? ` · ${n}` : ""}`);
    const lt = Date.now() / 1000 * 0.18;
    let n = 0;
    const thread = () => lensThread(40 + n * 31, n++, lt, W);
    const row = (r, actions) => v_flex().id(`r-${r.id}`).px(8).py(7).gap(3).rounded(6).hover((s) => s.bg("#ffffff08"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(r.status === "due" || r.status === "upcoming" ? t.foreground : t.muted).child(r.task))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(r.status === "dismissed" ? "dismissed" : r.status === "started" ? "started" : when(r.at))))
      .when(Boolean(r.context), (el) => el.child(div().text_size(11).text_color(t.dim).child(r.context)))
      .when(Boolean(actions), (el) => el.child(h_flex().gap(5).pt(2).children(actions)))
      .when(this.snoozing === r.id, (el) => el.child(h_flex().gap(5).pt(2)
        .children(SNOOZE.map(([label, at]) => small(`sz-${r.id}-${label}`, label, (cx) => { this.snoozing = null; this.act(r.id, "snooze", at()); cx.notify(); })))));
    const snooze = (r) => small(`snooze-${r.id}`, this.snoozing === r.id ? "Snooze ▴" : "Snooze ▾", (cx) => { this.snoozing = this.snoozing === r.id ? null : r.id; cx.notify(); });

    return v_flex().id("squirrel-reminders").track_focus(this.handle).relative().overflow_hidden().w_full().h(H).p(10).bg(t.popover).text_color(t.foreground)
      .child(lensLayer(lt, W, H))
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(h_flex().px(4).items_center().child(div().flex_1().text_size(14).font_semibold().child("Reminders"))
        .child(small("add", "Add  ⇧⌘R", () => { closeOverlay(props().overlay); run("squirrel-topbar.remind"); })))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .when(due.length > 0, (el) => el.child(heading("Due", due.length))
          .children(due.flatMap((r, i) => [...(i ? [thread()] : []), row(r, [small(`start-${r.id}`, "Start", () => this.act(r.id, "start"), true), snooze(r), small(`dismiss-${r.id}`, "Dismiss", () => this.act(r.id, "dismiss"))])])))
        .child(heading("Upcoming", upcoming.length))
        .when(upcoming.length === 0, (el) => el.child(div().px(8).py(4).text_size(12).text_color(t.dim).child("Nothing scheduled")))
        .children(upcoming.flatMap((r, i) => [...(i ? [thread()] : []), row(r, [snooze(r), small(`delete-${r.id}`, "Delete", () => this.act(r.id, "delete"))])]))
        .when(past.length > 0, (el) => el.child(heading("Past")).children(past.flatMap((r, i) => [...(i ? [thread()] : []), row(r, null)]))));
  }
}
