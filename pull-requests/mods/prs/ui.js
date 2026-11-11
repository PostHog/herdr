import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export const SPINNER = "mods/workspace-chrome/spinner.svg";

export function ago(iso) {
  if (!iso) return "";
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const TONES = { ok: "ansi2", bad: "ansi1", warn: "ansi3", run: "working", merged: "ansi5", info: "ansi6" };

export const tone = (t, name) => t[TONES[name] ?? name] ?? (name === "run" ? t.ansi4 : t.muted);

export const TEXT = { title: 12.5, meta: 11, chip: 11, section: 10.5 };

export function button(t, id, label, onClick, options = {}) {
  const { primary = false, danger = false, small = false, disabled = false, icon = null, tooltip = null, ghost = false } = options;
  const bg = primary ? t.solid : t.raised;
  const fg = primary ? t.solid_foreground : danger ? tone(t, "bad") : ghost ? t.muted : t.foreground;
  return h_flex()
    .id(id)
    .h(small ? 22 : 30)
    .px(small ? 8 : 12)
    .gap(5)
    .flex_none()
    .items_center()
    .rounded(small ? 6 : 8)
    .when(!ghost, (el) => el.border_1().border_color(primary ? t.solid : t.border).bg(bg))
    .text_size(small ? TEXT.chip : 12.5)
    .text_color(fg)
    .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
    .when(disabled, (el) => el.opacity(0.45))
    .when(!disabled && ghost, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((event, cx) => {
      cx.stop_propagation();
      onClick(event, cx);
    }))
    .when(!disabled && !ghost, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((event, cx) => {
      cx.stop_propagation();
      onClick(event, cx);
    }))
    .when(Boolean(icon), (el) => el.child(svg(`mods/prs/icons/${icon}.svg`).size(small ? 12 : 14).flex_none().text_color(fg)))
    .child(label);
}

export function iconButton(t, id, iconName, label, onClick, toneName = "muted") {
  return glyphButton(t, id, svg(`mods/prs/icons/${iconName}.svg`).size(14).text_color(tone(t, toneName)), label, onClick);
}

export function glyphButton(t, id, glyph, label, onClick) {
  return h_flex()
    .id(id)
    .w(26)
    .h(24)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(6)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(label)
    .accessibility_label(label)
    .on_click((event, cx) => {
      cx.stop_propagation();
      onClick(event, cx);
    })
    .child(glyph);
}

export function textIconButton(t, id, iconName, label, onClick) {
  return h_flex()
    .id(id)
    .h(26)
    .px(8)
    .gap(6)
    .flex_none()
    .items_center()
    .rounded(6)
    .text_size(12.5)
    .text_color(t.foreground)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((event, cx) => {
      cx.stop_propagation();
      onClick(event, cx);
    })
    .child(svg(`mods/prs/icons/${iconName}.svg`).size(14).text_color(t.foreground))
    .child(label);
}

export function chip(t, id, label, on, onClick, count, dot = null) {
  return h_flex()
    .id(id)
    .h(24)
    .px(9)
    .gap(5)
    .flex_none()
    .items_center()
    .rounded(7)
    .border_1()
    .border_color(on ? t.accent : t.border)
    .bg(on ? t.selected : t.surface)
    .text_size(11.5)
    .text_color(on ? t.foreground : t.muted)
    .cursor_pointer()
    .hover((s) => s.text_color(t.foreground))
    .on_click((event, cx) => onClick(event, cx))
    .when(Boolean(dot), (el) => el.child(div().size(7).rounded(4).flex_none().bg(dot)))
    .child(label)
    .when(count !== undefined && count !== null, (el) => el.child(div().text_color(t.dim).child(String(count))));
}

export function tint(color, radius) {
  return div().absolute().top(0).left(0).size_full().rounded(radius).bg(color).opacity(0.14);
}

const AVATAR_TONES = ["info", "warn", "merged", "ok", "run"];

export function avatar(t, login, size = 20) {
  const name = String(login ?? "?");
  const hash = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  const color = tone(t, AVATAR_TONES[hash % AVATAR_TONES.length]);
  return h_flex()
    .relative()
    .size(size)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(size / 2)
    .child(tint(color, size / 2))
    .child(div().text_size(Math.round(size * 0.45 * 10) / 10).font_semibold().text_color(color).child(name.replace(/^@/, "").charAt(0).toUpperCase()));
}

export function countPill(t, label, color = null) {
  return h_flex()
    .relative()
    .h(16)
    .px(6)
    .flex_none()
    .items_center()
    .rounded(8)
    .when(!color, (el) => el.bg(t.raised))
    .when(Boolean(color), (el) => el.child(tint(color, 8)))
    .text_size(10.5)
    .text_color(color ?? t.muted)
    .child(label);
}

export function codePill(t, label) {
  return h_flex().min_w(0).px(7).h(18).items_center().rounded(5).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.muted).child(div().min_w(0).truncate().child(label));
}

