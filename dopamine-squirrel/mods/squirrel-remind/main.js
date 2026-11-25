// cmd-shift-r: add a reminder in plain words ("monday 8am review the deploy PR, fable xhigh"). Claude reads it
// (squirrel-topbar reminders.js) and the popup shows what it understood, with the task and any context
// editable, before anything is saved. "Use this conversation" lets it pick the one or two lines the
// reminder refers to out of the pane you were in. Props: { transcript, title }.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, run } from "herdr";
import { lensLayer, tint } from "./lens.js";

const W = 560, H = 330;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MODELS = { "claude-opus-5-5": "Opus 5.5", "claude-fable-5-2": "Fable 5.2", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5" };

export function when(ms) {
  const d = new Date(ms), h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, "0");
  const mins = Math.round((ms - Date.now()) / 60000);
  const rel = mins < 0 ? "now" : mins < 60 ? `in ${mins}m` : mins < 60 * 24 ? `in ${Math.round(mins / 60)}h` : `in ${Math.round(mins / 60 / 24)}d`;
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${h}:${m} ${d.getHours() < 12 ? "AM" : "PM"} · ${rel}`;
}

export default class SquirrelRemind extends View {
  init(_props, cx) {
    this.step = "write";
    this.useContext = false;
    this.input = InputState.new({ placeholder: "monday 8am review the deploy PR · in 2h check the deploy · next week, fable xhigh…" });
    this.input.on("submit", () => this.read());
    this.task = InputState.new({});
    this.task.on("submit", () => this.save());
    this.context = InputState.new({});
    this.context.on("submit", () => this.save());
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => { for (;;) { await cx.sleep(66); cx.notify(); } });
    // The answer comes back through shared state from squirrel-topbar.
    cx.spawn(async (cx) => {
      for (;;) {
        await cx.sleep(100);
        const res = shared("squirrel.remind-res");
        if (this.step !== "reading" || res?.id !== this.req) continue;
        if (res.error) { this.error = res.error; this.step = "write"; this.input.focus(); }
        else {
          this.result = res.result;
          this.task.set_value(res.result.task);
          this.context.set_value(res.result.context ?? "");
          this.step = "check";
          this.task.focus();
        }
        cx.notify();
      }
    });
  }

  read() {
    const text = this.input.value().trim();
    if (!text || this.step === "reading") return;
    this.req = `${Date.now()}-${Math.random()}`;
    this.error = null;
    this.step = "reading";
    setShared("squirrel.remind-req", { id: this.req, text, transcript: this.useContext ? props().transcript : null });
    run("squirrel-topbar.remind_parse");
  }

  save() {
    if (this.step !== "check") return;
    const r = this.result;
    setShared("squirrel.remind-save", { at: r.at, task: this.task.value().trim() || r.task, context: this.context.value().trim(),
      model: r.model, effort: r.effort, asked: this.input.value().trim(), from: this.useContext ? props().title : null });
    run("squirrel-topbar.remind_save");
    closeOverlay(props().overlay);
  }

  render(cx) {
    const t = theme(), p = props() ?? {};
    const close = () => closeOverlay(p.overlay);
    const button = (id, label, primary, onClick) => h_flex().id(id).h(30).px(12).items_center().rounded(6).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    const field = (state) => Input.new(state).h(32).px(10).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
    const label = (text) => div().text_size(11).text_color(t.dim).child(text);
    const r = this.result;

    const write = v_flex().gap(10)
      .child(Input.new(this.input).h(34).px(10).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(13).text_color(t.foreground))
      .when(Boolean(p.transcript), (el) => el.child(h_flex().id("use-context").gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.useContext = !this.useContext; cx.notify(); })
        .child(div().size(14).rounded(3).border_1().border_color(this.useContext ? t.accent : t.input).bg(this.useContext ? t.accent : t.background)
          .flex().items_center().justify_center().text_size(10).text_color(t.background).child(this.useContext ? "✓" : ""))
        .child(div().flex_1().truncate().text_size(12).text_color(t.muted).child(`Use this conversation${p.title ? `: ${p.title}` : ""}`))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(this.step === "reading", (el) => el.child(div().text_size(12).text_color(t.dim).child("Reading it…")));

    const check = r && v_flex().gap(8)
      .child(label("When")).child(div().text_size(13).font_medium().text_color(t.foreground).child(when(r.at)))
      .child(label("Task")).child(field(this.task))
      .child(label("Context")).child(field(this.context))
      .child(h_flex().gap(6).items_center().child(div().text_size(11).text_color(t.dim).child("Starts"))
        .child(div().px(6).rounded(4).border_1().border_color(tint(0.6, Date.now() / 1000 * 0.18, 0.4)).text_size(10.5)
          .text_color(tint(0.6, Date.now() / 1000 * 0.18, 0.9, 0.2)).child(`${MODELS[r.model] ?? r.model} · ${r.effort}`)))
      .when(Boolean(r.problem), (el) => el.child(div().text_size(11).text_color(t.working).child(r.problem)));

    const now = Date.now() / 1000 * 0.18;
    return v_flex().id("squirrel-remind").track_focus(this.handle).relative().overflow_hidden().w_full().h(H).p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .child(lensLayer(now, W, H))
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .child(h_flex().child(div().flex_1().text_size(14).font_semibold().child("Remind me"))
        .child(div().text_size(11).text_color(t.dim).child(this.step === "check" ? "Enter saves · Esc" : "Enter reads it · Esc")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().child(this.step === "check" ? check : write))
      .when(this.step === "check", (el) => el.child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("back", "Change it", false, (_e, cx) => { this.step = "write"; this.input.focus(); cx.notify(); }))
        .child(button("save", "Save", true, () => this.save()))));
  }
}
