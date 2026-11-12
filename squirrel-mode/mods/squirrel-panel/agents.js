import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, terminals, run, theme, setAgentOrder, shared, setShared, home, exec } from "herdr";
import { NAMES, VIEW, GITHUB, TRIAGED, REVIEW_PANES, VISITED, ROW, HEADER, COLS, MAX_ROWS, LINE, STALE_MS, CARD_W, CARD_H, GAP, now, settings, ago, order, newest } from "./shared.js";

// Context % and session cost come from Claude Code's statusLine: statusline.sh saves each session's
// status JSON under the Herdr terminal it runs in (data/squirrel/context/<terminal>.json).
const READ_CONTEXT = `for f in "$HOME"/.config/herdr-app/data/squirrel/context/*.json; do [ -f "$f" ] || continue; printf '%s\t' "$(basename "$f" .json)"; tr -d '\n' < "$f"; echo; done`;

function contextPercent(status) {
  const w = status?.context_window;
  if (typeof w?.used_percentage === "number") return w.used_percentage;
  const u = w?.current_usage;
  if (!u || !w.context_window_size) return null;
  return ((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)) / w.context_window_size * 100;
}

// Reads every session's saved status about every 10 seconds. Returns each terminal's context % and
// cost, and each Claude subscription's plan limits (keyed by its config folder). Every session of a
// subscription reports the same limits, so per window it keeps the latest reset, then the highest use.
export async function readContext() {
  const r = await exec("/bin/sh", ["-c", READ_CONTEXT]).catch(() => null);
  const terminals = {}, accounts = {};
  for (const line of (r?.code === 0 ? r.stdout : "").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    try {
      const saved = JSON.parse(line.slice(tab + 1)), status = saved.status ?? saved;
      terminals[line.slice(0, tab)] = { pct: contextPercent(status), cost: status?.cost?.total_cost_usd ?? null };
      const account = (accounts[saved.config_dir ?? "~/.claude"] ??= {});
      for (const [window, v] of Object.entries(status?.rate_limits ?? {})) {
        const have = account[window];
        if (!have || v.resets_at > have.resets_at || (v.resets_at === have.resets_at && v.used_percentage > have.used_percentage)) account[window] = v;
      }
    } catch {}
  }
  return { terminals, accounts };
}

const WINDOW_NAMES = { five_hour: "5h", seven_day: "week" };
function resetsIn(epochSeconds) {
  const m = Math.max(0, (epochSeconds * 1000 - Date.now()) / 60000);
  return m < 60 ? `${Math.round(m)}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 60 / 24)}d`;
}

// One line per Claude subscription: its 5-hour and weekly plan use, and when each resets.
export function usageStrip(t, accounts) {
  const names = settings().accountNames ?? {};
  const label = (dir) => names[dir] ?? dir.replace(/^.*\/\.?/, "");
  const entries = Object.entries(accounts).filter(([, limits]) => Object.keys(limits).length);
  if (!entries.length) return null;
  const bar = (pct) => {
    const color = pct >= 80 ? t.ansi1 : pct >= 50 ? t.ansi3 : t.ansi2;
    return h_flex().gap(5).items_center().flex_none()
      .child(div().w(60).flex_none().h(5).rounded(3).bg(t.border).child(div().h_full().rounded(3).bg(color).w(Math.max(1, Math.min(60, pct * 0.6)))))
      .child(div().text_color(color).child(`${Math.round(pct)}%`));
  };
  return h_flex().flex_none().h(USAGE_H).px(GAP + 2).gap(18).items_center().text_size(11).text_color(t.muted).border_b(1).border_color(t.border)
    .children(entries.map(([dir, limits]) => h_flex().gap(10).items_center().flex_none()
      .child(div().font_semibold().text_color(t.foreground).child(label(dir)))
      .children(Object.entries(limits).map(([window, v]) => h_flex().gap(5).items_center().flex_none()
        .child(div().text_color(t.dim).child(WINDOW_NAMES[window] ?? window))
        .child(bar(v.used_percentage))
        .child(div().text_color(t.dim).child(`resets in ${resetsIn(v.resets_at)}`))))));
}
export const USAGE_H = 28;

