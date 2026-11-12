import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, terminals, run, theme, setAgentOrder, shared, setShared, home, exec, hc } from "herdr";
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
      terminals[line.slice(0, tab)] = { pct: contextPercent(status), cost: status?.cost?.total_cost_usd ?? null,
        sessionId: status?.session_id ?? null, cwd: status?.workspace?.current_dir ?? status?.cwd ?? null };
      const account = (accounts[saved.config_dir ?? "~/.claude"] ??= {});
      for (const [window, v] of Object.entries(status?.rate_limits ?? {})) {
        const have = account[window];
        if (!have || v.resets_at > have.resets_at || (v.resets_at === have.resets_at && v.used_percentage > have.used_percentage)) account[window] = v;
      }
    } catch {}
  }
  return { terminals, accounts };
}

// One line per Claude subscription, with the same columns on every line. /usage (usage.js, every
// 10 minutes) gives every window, Fable and credits included; the statusline (after every reply)
// keeps 5h and week live in between.
function accountLines(accounts, usage) {
  const dirs = new Set([...Object.keys(usage), ...Object.keys(accounts).filter((d) => Object.keys(accounts[d]).length)]);
  return [...dirs].map((dir) => {
    const live = accounts[dir] ?? {}, windows = {};
    for (const w of usage[dir]?.windows ?? []) windows[w.label] = { ...w };
    // /usage leaves out the 5-hour window until something is used in it.
    if (usage[dir] && !windows["5h"]) windows["5h"] = { label: "5h", pct: 0, resetsAt: null };
    for (const [key, label] of [["five_hour", "5h"], ["seven_day", "week"]]) {
      const v = live[key];
      if (v) windows[label] = { label, pct: v.used_percentage, resetsAt: v.resets_at * 1000 };
    }
    return { dir, windows };
  }).filter((a) => Object.keys(a.windows).length);
}

