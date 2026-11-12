import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, terminals, run, theme, setAgentOrder, shared, setShared, home, exec } from "herdr";
import { NAMES, VIEW, GITHUB, TRIAGED, REVIEW_PANES, VISITED, ROW, HEADER, COLS, MAX_ROWS, LINE, STALE_MS, CARD_W, CARD_H, GAP, now, settings, ago, order, newest } from "./shared.js";

// Table building blocks shared by Reviews and My PRs: fixed-width cells so every row lines up.
export const tableParts = {
  // Shared table pieces: fixed-width cells so every row lines up.
  cells(t) {
    const green = t.ansi2, yellow = t.ansi3, red = t.ansi1, blue = t.ansi4;
    const cell = (w, child, color = t.dim) => div().w(w).flex_none().truncate().text_size(11).text_color(color).child(child);
    const chip = (w, label, color) => div().w(w).flex_none().h(17).flex().items_center().justify_center().rounded(3)
      .border(1).border_color(color).text_color(color).text_size(10.5).child(label);
    const tag = (label, color, solid) => div().flex_none().px(5).h(16).flex().items_center().rounded(3).text_size(10).font_semibold()
      .when(solid, (el) => el.bg(color).text_color(t.background)).when(!solid, (el) => el.border(1).border_color(color).text_color(color)).child(label);
    const ci = (p) => ({
      SUCCESS: chip(70, "CI passed", green), PENDING: chip(70, "CI running", yellow), EXPECTED: chip(70, "CI running", yellow),
      FAILURE: chip(70, "CI failed", red), ERROR: chip(70, "CI failed", red),
    })[p.ci] ?? chip(70, "No CI", t.dim);
    const review = (p) => p.draft ? chip(116, "Draft", t.dim)
      : p.review === "APPROVED" ? chip(116, "Approved", green)
      : p.review === "CHANGES_REQUESTED" ? chip(116, "Changes requested", red)
      : chip(116, "Needs review", yellow);
    const size = (p, w = 92) => h_flex().w(w).flex_none().gap(4).text_size(11)
      .child(div().text_color(green).child(`+${p.additions}`)).child(div().text_color(red).child(`−${p.deletions}`));
    const visited = shared(VISITED) ?? {};
    const link = (p, w = 58) => div().id(`link-${p.url}-${p.number}`).w(w).flex_none().text_size(11.5).underline()
      .text_color(visited[p.url] ? t.ansi5 : t.accent).hover((s) => s.text_color(t.foreground)).cursor_pointer()
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.open_url(p.url);
        setShared(VISITED, { ...(shared(VISITED) ?? {}), [p.url]: Date.now() });
      }).child(`#${p.number}`);
    const head = (w, label, center) => div().w(w).flex_none().text_size(10).font_semibold().text_color(t.dim).when(Boolean(center), (el) => el.flex().justify_center()).child(label);
    const headFlex = (label) => div().flex_1().min_w(0).text_size(10).font_semibold().text_color(t.dim).child(label);
    return { green, yellow, red, blue, cell, chip, tag, ci, review, size, link, head, headFlex };
  },

  iconButton(id, icon, onClick, t, opts = {}) {
    return h_flex().id(id).w(opts.w ?? 28).flex_none().h(20).justify_center().items_center().rounded(4)
      .text_color(opts.color ?? t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); })
      .child(opts.spin ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900) : svg(icon).size(opts.size ?? 13));
  },

  checkbox(id, on, onClick, t, tip) {
    return h_flex().id(id).w(44).flex_none().h(20).justify_center().items_center().tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(div().size(14).rounded(3).border(1).flex().items_center().justify_center()
        .border_color(on ? t.accent : t.input ?? t.border).bg(on ? t.accent : t.chrome)
        .hover((s) => s.border_color(t.accent))
        .when(on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(11).text_color(t.accent_foreground))));
  },
};
