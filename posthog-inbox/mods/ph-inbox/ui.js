// Small drawn parts the views share.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

export const icon = (name) => `mods/workspace-chrome/${name}.svg`;

export function button(t, id, text, action, { primary = false, disabled = false } = {}) {
  return h_flex().id(id).h(30).px(12).flex_none().items_center().rounded(8)
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
    .when(disabled, (el) => el.opacity(0.45))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
    .child(text);
}

// One of a row of choices.
export function choice(t, id, text, on, action) {
  return h_flex().id(id).h(26).px(10).flex_none().items_center().rounded(7).border_1()
    .border_color(on ? t.accent : t.input).bg(on ? t.selected : t.background)
    .text_color(on ? t.foreground : t.muted).text_size(12).cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_click(action).child(text);
}

export const input = (t, el) => el.h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
export const label = (t, text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);

const PRIORITY = { P0: "ansi1", P1: "ansi3", P2: "ansi4" };
export function priority(t, p) {
  const color = t[PRIORITY[p]] ?? t.dim;
  return h_flex().flex_none().w(22).h(16).rounded(4).items_center().justify_center().bg(color + "26")
    .text_size(10).font_semibold().text_color(color).child(p ?? "–");
}

// An agent's state, drawn as the agents list draws it.
export function statusMark(t, status) {
  if (status === "working") return svg(icon("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "done") return div().size(7).mx(3.5).flex_none().rounded(4).bg(t.done);
  if (status === "idle") return div().size(7).mx(3.5).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().w(8).h(1.5).mx(3).flex_none().bg(t.dim);
}

export function ago(time) {
  const s = Math.max(0, (Date.now() - new Date(time).getTime()) / 1000);
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const prNumber = (url) => url?.match(/\/pull\/(\d+)/)?.[1] ?? null;