const inTime = (ms) => {
  const m = Math.max(0, (ms - Date.now()) / 60000);
  return m < 60 ? `in ${Math.round(m)}m` : m < 60 * 24 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 60 / 24)}d`;
};

export function usageStrip(t, accounts, usage = {}) {
  const profiles = settings().claudeProfiles ?? [];
  const label = (dir) => profiles.find((p) => p.configDir && p.configDir.replace(/^~/, home()).replace(/\/$/, "") === dir)?.name ?? dir.replace(/^.*\/\.?/, "");
  const lines = accountLines(accounts, usage);
  if (!lines.length) return null;
  // 5h and week first, credits last, any per-model weeks (Fable…) between.
  const extra = [...new Set(lines.flatMap((l) => Object.keys(l.windows)))].filter((k) => !["5h", "week", "credits"].includes(k)).sort();
  const columns = ["5h", "week", ...extra, "credits"];
  const cell = (key, w) => {
    const color = !w || w.off ? t.dim : w.pct >= 80 ? t.ansi1 : w.pct >= 50 ? t.ansi3 : t.ansi2;
    return h_flex().w(USAGE_CELL).flex_none().gap(6).items_center()
      .child(div().w(42).flex_none().truncate().text_color(t.dim).child(key))
      .child(div().w(56).flex_none().h(5).rounded(3).bg(t.border)
        .when(Boolean(w) && !w.off, (el) => el.child(div().h_full().rounded(3).bg(color).w(Math.max(1, Math.min(56, w.pct * 0.56))))))
      .child(div().w(34).flex_none().text_color(color).child(!w ? "—" : w.off ? "off" : `${Math.round(w.pct)}%`))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(!w || w.off ? "" : w.spent ?? (w.resetsAt ? inTime(w.resetsAt) : "")));
  };
  return v_flex().flex_none().px(GAP + 4).py(2).text_size(11).text_color(t.muted).border_b(1).border_color(t.border)
    .children(lines.map(({ dir, windows }) => h_flex().h(USAGE_H).gap(12).items_center().min_w(0).overflow_hidden()
      .child(div().w(64).flex_none().truncate().font_semibold().text_color(t.foreground).child(label(dir)))
      .children(columns.map((key) => cell(key, windows[key])))));
}

const USAGE_CELL = 240;
export const usageHeight = (accounts, usage) => { const n = accountLines(accounts, usage).length; return n ? n * USAGE_H + 4 : 0; };
export const USAGE_H = 24;
const TAB_LABEL = 18, PILL_W = 210, PILL_H = 24;

// Background work Herdr doesn't report: Claude prints what's still running (shells, monitors,
// background agents) in its footer, e.g. "· 1 shell, 1 monitor". Read the bottom of each agent's
// screen and keep the counts.
export async function readBackground(terminalIds) {
  const out = {};
  for (const id of terminalIds) {
    const r = await hc(["read", id, "--lines", "0"]).catch(() => null);
    const bottom = (r?.code === 0 ? r.stdout : "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-4)
      .filter((l) => l.includes("·") || /still running/.test(l));
    const counts = {};
    for (const line of bottom)
      for (const m of line.matchAll(/(\d+)\s+(shell|monitor|background agent|agent|background task|task)s?\b/gi)) {
        const kind = m[2].toLowerCase().replace("background ", "");
        counts[kind] = Math.max(counts[kind] ?? 0, Number(m[1]));
      }
    if (Object.keys(counts).length) out[id] = counts;
  }
  return out;
}
const bgText = (counts) => Object.entries(counts).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(" · ");

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
    // A helper's parent: the terminal that started it with `hc run` (Herdr records that), or a
    // squirrel.parent label for helpers opened another way (`hc label <t> squirrel.parent=<parent>`).
    const parentOf = new Map(terminals().map((x) => [x.address, x.parent ?? x.labels?.["squirrel.parent"] ?? null]));
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

    const helpersOf = (a) => all.filter((c) => isChild(c) && parentOf.get(termOf(c)) === termOf(a));
    const card = (a) => {
      const p = byPane.get(a.pane);
      const helpers = helpersOf(a), parent = isChild(a) ? all.find((x) => termOf(x) === parentOf.get(termOf(a))) : null;
      const bg = this.background?.[termOf(a)], blue = t.ansi4;
      const color = { working: t.working, blocked: t.blocked, done: t.done, idle: t.dim }[a.status] ?? t.dim;
      const title = names[a.pane] || clean(a.title) || a.program?.name || a.address;
      const child = isChild(a), hidden = background.get(termOf(a)) ?? [];
      const { pct, cost } = this.context.terminals?.[termOf(a)] ?? {};
      const pctColor = pct >= 80 ? t.ansi1 : pct >= 50 ? t.ansi3 : t.ansi2;
      // Three lines on every card so heights match: name, the agent's own status, then background work
      // (shells, monitors, background agents) when there is any.
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
            .child(div().text_color(pctColor).child(`${Math.round(pct)}%`)))))
        .child(h_flex().h(15).gap(6).items_center().min_w(0).text_size(11).text_color(blue)
          .when(Boolean(bg) || helpers.length > 0, (el) => el
            .when(Boolean(bg) || helpers.some((h) => h.status === "working"), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().spin(2400)))
            .child(div().flex_1().min_w(0).truncate().child([
              bg ? `background: ${bgText(bg)}` : null,
              helpers.length ? `${helpers.length} helper${helpers.length === 1 ? "" : "s"}${helpers.some((h) => h.tab !== a.tab) ? ` in ${helpers[0].tab_name}` : ""}` : null,
            ].filter(Boolean).join(" · "))))
          .when(!bg && !helpers.length && Boolean(parent), (el) => el.text_color(t.dim)
            .child(div().flex_1().min_w(0).truncate().child(`helper of ${names[parent.pane] || clean(parent.title)}`))));
    };
    this.helperCount = all.filter(isChild).length;
    // One group per tab, labelled when there's more than one tab, so helpers opened in another tab read as a set.
    const groups = [];
    for (const a of list) {
      const g = groups.find((x) => x.tab === a.tab);
      if (g) g.items.push(a); else groups.push({ tab: a.tab, name: a.tab_name, items: [a] });
    }
    const perRow = Math.max(1, Math.floor((this.width - GAP * 2 + GAP) / (CARD_W + GAP)));
    const pillsPerRow = Math.max(1, Math.floor((this.width - GAP * 2 + GAP) / (PILL_W + GAP)));
    const labelled = groups.length > 1;
    // Every tab after the first (where you work) starts folded into one-line pills; its header unfolds it.
    this.openTabs ??= {};
    const foldable = (g) => labelled && g !== groups[0];
    const folded = (g) => foldable(g) && !this.openTabs[g.tab];
    this.cardsHeight = groups.reduce((h, g) => {
      const rows = Math.ceil(g.items.length / (folded(g) ? pillsPerRow : perRow));
      const rowH = folded(g) ? PILL_H : CARD_H;
      return h + (labelled ? TAB_LABEL : 0) + GAP * 2 + rows * rowH + (rows - 1) * GAP;
    }, 0) || CARD_H + GAP * 2;
    const pill = (a) => {
      const bg = this.background?.[termOf(a)], color = { working: t.working, blocked: t.blocked, done: t.done, idle: t.dim }[a.status] ?? t.dim;
      const { pct } = this.context.terminals?.[termOf(a)] ?? {};
      return h_flex().id(`pill-${a.address}`).w(PILL_W).h(PILL_H).flex_none().px(8).gap(6).items_center().rounded(PILL_H / 2)
        .bg(a.focused ? t.raised : t.surface).border(1).border_color(a.focused ? t.accent : a.status === "blocked" ? t.blocked : t.border)
        .hover((s) => s.bg(t.hover)).cursor_pointer().text_size(11)
        .on_click((_e, cx) => { this.openTabs[a.tab] = true; cx.notify(); })
        .tooltip(bg ? `background: ${bgText(bg)}` : WORD[a.status] ?? a.status)
        .child(a.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(color).spin(900)
          : div().size(7).flex_none().rounded(4).bg(color))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(names[a.pane] || clean(a.title) || a.address))
        .when(Boolean(bg), (el) => el.child(div().size(6).flex_none().rounded(3).bg(t.ansi4)))
        .when(typeof pct === "number", (el) => el.child(div().flex_none().text_color(t.dim).child(`${Math.round(pct)}%`)));
    };
    const cards = v_flex()
      .when(list.length === 0, (el) => el.child(div().p(GAP + 4).text_size(12).text_color(t.dim).child("No agents running")))
      .children(groups.map((g) => v_flex()
        .when(labelled, (el) => {
          // A tab of helpers says whose they are, and folds or unfolds on click.
          const owners = [...new Set(g.items.filter(isChild).map((c) => all.find((x) => termOf(x) === parentOf.get(termOf(c)))).filter(Boolean)
            .map((x) => names[x.pane] || clean(x.title)))];
          const helpersTab = foldable(g);
          const label = `${g.name} tab · ${g.items.length} agent${g.items.length === 1 ? "" : "s"}${owners.length ? ` · helpers of ${owners.join(", ")}` : ""}`;
          return el.child(h_flex().id(`tab-label-${g.tab}`).h(TAB_LABEL).px(GAP + 2).gap(4).items_end().text_size(10.5).font_semibold().text_color(t.dim)
            .when(helpersTab, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => { this.openTabs[g.tab] = !this.openTabs[g.tab]; cx.notify(); })
              .child(svg(`mods/squirrel-panel/${folded(g) ? "chevron-right" : "chevron-down"}.svg`).size(10)))
            .child(label));
        })
        .child(h_flex().flex_wrap().gap(GAP).p(GAP).children(g.items.map(folded(g) ? pill : card)))));
    return v_flex().child(usageStrip(t, this.context.accounts ?? {}, this.usage ?? {}) ?? div()).child(cards);
  },
};
