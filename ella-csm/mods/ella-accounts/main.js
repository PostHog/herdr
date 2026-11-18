// Accounts: every account in the book, A to Z, each with its logo and cadence dot (green,
// amber, pink past 8 weeks since the last touch) and days since. Click one to go
// to its space, or make it (acct-space starts Claude on the hp card there).
// Hover: when it was last touched, how, and the renewal. Data: ~/book/spaces/cadence.json.
// A number by the dot = scout alerts you haven't read (alerts.js); click it for the list.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, run, exec, theme, home, readTextFile, watchFolder, shared, setShared, layout, nextCommand, appHome, notify, openOverlay } from "herdr";
import { toggle, isFolded } from "./fold.js";
import { FILE, parse, daysSince, band, bandColor, touched, renewal } from "./cadence.js";
import { ALERTS_FILE, SEEN_KEY, parseAlerts, unseen } from "./alerts.js";

const FOLD_ID = "accounts";
const FOLD_DEPS = { layout, shared, setShared, run, readTextFile, appHome };
const PYTHON = "/opt/homebrew/bin/python3.13";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The account's favicon (fetched by book-spaces into ~/book/spaces/logos), else its first letter.
export function logo(acc, t, size = 16) {
  if (acc.logo) return div().size(size).flex_none().rounded(4).overflow_hidden().bg("#ffffff").child(image(acc.logo).size(size));
  return h_flex().size(size).flex_none().rounded(4).bg(t.raised).items_center().justify_center()
    .text_size(size * 0.6).font_bold().text_color(t.muted).child([...acc.name][0]?.toUpperCase() ?? "?");
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class Accounts extends View {
  init(_props, cx) {
    cx.spawn(async () => { for (;;) { if ((await nextCommand()) === "fold") toggle(FOLD_ID, FOLD_DEPS); } });
    this.accounts = {};
    this.alerts = {};
    this.opening = null;
    // The alert list marks alerts read in shared state, which doesn't redraw this view.
    this.seen = JSON.stringify(shared(SEEN_KEY) ?? {});
    cx.timer.every(1000, (cx) => {
      const now = JSON.stringify(shared(SEEN_KEY) ?? {});
      if (now !== this.seen) { this.seen = now; cx.notify(); }
    });
    this.load(cx);
    cx.timer.every(10 * 60000, (cx) => this.load(cx)); // the day rolls over: days since moves on
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(`${home()}/book/spaces`); } catch { return; }
        this.load(cx);
      }
    });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      this.accounts = parse(await readTextFile(`${home()}/${FILE}`).catch(() => null));
      this.alerts = parseAlerts(await readTextFile(`${home()}/${ALERTS_FILE}`).catch(() => null));
      cx.notify();
    });
  }

  open(acc, cx) {
    const space = spaces().find((s) => s.name === acc.slug);
    if (space) { run("space.select", { id: space.id }); return; }
    this.opening = acc.slug;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(PYTHON, [`${home()}/.local/bin/acct-space`, acc.name], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: `couldn't open ${acc.name}`, body: (r.stderr || r.stdout || "").trim().slice(0, 160), level: "error" });
      this.opening = null;
      cx.notify();
    });
  }

  showAlerts(acc) {
    openOverlay({ mod: "ella-alerts", kind: "dialog", width: 560, height: 460, props: { slug: acc.slug, name: acc.name } });
  }

  badge(acc, t, seen) {
    const list = this.alerts[acc.slug];
    const fresh = unseen(list, seen);
    if (!fresh) return null;
    return h_flex().id(`alerts-${acc.slug}`).h(16).min_w(16).px(5).flex_none().rounded(8).items_center().justify_center()
      .bg(t.accent).text_color(t.background).text_size(10).font_bold().cursor_pointer()
      .tooltip(`${fresh} new from the scouts: ${list[0].title}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.showAlerts(acc); })
      .child(String(fresh));
  }

  row(acc, t, now, open, seen) {
    const days = daysSince(acc.last_touch, now);
    const color = bandColor(t, band(days));
    const space = open[acc.slug];
    const r = renewal(acc, now);
    const badge = this.badge(acc, t, seen);
    return h_flex().id(`acct-${acc.slug}`).h(26).flex_none().px(8).gap(8).items_center().rounded(7)
      .when(space?.active, (el) => el.bg(t.selected))
      .when(!space?.active, (el) => el.hover((s) => s.bg(t.hover)))
      .cursor_pointer()
      .tooltip(`${acc.name} · touched ${touched(acc, now)} · ${r.text}`)
      .on_click((_e, cx) => this.open(acc, cx))
      .child(logo(acc, t))
      .child(div().flex_1().min_w(0).truncate().text_color(space ? t.foreground : t.muted)
        .child(this.opening === acc.slug ? `${acc.name} …` : acc.name))
      .when(r.soon, (el) => el.child(div().flex_none().text_size(10.5).text_color(r.ended ? t.ansi1 : t.ansi3).child(r.ended ? "ended" : "renews")))
      .when(Boolean(badge), (el) => el.child(badge))
      .child(div().size(7).flex_none().rounded(4).bg(color))
      .child(div().flex_none().w(28).text_size(11).text_color(t.dim).child(days === null ? "–" : `${days}d`));
  }

  compact(acc, t, now, seen) {
    const color = bandColor(t, band(daysSince(acc.last_touch, now)));
    const fresh = unseen(this.alerts[acc.slug], seen);
    return h_flex().id(`acct-${acc.slug}`).w(32).h(20).flex_none().justify_center().items_center().cursor_pointer()
      .tooltip(`${acc.name} · touched ${touched(acc, now)}`)
      .on_click((_e, cx) => this.open(acc, cx))
      .child(div().relative().child(logo(acc, t, 14))
        .child(div().absolute().right(-2).bottom(-2).size(6).rounded(3).bg(color))
        .when(fresh > 0, (el) => el.child(div().absolute().right(-3).top(-3).size(6).rounded(3).bg(t.accent))));
  }

  render() {
    const t = theme();
    const now = new Date();
    const collapsed = narrow();
    const folded = isFolded(FOLD_ID, shared);
    const list = Object.values(this.accounts).sort((a, b) => a.name.localeCompare(b.name));
    const open = Object.fromEntries(spaces().map((s) => [s.name, s]));
    const pink = list.filter((a) => band(daysSince(a.last_touch, now)) === "pink").length;
    const seen = shared(SEEN_KEY) ?? {};
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).flex_none().pl(16).pr(14).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, (el) => el.pl(0).pr(0).justify_center())
        .when(!collapsed, (el) => el
          .child(h_flex().id("fold-accounts").gap(5).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click(() => toggle(FOLD_ID, FOLD_DEPS))
            .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11)).child("Accounts"))
          .when(pink > 0, (el) => el.child(div().text_color(t.ansi1).tooltip("not touched in 8 weeks, or no touch on record").child(`${pink} past 8 wks`)))))
      .when(!folded || collapsed, (el) => el.child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(10).overflow_y_scrollbar()
        .when(!list.length, (el) => el.child(div().px(8).text_size(12).text_color(t.dim).child("no cadence yet: run book-spaces refresh-cadence")))
        .children(list.map((a) => (collapsed ? this.compact(a, t, now, seen) : this.row(a, t, now, open, seen))))));
  }
}
