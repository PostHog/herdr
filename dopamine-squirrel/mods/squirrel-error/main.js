// The full error from the last GitHub refresh, opened by clicking the error in the panel header.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, run } from "herdr";

export default class SquirrelError extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  render() {
    const t = theme(), gh = shared("squirrel.github") ?? {};
    const close = () => closeOverlay(props().overlay);
    const button = (id, label, bg, fg, onClick) => h_flex().id(id).h(30).px(12).items_center().rounded(6).bg(bg).text_color(fg)
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex().id("squirrel-error").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .size_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().child(div().flex_1().text_size(14).font_semibold().child(gh.error ? "GitHub refresh failed" : "No error"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().id("detail").w_full().h(170).overflow_y_scrollbar().p(8).rounded(6).bg(t.background)
        .font_family("Menlo").text_size(11.5).text_color(t.foreground).whitespace_normal()
        .children([gh.error, gh.errorDetail].filter(Boolean).join("\n").split("\n").map((line) => div().w_full().whitespace_normal().child(line))))
      .child(div().text_size(11).text_color(t.dim).child("Every error is also in ~/.config/herdr-app/squirrel-errors.log"))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("close", "Close", t.raised, t.foreground, close))
        .child(button("retry", "Refresh again", t.solid, t.solid_foreground, () => { close(); run("squirrel-topbar.gh_refresh"); })));
  }
}
