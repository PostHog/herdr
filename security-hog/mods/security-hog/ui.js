// Small drawn parts the views share.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

export function button(t, id, text, action, { primary = false, disabled = false, tip = null } = {}) {
  return h_flex().id(id).h(30).px(12).flex_none().items_center().rounded(8)
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .when(disabled, (el) => el.opacity(0.45))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
    .child(text);
}

const SEVERITY = {
  critical: ["Crit", "ansi1"],
  high: ["High", "ansi3"],
  medium: ["Med", "ansi4"],
  low: ["Low", "dim"],
  info: ["Info", "dim"],
};
export const severityRank = (s) => ["info", "low", "medium", "high", "critical"].indexOf((s ?? "").toLowerCase());

export function severity(t, s) {
  const [text, color] = SEVERITY[(s ?? "").toLowerCase()] ?? ["–", "dim"];
  const c = t[color] ?? t.dim;
  return h_flex().flex_none().w(32).h(16).rounded(4).items_center().justify_center().bg(c + "26")
    .text_size(10).font_semibold().text_color(c).child(text);
}

const VERDICT = {
  TRUE_POSITIVE: ["real", "Triage: true positive", "ansi1"],
  FALSE_POSITIVE: ["false +", "Triage: false positive", "dim"],
  NEEDS_HUMAN: ["unclear", "Triage: needs a human", "ansi3"],
  FIXED: ["fixed", "Triage: fixed since the scan", "ansi2"],
};

export const verdictWords = (v) => VERDICT[v]?.[1] ?? "Not triaged yet";

export function verdict(t, v, { full = false } = {}) {
  if (!v) return null;
  const [short, long, color] = VERDICT[v] ?? [v.toLowerCase(), v, "dim"];
  const c = t[color] ?? t.dim;
  return full
    ? h_flex().flex_none().h(22).px(9).items_center().rounded(11).bg(c + "26").text_size(11.5).font_medium().text_color(c).child(long)
    : div().flex_none().text_color(c).child(short);
}

export function ago(time) {
  if (!time) return "";
  const s = Math.max(0, (Date.now() - new Date(time).getTime()) / 1000);
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const prNumber = (url) => url?.match(/\/pull\/(\d+)/)?.[1] ?? null;
export const repoName = (slug) => slug?.split("/").pop() ?? "";
