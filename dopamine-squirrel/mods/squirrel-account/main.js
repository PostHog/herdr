// Picks which Claude subscription a new pane runs on: 1, 2… or a click, Enter for the last one used.
// squirrel-topbar opens it before every Claude pane it starts and waits for the pick in shared
// "squirrel.account-pick"; the pick also sets off squirrel-dragon in that account's colour.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, openOverlay, home } from "herdr";

const PICK = "squirrel.account-pick", LAST = "squirrel.account-last";
const TONES = [
  { mid: "#4ade80", light: "#bbf7d0", deep: "#052e16" },
  { mid: "#c084fc", light: "#f5d0fe", deep: "#1e0636" },
];
const hexByte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");

export default class SquirrelAccount extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.req = p.req;
    this.profiles = p.profiles ?? [];
    const last = this.profiles.findIndex((x) => x.configDir === shared(LAST));
    this.last = last >= 0 ? last : 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(150, () => this.handle.focus());
    cx.spawn(async (cx) => { for (;;) { await cx.sleep(50); cx.notify(); } });
  }

  choose(i) {
    const p = this.profiles[i];
    if (!p || this.done) return;
    this.done = true;
    setShared(LAST, p.configDir);
    setShared(PICK, { req: this.req, configDir: p.configDir, at: Date.now() });
    openOverlay({ mod: "squirrel-dragon", kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 }, props: { name: p.name, index: i } });
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme(), ms = Date.now();
    const tile = (p, i) => {
      const tone = TONES[i % TONES.length], glow = 0.45 + 0.35 * Math.sin(ms / 260 + i * 2);
      const dir = (p.configDir ?? "").replace(home(), "~");
      return v_flex().id(`acct-${i}`).flex_1().h(128).p(12).gap(4).rounded(10).cursor_pointer()
        .bg(tone.deep).border(2).border_color(tone.mid + hexByte(i === this.last ? glow : glow * 0.45))
        .hover((s) => s.border_color(tone.light))
        .on_click(() => this.choose(i))
        .child(h_flex().items_center().gap(8)
          .child(div().size(30).flex_none().flex().items_center().justify_center().rounded(7).bg(tone.mid).text_color(tone.deep)
            .text_size(17).font_black().child(String(i + 1)))
          .child(div().flex_1())
          .when(i === this.last, (el) => el.child(div().text_size(10.5).text_color(tone.light + "aa").child("↵ last"))))
        .child(div().text_size(22).font_black().text_color(tone.light).child(p.name ?? dir))
        .child(div().text_size(11).text_color(tone.mid + "cc").truncate().child(dir));
    };
    return v_flex().id("squirrel-account").track_focus(this.handle).w_full().h(188).p(12).gap(10).bg(t.popover)
      .on_key_down((e, cx) => {
        cx.stop_propagation();
        if (e.key === "escape") return closeOverlay(props().overlay);
        if (e.key === "enter") return this.choose(this.last);
        const n = Number(e.key);
        if (n >= 1 && n <= this.profiles.length) this.choose(n - 1);
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child("Which Claude?"))
        .child(div().text_size(11).text_color(t.dim).child(`${this.profiles.map((_, i) => i + 1).join(" / ")} · ↵ last · esc`)))
      .child(h_flex().gap(10).children(this.profiles.map(tile)));
  }
}