export function badge(t, label, colorName) {
  const color = tone(t, colorName);
  return div().flex_none().px(5).h(16).rounded(4).border_1().border_color(color).text_size(9.5).font_semibold().text_color(color).child(label);
}

export function checkBar(t, checks, width = 54) {
  const total = Math.max(checks.total, 1);
  const segment = (count, color) => (count > 0 ? div().h_full().w((width * count) / total).bg(color) : null);
  return h_flex()
    .w(width)
    .h(4)
    .flex_none()
    .rounded(2)
    .overflow_hidden()
    .bg(t.border)
    .children([segment(checks.passed, tone(t, "ok")), segment(checks.failed, tone(t, "bad")), segment(checks.inProgress, tone(t, "run"))].filter(Boolean));
}

export function statusPillView(t, pill, checks) {
  const color = tone(t, pill.tone);
  return h_flex()
    .h(22)
    .px(8)
    .gap(7)
    .flex_none()
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(color)
    .text_size(11)
    .text_color(color)
    .when(pill.tone === "run", (el) => el.child(svg(SPINNER).size(10).spin(900).text_color(color)))
    .child(pill.label)
    .when(checks && checks.total > 0, (el) => el.child(checkBar(t, checks, 40)));
}

export function section(t, label, right) {
  return h_flex()
    .px(6)
    .pt(12)
    .pb(4)
    .items_center()
    .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child(label.toUpperCase()))
    .when(Boolean(right), (el) => el.child(right));
}

export function empty(t, text) {
  return div().p(14).text_size(12).text_color(t.dim).child(text);
}

export function field(t, label, control, hint) {
  return v_flex()
    .gap(5)
    .pt(12)
    .child(div().text_size(12).font_semibold().text_color(t.foreground).child(label))
    .child(control)
    .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
}

export function menuItem(t, id, label, onClick, hint) {
  return h_flex()
    .id(id)
    .h(28)
    .px(8)
    .gap(8)
    .rounded(6)
    .items_center()
    .text_color(t.foreground)
    .cursor_pointer()
    .hover((el) => el.bg(t.hover))
    .on_click(onClick)
    .child(div().flex_1().truncate().child(label))
    .when(Boolean(hint), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(hint)));
}

const TITLE_PREFIX = /^([a-z]+(?:\([^)]*\))?!?:)\s*(.+)$/i;

export function splitTitle(title) {
  const match = TITLE_PREFIX.exec(title ?? "");
  return match ? { prefix: match[1], subject: match[2] } : { prefix: "", subject: title ?? "" };
}

export function titleText(t, title, { quiet = false, size = TEXT.title } = {}) {
  const { prefix, subject } = splitTitle(title);
  return h_flex()
    .flex_1()
    .min_w(0)
    .gap(4)
    .text_size(size)
    .when(Boolean(prefix), (el) => el.child(div().flex_none().text_color(t.dim).child(prefix)))
    .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(subject));
}

export function gateStrip(t, id, gates, { segment = null, height = 3 } = {}) {
  return h_flex()
    .gap(segment ? 3 : 2)
    .children(gates.map((gate) => {
      const bar = div().id(`${id}-gate-${gate.id}`).h(height).rounded(2).bg(gate.state === "idle" ? t.border : tone(t, gate.state)).tooltip(`${gate.label}: ${gate.sub}`);
      return segment ? bar.w(segment).flex_none() : bar.flex_1();
    }));
}

export function actionButton(t, id, iconName, label, onClick, toneName = "muted") {
  return h_flex()
    .id(id)
    .w(26)
    .h(22)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(6)
    .border_1()
    .border_color(t.border)
    .bg(t.raised)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(label)
    .accessibility_label(label)
    .on_click((event, cx) => {
      cx.stop_propagation();
      onClick(event, cx);
    })
    .child(svg(`mods/prs/icons/${iconName}.svg`).size(13).text_color(tone(t, toneName)));
}