const WORD = { working: "working", blocked: "needs you", done: "done", idle: "idle" };
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function abbrev(a) {
  const key = `${a.program?.key ?? ""} ${a.app ?? ""}`.toLowerCase();
  if (key.includes("claude")) return "CC";
  if (key.includes("codex")) return "GPT";
  return (a.program?.name ?? "AG").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
}

// Running agents: one card per agent, sub-agents after their parent.
export const agentsViews = {
  agentsView(t) {
    const names = shared(NAMES) ?? {};
    const byPane = new Map(panes().map((p) => [p.pane, p]));
    const termOf = (a) => byPane.get(a.pane)?.terminal;
    // A sub-agent (a terminal another agent started) follows its parent; ones without a pane are counted on the parent.
    const parentOf = new Map(terminals().map((x) => [x.address, x.parent]));
    const all = agents(), agentTerms = new Set(all.map(termOf));
    const isChild = (a) => agentTerms.has(parentOf.get(termOf(a)));
    const list = [];
    for (const a of all.filter((a) => !isChild(a))) list.push(a, ...all.filter((c) => isChild(c) && parentOf.get(termOf(c)) === termOf(a)));
    const shownTerms = new Set(panes().map((p) => p.terminal));
    const background = new Map();
    for (const x of terminals()) if (x.state === "live" && agentTerms.has(x.parent) && !shownTerms.has(x.address))
      background.set(x.parent, [...(background.get(x.parent) ?? []), x.address]);
    setAgentOrder(list.map((a) => a.address));
    const h = home();
    const where = (cwd) => !cwd ? "" : cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;

    const card = (a) => {
      const p = byPane.get(a.pane);
      const color = { working: t.working, blocked: t.blocked, done: t.done, idle: t.dim }[a.status] ?? t.dim;
      const title = names[a.pane] || clean(a.title) || a.program?.name || a.address;
      const child = isChild(a), hidden = background.get(termOf(a)) ?? [];
      const { pct, cost } = this.context.terminals?.[termOf(a)] ?? {};
      const pctColor = pct >= 80 ? t.ansi1 : pct >= 50 ? t.ansi3 : t.ansi2;
      return v_flex().id(`card-${a.address}`).w(CARD_W).h(CARD_H).flex_none().px(8).py(6).gap(4).rounded(4)
        .bg(a.focused ? t.raised : t.surface).border(1).border_color(a.focused ? t.accent : a.status === "blocked" ? t.blocked : t.border)
        .when(child && !a.focused, (el) => el.border_l(2).border_color(t.dim))
        .hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click(() => { run("tab.select", { id: a.tab }); run("pane.focus", { pane: a.pane }); })
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().px(4).h(16).flex().items_center().rounded(3).bg(t.raised).border(1).border_color(t.border)
            .text_size(10).font_semibold().text_color(t.foreground).child(abbrev(a)))
          .when(child, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("↳")))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(title))
          .when(typeof cost === "number", (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`$${cost.toFixed(2)}`)))
          .when(hidden.length > 0, (el) => el.child(div().id(`bg-${a.address}`).flex_none().px(4).h(16).flex().items_center().rounded(3)
            .border(1).border_color(t.border).text_size(10).text_color(t.muted).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.keep", { terminal: hidden[0], place: "down" }); })
            .child(`+${hidden.length} in background`))))
        .child(h_flex().gap(6).items_center().min_w(0).text_size(11).text_color(t.muted)
          .child(a.status === "working"
            ? svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(color).spin(900)
            : div().size(7).flex_none().rounded(4).bg(color))
          .child(div().flex_none().text_color(color).child(WORD[a.status] ?? a.status))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(p?.branch ?? where(p?.cwd)))
          .when(typeof pct === "number", (el) => el.child(h_flex().flex_none().gap(4).items_center()
            .child(div().w(28).flex_none().h(4).rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(pctColor).w(Math.max(1, Math.min(28, pct * 0.28)))))
            .child(div().text_color(pctColor).child(`${Math.round(pct)}%`)))));
    };
    const cards = h_flex().flex_wrap().gap(GAP).p(GAP)
      .when(list.length === 0, (el) => el.child(div().p(4).text_size(12).text_color(t.dim).child("No agents running")))
      .children(list.map(card));
    return v_flex().child(usageStrip(t, this.context.accounts ?? {}) ?? div()).child(cards);
  },
};
