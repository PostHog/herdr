// Names the focused pane. Herdr only names tabs, so pane names live in shared state for squirrel-pane-header and squirrel-topbar.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, focused, shared, setShared } from "herdr";

export const NAMES = "squirrel.pane-names";

export default class SquirrelRename extends View {
  init(_props, cx) {
    this.pane = focused()?.pane ?? null;
    this.text = (this.pane && shared(NAMES)?.[this.pane]) ?? "";
    this.input = InputState.new({ value: this.text });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submit() {
    if (this.pane) {
      const names = { ...(shared(NAMES) ?? {}) };
      const name = this.text.trim();
      if (name) names[this.pane] = name; else delete names[this.pane];
      setShared(NAMES, names);
    }
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    return v_flex().id("squirrel-rename").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().child(div().flex_1().text_size(14).font_semibold().child(this.pane ? "Rename pane" : "No pane focused"))
        .child(div().text_size(11).text_color(t.dim).child("Enter saves · empty resets · Esc")))
      .child(Input.new(this.input).h(34).px(10).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(13).text_color(t.foreground));
  }
}
