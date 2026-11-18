// Minimised: the list behind the "minimised" chip in the tab bar (mods/ella-tabs).
// Click one to bring it back as a tab in the space it came from. Esc closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, terminals, spaces, run } from "herdr";
import { KEY, liveMinimised, removeMinimised } from "./minimised.js";

export default class Minimised extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() { closeOverlay((props() ?? {}).overlay); }

  restore(m) {
    setShared(KEY, removeMinimised(shared(KEY), m.terminal));
    if (spaces().some((s) => s.id === m.space)) run("space.select", { id: m.space });
    run("terminal.keep", { terminal: m.terminal });
    this.close();
  }

  render() {
    const t = theme();
    const terms = terminals();
    const list = liveMinimised(shared(KEY), terms);
    const row = (m, i) => {
      const status = terms.find((x) => x.address === m.terminal)?.status;
      const dot = status === "working" ? t.working : status === "blocked" ? t.blocked : status === "done" ? t.done : t.dim;
      return h_flex().id(`min-${i}`).gap(8).px(10).py(7).rounded(7).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.restore(m))
        .child(div().size(7).flex_none().rounded(4).bg(dot))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(m.name || m.terminal))
          .child(div().truncate().text_size(11).text_color(t.dim).child(m.spaceName ?? "")));
    };
    return v_flex().id("minimised").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .w_full().p(6).gap(2).bg(t.popover).text_color(t.foreground)
      .child(div().px(10).pt(4).pb(4).text_size(11).text_color(t.dim).child("minimised · click to bring back"))
      .when(!list.length, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim).child("nothing minimised")))
      .children(list.map(row));
  }
}
