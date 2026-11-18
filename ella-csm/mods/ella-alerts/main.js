// Alerts: one account's scout posts from the last 7 days (see alerts.js), newest
// first. Opened from the badge in Accounts or the bell in the tab bar, with
// props { slug, name }. Click a post to open it in Slack, which marks it read; unread
// ones have an accent border and dot. "mark all read" clears the badge. Esc closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, props, closeOverlay, theme, readTextFile, shared, setShared } from "herdr";
import { ALERTS_FILE, SEEN_KEY, parseAlerts, markRead, ago } from "./alerts.js";

export default class Alerts extends View {
  init(_props, cx) {
    const { slug } = props() ?? {};
    this.list = null;
    this.all = {};
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      this.all = parseAlerts(await readTextFile(`${home()}/${ALERTS_FILE}`).catch(() => null));
      this.list = this.all[slug] ?? [];
      cx.notify();
    });
  }

  read(tsList, cx) {
    setShared(SEEN_KEY, markRead(shared(SEEN_KEY) ?? {}, tsList, this.all));
    cx.notify();
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  item(a, i, t, now) {
    const fresh = !(shared(SEEN_KEY) ?? {})[a.ts];
    return v_flex().id(`alert-${i}`).flex_none().gap(3).px(12).py(9).rounded(9).cursor_pointer()
      .border_1().border_color(fresh ? t.accent : t.border).bg(t.raised).hover((s) => s.bg(t.hover))
      .tooltip(`open in ${a.channel}`)
      .on_click((_e, cx) => { exec("/usr/bin/open", [a.link]); this.read([a.ts], cx); })
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .when(fresh, (el) => el.child(div().size(6).rounded(3).bg(t.accent)))
        .child(div().flex_1().min_w(0).truncate().child(`${a.scout}${a.update ? " · update" : ""}`))
        .child(div().flex_none().child(ago(a.at, now))))
      .child(div().text_size(12.8).font_medium().text_color(t.foreground).child(a.title))
      .when(Boolean(a.detail), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(a.detail)));
  }

  render() {
    const t = theme();
    const { name = "" } = props() ?? {};
    const now = new Date();
    const list = this.list ?? [];
    return v_flex().id("alerts").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(`${name} · scout alerts`))
        .when(list.some((a) => !(shared(SEEN_KEY) ?? {})[a.ts]), (el) => el.child(div().id("alerts-read-all").mr(12).text_size(11.5)
          .text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.read(list.map((a) => a.ts), cx)).child("mark all read")))
        .child(div().text_size(11).text_color(t.dim).child("last 7 days · Esc")))
      .child(v_flex().id("alerts-list").flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .when(this.list !== null && !list.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("nothing from the scouts this week")))
        .children(list.map((a, i) => this.item(a, i, t, now))));
  }
}
