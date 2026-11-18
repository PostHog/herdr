// Away: a dialog for handing a job to Claude on the devbox, so it keeps running
// with the laptop shut. Opened by the ☁ button in the tab bar (mods/ella-tabs).
// Runs ~/.local/bin/away, which wakes the devbox if needed and opens a space
// there with `claude --remote-control` on the job. Enter sends, Esc cancels.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, props, closeOverlay, theme, notify } from "herdr";

export default class Away extends View {
  init(_props, cx) {
    this.text = "";
    this.state = "idle"; // idle | sending | error
    this.error = "";
    this.input = InputState.new({ value: "", placeholder: "e.g. look through initech's replay errors this week and summarise" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  send(cx) {
    const job = this.text.trim();
    if (!job || this.state === "sending") return;
    this.state = "sending";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(`${home()}/.local/bin/away`, [job], { timeout: 900000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) {
        notify({ title: "sent to the devbox", body: "it keeps going with the lid shut. check in from the Claude app (Code).", level: "success" });
        closeOverlay(props().overlay);
        return;
      }
      this.state = "error";
      this.error = (r.stderr || r.stdout || "something went wrong").trim().split("\n").pop();
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const sending = this.state === "sending";
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .when(sending && primary, (el) => el.opacity(0.6))
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("away").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("☁  send to the devbox"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(6).text_size(11.5).text_color(t.dim)
        .child("Claude works on it in the cloud, so it keeps going with your laptop shut. Check in from the Claude app (Code)."))
      .child(div().pt(14).pb(7).text_size(11.5).text_color(t.dim).child("What should it work on?"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().pt(8).text_size(11.5)
        .text_color(this.state === "error" ? t.blocked : t.dim)
        .child(sending ? "waking the devbox if it's asleep, then starting Claude… (up to a couple of minutes)"
          : this.state === "error" ? this.error
          : "no Slack, PostHog or Granola there yet, and none of your Mac's files. Enter sends"))
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(button("away-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("away-send", sending ? "Sending…" : "Send", true, (_e, cx) => this.send(cx))));
  }
}
