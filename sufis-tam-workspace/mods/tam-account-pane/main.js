// The account pane (a port of PostHog/claude-code-account-pane to Herdr): one
// account's overview, spend, opps, signals, people and notes, read from the JSON
// files the account-pane sync writes into ~/work/accounts/<account>/ (~/accounts links there).
//
// Two copies: the right sidebar (layout block "account-panel"), which follows the
// focused terminal's account (its tam.account label, else its folder) and is shown
// only while that's an account; and an "Account · Overview" tab (props().folder).
// Buttons that would fill Claude's message box paste into the focused chat in the
// sidebar (Enter is yours), or start a new chat in the account's folder in the tab.
// Read-only, apart from quicknote.md and signal-state.json in the account folder.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { home, theme, terminals, focused, run, props, shared, readTextFile, writeTextFile, watchFolder, exec, checking, openOverlay } from "herdr";
import { editMethods } from "./opp-edit.js";

const ROOT = () => `${home()}/work/accounts`;
const ALL = "all-accounts"; // book-wide tasks: no account to show
// All accounts > Opportunities: every open opp across the accounts in roster.json.
const OPPS = "all-accounts:opportunities";
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// Where Customer Analytics, Slack and Salesforce live, from ~/.config/tam-herdr/config.json
// (kept out of the shared repo). A link whose base isn't set is left out.
let CONF = {};
async function loadConf() {
  try { CONF = JSON.parse((await readTextFile(`${home()}/.config/tam-herdr/config.json`)) ?? "{}") ?? {}; } catch { CONF = {}; }
}
const base = (key) => (CONF[key] ? String(CONF[key]).replace(/\/+$/, "") : null);
const caUrl = (id) => (base("posthog_project_url") && id ? `${base("posthog_project_url")}/customer_analytics/accounts/${id}` : null);
const caProject = () => base("posthog_project_url")?.match(/\/project\/(\d+)/)?.[1] ?? null;
const slackUrl = (channel) => (base("slack_url") && channel ? `${base("slack_url")}/archives/${channel}` : null);
const sfdcUrl = (object, id) => (base("salesforce_url") && id ? `${base("salesforce_url")}/lightning/r/${object}/${id}/view` : null);
const STALE_MS = 24 * 60 * 60 * 1000;
const SYNC_STUCK_MS = 60 * 60 * 1000;
const OVERVIEW_PRODUCTS = 3;
const OVERVIEW_OPPS = 2;
const OVERVIEW_SIGNALS = 2;
const TREND_PCT = 10;
const TREND_MIN_SPEND = 100;
const NEW_SIGNAL_DAYS = 7;
const ARCHIVE_VIEW_DAYS = 90;
const AUTOSAVE_MS = 1000;
const QUICKNOTE = "quicknote.md";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GREEN = "#1d9e75";
const BLUE = "#378add";
const RED = "#c0392b";
const AMBER = "#c98a00";
const ORANGE = "#f07c2b";
const YELLOW = "#e8b422";
// Salesforce's placeholder amount: an opp still at exactly $100k hasn't been sized yet.
const PLACEHOLDER_AMOUNT = 100000;
const FILES = ["account", "spend", "opps", "signals", "scouts", "people", "ca-notes", "signal-state"];

const TABS = [
  ["overview", "🌐", "Overview"],
  ["spend", "📈", "Spend"],
  ["opps", "💰", "Opps"],
  ["signals", "🚦", "Signals"],
  ["people", "👥", "People"],
  ["notes", "📝", "Notes"],
];
const LIGHT = { red: "🔴", amber: "🟡", green: "🟢" };
const SIGNAL_LEGEND = [
  "🟢 Room to grow: spend up, a free tier filling, an annual pitch",
  "🟡 Get ahead of it: a bill jump or credit running out early",
  "🔴 Risk: spend falling, or out of credit",
  "P1 to P3: how much is at stake against the last invoice (P1 25%+, P2 10%+, P3 less)",
].join("\n");
const SCOUT_LABEL = { "cross-sell": "🔭 Cross-sell scout", account: "🧭 Account scout", spike: "📈 Spike detector" };

// Team skills from PostHog's skill store (the Customer Analytics project); a button hands Claude a
// prompt that loads the newest version, so nothing here goes stale.
const TEAM_SKILLS = [
  { name: "posthog-customer-deep-dive", label: "Deep dive", what: "research before an email or call", ask: () => "Research this account before my next email or call." },
  { name: "csm-signal-playbook", label: "Judge signals", what: "is each signal real, does it matter, what to do", ask: (s) => (s.length ? `Judge this account's live signals: ${s.join("; ")}.` : "Judge this account's latest alerts and usage moves.") },
  { name: "cs-product-depth", label: "Product depth", what: "usage depth per product against our standards", ask: () => "Read this account against the per-product standards and list the gaps worth raising." },
  { name: "cross-sell-playbooks", label: "Cross-sell", what: "which playbook fits this account now", ask: () => "Check which playbooks this account is eligible for and which one to run now, with who to contact." },
  { name: "mcp-account-themes", label: "MCP use", what: "what their agents use the PostHog MCP for", ask: () => "Build the theme list for this account." },
  { name: "ca-sync", label: "Account plan", what: "the account plan as a Customer Analytics note", ask: () => "Draft the account plan and show it to me before writing anything." },
];

// --- formatting ------------------------------------------------------------

function money(n) {
  if (n === null || n === undefined) return "no amount";
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}
function weekStart(end) {
  const d = new Date(`${end.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
}
function day(iso, thisYear) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  const label = `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
  return thisYear && y !== thisYear ? `${label}, ${y}` : label;
}
// Whole days from today to an ISO date (negative when it's past).
function daysTo(iso, today) {
  return iso ? Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(today)) / 86400000) : null;
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const signed = (p) => `${p >= 0 ? "+" : ""}${Math.round(p)}%`;
const archiveKey = (sig) => `${sig.id}@${sig.first_seen}`;
const isNew = (sig, today) => Date.parse(today) - Date.parse(sig.first_seen) < NEW_SIGNAL_DAYS * 864e5;

function trending(spend, dir) {
  return spend.products
    .filter((p) => p.latest >= TREND_MIN_SPEND && p.change_pct !== null && p.change_pct * dir >= TREND_PCT)
    .sort((a, b) => (b.change_pct - a.change_pct) * dir)
    .map((p) => `${p.name} ${signed(p.change_pct)}`);
}
function notUsingSummary(spend) {
  const stopped = spend.stopped?.length ? ` Stopped paying for: ${spend.stopped.join(", ")}.` : "";
  return (spend.not_using.length ? `Not using: ${spend.not_using.join(", ")}.` : "Using every product with a bill.") + stopped;
}
function freeTierSummary(spend) {
  if (!spend.free_tier?.length) return null;
  return `Free tier: ${spend.free_tier.map((f) => (f.usage_change_pct === null ? f.name : `${f.name} ${signed(f.usage_change_pct)}`)).join(", ")}.`;
}
function changeBasis(p) {
  const w = p.weekly ?? [];
  if (p.change_basis === "weeks" && w.length >= 8) {
    const total = (pts) => pts.reduce((t, x) => t + x.amount, 0);
    return `${money(total(w.slice(-4)))} in the last 4 weeks vs ${money(total(w.slice(-8, -4)))} in the 4 weeks before`;
  }
  const [before, last] = p.series.slice(-2);
  return before && last ? `${money(last.amount)} on the last invoice vs ${money(before.amount)} on the one before` : "Last invoice vs the one before";
}
function chartPoints(p, thisYear) {
  // A weekly point's date is the last day of its 7-day window.
  if (p.weekly && p.weekly.length > 1) return p.weekly.map((w) => ({ x: `Week of ${day(weekStart(w.date), thisYear)}`, amount: w.amount }));
  return (p.series ?? []).map((s) => ({ x: `Invoice ${day(s.date, thisYear)}`, amount: s.amount }));
}
function latestStep(text) {
  return text ? text.split(/\r?\n\s*\r?\n/)[0]?.trim() || null : null;
}
function overviewPeople(file) {
  const people = file.people ?? [];
  const tied = people.find((p) => p.tie?.source === "signal") ?? people.find((p) => p.tie) ?? people[0];
  const fresh = (file.new_users ?? []).find((p) => p.email !== tied?.email);
  return [...(tied ? [[tied, false]] : []), ...(fresh ? [[fresh, true]] : [])];
}
function accountLinks(a) {
  return [
    ["Customer Analytics", caUrl(a.account_id)],
    ["Stripe", a.links?.stripe],
    ["Slack", slackUrl(a.slack_channel_id)],
    ["Salesforce", sfdcUrl("Account", a.sfdc_id)],
    ["Metabase", a.links?.metabase],
    ["Admin", a.links?.admin],
    ["Billing admin", a.links?.billing_admin],
  ].map(([l, h]) => [l, typeof h === "string" && h ? h : null]);
}

// --- prompts ---------------------------------------------------------------

function outreachPrompt(account, p, isNewUser) {
  return [
    `Draft a short outreach message from me to ${p.name} (${p.email}), ${p.role === "Not a member" ? "a contact" : (p.role ?? "").toLowerCase()} at ${account.name}.`,
    isNewUser && p.signed_up ? `They're new to PostHog (signed up ${p.signed_up}): make it a welcome that offers help getting started, not a sales note.` : "",
    p.reasons?.length ? `Why them, why now: ${p.reasons.join("; ")}.` : "",
    p.draft ? `The scout suggested: "${p.draft}" Use it as a starting point.` : "",
    "First check this account's recent Slack messages and call notes so it doesn't repeat or contradict anything. Keep it under 80 words, plain and specific, with one clear ask.",
    "Then run /account-pane:humanizer on the draft and show me the final version. Draft only: don't send anything.",
  ].filter(Boolean).join(" ");
}
function skillPrompt(account, skill, signals) {
  return [
    `Run the PostHog team skill \`${skill.name}\` on ${account.name} (Customer Analytics account ${account.account_id}, org ${account.org_id}).`,
    `First load its newest version from ${caProject() ? `PostHog project ${caProject()}` : "the PostHog project that holds Customer Analytics"} with the PostHog MCP: \`skill-get\` with skill_name "${skill.name}" and no version. If body_total_length is longer than the body you got, page on with body_offset, and fetch any file it points to with \`skill-file-get\`. Don't use a local or cached copy.`,
    `Then follow it for this account only. ${skill.ask(signals)}`,
    "Ask me before writing to Customer Analytics, Salesforce or Slack, or messaging anyone.",
  ].join(" ");
}

// The account a terminal belongs to: its tam.account label, else the account
// folder it's in.
function accountOf(term) {
  const label = term?.labels?.["tam.account"];
  if (label) return (shared("work.folders") ?? [ALL]).includes(label) ? null : label;
  const cwd = term?.cwd ?? "";
  const root = [`${ROOT()}/`, `${home()}/accounts/`].find((r) => cwd.startsWith(r));
  if (!root) return null;
  const folder = cwd.slice(root.length).split("/")[0];
  return folder && !folder.startsWith(".") ? folder : null;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export default class AccountPane extends View {
  init(_props, cx) {
    if (props()?.editOpp) return this.initEdit(cx);
    this.inTab = Boolean(props()?.folder);
    this.folder = (this.inTab && shared("overview.folder")) || props()?.folder || null;
    this.files = {};
    this.sync = null;
    this.tab = store.get("tab", "overview");
    this.collapsed = new Set(store.get("collapsed", []));
    this.openOpps = new Set();
    this.archiveOpen = store.get("archiveOpen", false);
    this.detailsOpen = store.get("detailsOpen", false);
    this.editing = null; // null: auto (edit when empty), else true / false
    this.note = TextareaState.new({ placeholder: "Quick note: to-dos and reminders", rows: 12 });
    this.note.set_auto_grow?.(12, 40);
    this.noteLoaded = null;
    this.saving = false;
    this.savedAt = null;
    this.note.on("change", (_e, cx) => {
      if (this.noteLoaded === null) return;
      this.editing = true;
      this.dirty = this.note.value();
      this.saveTimer?.cancel?.();
      this.saveTimer = cx.timer.after(AUTOSAVE_MS, async (cx) => { await this.saveNote(); cx.notify(); });
      cx.notify();
    });
    if (checking()) return;
    cx.spawn(async (cx) => { await loadConf(); await this.load(); cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        await watchFolder(ROOT());
        await this.load();
        cx.notify();
      }
    });
    // The sidebar follows whichever chat is focused; the overview tab follows
    // the account last clicked in the Accounts list ("overview.folder").
    cx.timer.every(this.inTab ? 250 : 400, async (cx) => {
      let next;
      if (this.inTab) next = shared("overview.folder");
      else {
        const f = focused();
        if (!f?.terminal) return;
        next = accountOf(terminals().find((x) => x.address === f.terminal));
        this.target = f.terminal;
      }
      if (next && next !== this.folder) await this.switchTo(next, cx);
    });
  }

  async switchTo(folder, cx) {
    // An unsaved note goes to the account it was typed for, before switching.
    this.saveTimer?.cancel?.();
    if (this.dirty !== undefined) await this.saveNote();
    this.dirty = undefined;
    this.folder = folder;
    this.files = {};
    this.openOpps = new Set();
    this.noteLoaded = null;
    this.editing = null;
    await this.load();
    cx.notify();
  }

  async load() {
    const folder = this.folder;
    if (!folder) return;
    if (folder === OPPS) return this.loadAllOpps();
    const dir = `${ROOT()}/${folder}`;
    const read = async (name) => { try { const t = await readTextFile(`${dir}/${name}.json`); return t ? JSON.parse(t) : null; } catch { return null; } };
    const got = Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await read(f)])));
    let sync = null;
    try { sync = JSON.parse((await readTextFile(`${ROOT()}/.sync/status.json`)) ?? "null"); } catch {}
    let bookAt = null;
    try { bookAt = JSON.parse((await readTextFile(`${ROOT()}/book.json`)) ?? "{}").refreshed_at ?? null; } catch {}
    const note = (await readTextFile(`${dir}/${QUICKNOTE}`).catch(() => null)) ?? "";
    if (folder !== this.folder) return;
    this.files = got;
    this.sync = { status: sync, bookAt };
    this.savedNote = note;
    if (this.noteLoaded !== folder || (this.dirty === undefined && this.note.value() !== note)) {
      this.noteLoaded = null;
      this.note.set_value(note);
      this.noteLoaded = folder;
    }
  }

  // Every account's opps.json, each opp tagged with its account.
  async loadAllOpps() {
    const json = async (path) => { try { return JSON.parse((await readTextFile(path)) ?? "null"); } catch { return null; } };
    const roster = (await json(`${ROOT()}/roster.json`)) ?? { accounts: [] };
    const per = await Promise.all((roster.accounts ?? []).filter((a) => a.folder).map(async (a) => ({ a, f: await json(`${ROOT()}/${a.folder}/opps.json`) })));
    const sync = await json(`${ROOT()}/.sync/status.json`);
    const bookAt = (await json(`${ROOT()}/book.json`))?.refreshed_at ?? null;
    if (this.folder !== OPPS) return;
    this.allOpps = {
      rows: per.flatMap(({ a, f }) => (f?.rows ?? []).map((o) => ({ ...o, account: a.name, folder: a.folder }))),
      accounts: per.length,
      unsynced: per.filter(({ f }) => !f).map(({ a }) => a.name),
    };
    this.sync = { status: sync, bookAt };
  }

  // A small on/off switch with its label.
  switch(id, label, on, fn) {
    const t = this.t;
    return h_flex().id(id).flex_none().items_center().gap(6).cursor_pointer().on_click((_e, cx) => fn(cx))
      .child(this.caption(label, { dim: !on }))
      .child(h_flex().w(26).h(15).p(2).rounded(8).bg(on ? t.accent : t.raised).border_1().border_color(on ? t.accent : t.border)
        .when(on, (el) => el.justify_end())
        .child(div().size(9).rounded(5).bg(on ? "#ffffff" : t.dim)));
  }

  // Opportunities across the book: overdue | closing in two weeks | later, by width.
  allOppsView() {
    const all = this.allOpps;
    const showRenewals = store.get("oppsRenewals", true);
    const kept = (all?.rows ?? []).filter((o) => showRenewals || o.recordType !== "Renewal");
    const head = h_flex().items_center().justify_between().gap(8)
      .child(h_flex().items_center().gap(16)
        .child(this.text("Opportunities", { size: 17, weight: "semibold" }))
        .when(Boolean(all), (el) => el.child(this.caption(`${kept.length} open across ${new Set(kept.map((o) => o.account)).size} accounts · ${money(kept.reduce((n, o) => n + (o.amount ?? 0), 0))}`, { dim: true }))))
      .child(h_flex().flex_none().items_center().gap(12)
        .when(Boolean(all?.unsynced.length), (el) => el.child(this.caption(`No opps synced yet for ${all.unsynced.join(", ")}`, { dim: true })))
        .child(this.switch("opps-renewals", "Renewals", showRenewals, (cx) => { store.set("oppsRenewals", !showRenewals); cx.notify(); }))
        .child(this.syncBar(true)));
    if (!all) return [head];
    const rows = [...kept].sort((a, b) => (a.closeDate ?? "9").localeCompare(b.closeDate ?? "9"));
    const when = (o) => daysTo(o.closeDate, this.today);
    // Each opp sits in the first group it fits; "Close date passed" shows only when it has opps.
    const passed = (o) => when(o) !== null && when(o) < 0;
    const soon = (o) => !passed(o) && when(o) !== null && when(o) <= 14;
    const stepLate = (o) => !passed(o) && !soon(o) && (daysTo(o.nextStepDate, this.today) ?? 0) < 0;
    const groups = [
      ["Close date passed", rows.filter(passed), true],
      ["Closing in the next two weeks", rows.filter(soon)],
      ["Next step past due", rows.filter(stepLate)],
      ["Later", rows.filter((o) => !passed(o) && !soon(o) && !stepLate(o))],
    ].filter(([, list, hideEmpty]) => list.length || !hideEmpty);
    const items = groups.flatMap(([title, list]) => [
      this.sectionTitle(`${title} (${list.length})`),
      ...(list.length ? list.map((o) => this.oppCard(o, false, true)) : [this.caption("None.", { dim: true })]),
    ]);
    // One column per group when wide enough, else the usual one to three.
    if (this.width >= 300 * groups.length) {
      const per = groups.map(([title, list]) => v_flex().flex_1().min_w(0).gap(6)
        .child(this.text(`${title} (${list.length})`, { weight: "medium" }))
        .children(list.length ? list.map((o) => this.oppCard(o, false, true)) : [this.caption("None.", { dim: true })]));
      return [head, h_flex().w_full().items_start().gap(20).children(per)];
    }
    return [head, ...this.columns(items)];
  }

  async saveNote() {
    const text = this.dirty;
    if (text === undefined || !this.folder) return;
    this.saving = true;
    const path = `${ROOT()}/${this.folder}/${QUICKNOTE}`;
    try {
      const before = await readTextFile(path).catch(() => null);
      await writeTextFile(path, text, before);
      if (this.dirty === text) this.dirty = undefined;
      this.savedAt = Date.now();
    } catch {}
    this.saving = false;
  }

  async setArchived(key, entry) {
    const path = `${ROOT()}/${this.folder}/signal-state.json`;
    const before = await readTextFile(path).catch(() => null);
    let state = {};
    try { state = before ? JSON.parse(before) : {}; } catch {}
    const archived = { ...(state.archived ?? {}) };
    if (entry) archived[key] = entry; else delete archived[key];
    await writeTextFile(path, JSON.stringify({ ...state, archived }, null, 2) + "\n", before);
    await this.load();
  }

  // Put a prompt where I'll send it: pasted into the focused chat in the sidebar
  // (not sent: Enter is mine), or a new chat in the account's folder from the tab.
  async prompt(text, name) {
    if (!this.inTab && this.target) {
      const old = await exec("pbpaste", []).then((r) => r.stdout, () => null);
      await exec("/bin/sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]);
      run("pane.focus", { terminal: this.target });
      run("terminal.paste", {});
      if (old !== null) await exec("/bin/sh", ["-c", 'sleep 1; printf %s "$1" | pbcopy', "sh", old]);
      return;
    }
    const a = this.files.account;
    // The Opportunities view isn't an account folder: its chats start in ~/work/all-accounts.
    const all = this.folder === ALL || this.folder === OPPS;
    run("tab.new", {
      name: `${all ? "All accounts" : a?.name ?? this.folder} · ${name}`,
      folder: all ? `${home()}/work/${ALL}` : `${ROOT()}/${this.folder}`,
      argv: ["claude", text],
      focus: true,
    });
  }

  open(url) { exec("open", [url]); }

  // --- building blocks -----------------------------------------------------

  text(s, opts = {}, t = this.t) {
    let el = div().text_size(opts.size ?? 12.5).text_color(opts.color ?? (opts.dim ? t.dim : t.foreground));
    if (opts.weight === "medium") el = el.font_medium();
    if (opts.weight === "semibold") el = el.font_semibold();
    if (opts.truncate) el = el.truncate();
    if (opts.strike) el = el.line_through();
    return el.child(s);
  }
  caption(s, opts = {}) { return this.text(s, { size: 11.5, ...opts }); }

  link(id, label, url, opts = {}) {
    const t = this.t;
    if (!url) return div().id(id).text_size(opts.size ?? 12.5).text_color(t.foreground).when(Boolean(opts.weight), (el) => el.font_medium()).child(label);
    return div().id(id).text_size(opts.size ?? 12.5).text_color(t.accent).cursor_pointer()
      .when(Boolean(opts.weight), (el) => el.font_medium())
      .hover((s) => s.underline()).tooltip(url).on_click(() => this.open(url)).child(label);
  }

  button(id, label, fn, opts = {}) {
    const t = this.t;
    return div().id(id).flex_none().text_size(opts.size ?? 11.5).text_color(opts.dim === false ? t.foreground : t.dim).cursor_pointer()
      .when(Boolean(opts.weight), (el) => el.font_medium())
      .when(Boolean(opts.underline), (el) => el.underline())
      .hover((s) => s.text_color(t.foreground)).when(Boolean(opts.tip), (el) => el.tooltip(opts.tip))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(label);
  }

  card(id) {
    return v_flex().id(id).px(10).py(7).gap(2).rounded(8).border_1().border_color(this.t.border).bg(this.t.surface);
  }

  // A small bar chart: one bar per point, its label as a tooltip.
  // A line chart like the account-pane plugin's: a thin line through a small
  // dot per point, scaled to the points' own range so the shape shows. The
  // line is drawn in percentages, so it stretches to the column's width; the
  // dots sit on a row spread edge to edge, which lines them up with it.
  chart(id, points, color = BLUE) {
    if (points.length < 2) return null;
    const H = 34, PAD = 5;
    const vals = points.map((p) => p.amount);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = hi - lo || Math.max(hi, 1);
    const y = (v) => PAD + (1 - (v - lo + (hi === lo ? span / 2 : 0)) / span) * (H - PAD * 2);
    const line = PathBuilder.stroke(1.5);
    points.forEach((p, i) => {
      const x = `${(i / (points.length - 1)) * 100}%`;
      if (i) line.line_to(x, y(p.amount)); else line.move_to(x, y(p.amount));
    });
    return div().relative().w_full().h(H).mt(2).px(3)
      .child(div().absolute().top(0).bottom(0).left(3).right(3).child(window.paint_path(line.build(), color)))
      .child(h_flex().absolute().top(0).bottom(0).left(3).right(3).justify_between().children(points.map((p) =>
        div().relative().w(0).h_full().child(div().absolute().size(5).rounded(3).bg(color).top(y(p.amount) - 2.5).left(-2.5)))))
      .child(h_flex().absolute().inset_0().children(points.map((p, i) =>
        div().id(`${id}-${i}`).flex_1().h_full().tooltip(`${p.x}: ${money(p.amount)}`))));
  }

  syncAge(key, iso) {
    const age = iso ? Date.now() - Date.parse(iso) : NaN;
    return h_flex().gap(6).items_center()
      .when(!Number.isNaN(age), (el) => el.child(this.caption(ago(age), { color: age < STALE_MS ? this.t.dim : AMBER })))
      .child(this.button(`reload-${key}`, "↻", (cx) => this.load().then(() => cx.notify()), { tip: "Re-read the files (doesn't sync)" }));
  }

  // In the overview tab, a section (or a section title) starts a new block,
  // and blocks are laid out in one to three columns by the tab's width.
  starts(el) {
    this.blockStarts.add(el);
    return el;
  }

  columns(items) {
    const blocks = [];
    for (const el of items) {
      if (!blocks.length || this.blockStarts.has(el)) blocks.push([]);
      blocks.at(-1).push(el);
    }
    const n = Math.min(blocks.length, this.width >= 1180 ? 3 : this.width >= 760 ? 2 : 1);
    if (n <= 1) return items;
    // Each block goes to the shortest column so far (by rough height: its items).
    const cols = Array.from({ length: n }, () => ({ weight: 0, els: [] }));
    for (const b of blocks) {
      const c = cols.reduce((m, x) => (x.weight < m.weight ? x : m));
      c.els.push(...b);
      c.weight += 1 + b.length;
    }
    return [h_flex().w_full().items_start().gap(28).children(cols.map((c) => v_flex().flex_1().min_w(0).gap(10).children(c.els)))];
  }

  sectionTitle(title, extra) {
    return this.starts(h_flex().mt(4).justify_between().items_center()
      .child(this.text(title, { weight: "medium" }))
      .when(Boolean(extra), (el) => el.child(extra)));
  }

  // An overview section that folds; "All …" jumps to its tab.
  section(id, title, body, more, extra) {
    const open = !this.collapsed.has(id);
    return this.starts(v_flex().gap(6).child(h_flex().mt(4).justify_between().items_center()
      .child(this.button(`toggle-${id}`, `${title} ${open ? "▾" : "▸"}`, (cx) => {
        if (open) this.collapsed.add(id); else this.collapsed.delete(id);
        store.set("collapsed", [...this.collapsed]);
        cx.notify();
      }, { size: 12, weight: true, dim: false }))
      .child(h_flex().gap(8).items_center()
        .when(open && Boolean(extra), (el) => el.child(extra))
        .when(Boolean(more), (el) => el.child(this.button(`more-${id}`, `${more?.label} →`, (cx) => this.go(more.to, cx))))))
      .when(open, (el) => el.child(body)));
  }

  go(tab, cx) { this.tab = tab; store.set("tab", tab); cx.notify(); }

  notSynced() { return this.caption("Not synced yet. Ask Claude to sync your accounts.", { dim: true }); }

  // --- pieces --------------------------------------------------------------

  signalCard(sig, key, action, archived = false) {
    const t = this.t;
    return this.card(key)
      .child(h_flex().gap(6).items_start()
        .child(div().id(`${key}-light`).flex_none().text_size(12).font_medium().tooltip(SIGNAL_LEGEND).child(`${LIGHT[sig.level] ?? "⚪"} P${sig.priority ?? 3}`))
        .child(div().flex_1().min_w(0).text_size(12).font_medium().text_color(archived ? t.dim : t.foreground)
          .child(`${sig.title}${isNew(sig, this.today) ? " · new" : ""}`))
        .when(Boolean(action), (el) => el.child(this.button(`${key}-act`, action.label, action.fn, { tip: action.tip }))))
      .child(this.caption(sig.evidence ?? "", { dim: true }))
      .when(!archived && Boolean(sig.play), (el) => el.child(this.caption(sig.play)));
  }

  archiveSignal(sig) {
    return this.setArchived(archiveKey(sig), { archived_at: new Date().toISOString().slice(0, 10), signal: sig });
  }

  // Dates that need attention: a close date that's passed or a next step that's
  // overdue is red; closing within two weeks or a next step within two days is orange.
  // `compact` (the Opportunities view): tighter, with the dates and next step on one line.
  oppCard(o, detailed, compact = false) {
    const t = this.t;
    const closeIn = daysTo(o.closeDate, this.today);
    const stepIn = daysTo(o.nextStepDate, this.today);
    const closeColor = closeIn === null ? t.dim : closeIn < 0 ? RED : closeIn <= 14 ? ORANGE : t.dim;
    const stepColor = stepIn === null ? t.dim : stepIn < 0 ? RED : stepIn <= 2 ? ORANGE : t.foreground;
    // No amount, or Salesforce's $100k placeholder: yellow, it needs sizing.
    const amountColor = !o.amount || o.amount === PLACEHOLDER_AMOUNT ? YELLOW : t.dim;
    const latest = latestStep(o.nextStep);
    const open = this.openOpps.has(o.id);
    const step = detailed ? o.nextStep : open ? latest : null;
    const date = `Next step: ${o.nextStepDate ? day(o.nextStepDate, this.year) : "no date set"}`;
    const toggle = !detailed && Boolean(latest) ? this.button(`step-${o.id}`, open ? "▾" : "▸", (cx) => {
      if (open) this.openOpps.delete(o.id); else this.openOpps.add(o.id);
      cx.notify();
    }) : null;
    const closes = this.caption(o.closeDate ? `closes ${day(o.closeDate, this.year)}` : "no close date", { color: closeColor });
    const card = compact ? v_flex().id(`opp-${o.id}`).px(9).py(5).gap(1).rounded(6).border_1().border_color(t.border).bg(t.surface) : this.card(`opp-${o.id}`);
    // The pencil opens the Edit opportunity dialog (opp-edit.js).
    const title = (size) => h_flex().items_center().gap(6)
      .child(div().flex_1().min_w(0).child(this.link(`opp-l-${o.id}`, o.name, sfdcUrl("Opportunity", o.id), { weight: true, size })))
      .child(div().id(`opp-edit-${o.id}`).flex_none().size(20).flex().items_center().justify_center().rounded(4).cursor_pointer()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Edit in Salesforce")
        .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "tam-account-pane", kind: "dialog", width: 520, props: { editOpp: { ...o, folder: o.folder ?? this.folder } } }); })
        .child(svg("mods/tam-account-pane/pencil.svg").size(13)));
    if (compact) return card
      .child(title(12))
      .child(h_flex().flex_wrap().items_center().gap(4)
        .child(this.caption(`${o.stage} ·`, { dim: true, size: 11 }))
        .child(this.caption(money(o.amount), { color: amountColor, size: 11 }))
        .child(this.caption("·", { dim: true, size: 11 }))
        .child(this.caption(o.closeDate ? `closes ${day(o.closeDate, this.year)}` : "no close date", { color: closeColor, size: 11 }))
        .child(this.caption("·", { dim: true, size: 11 }))
        .child(this.caption(o.nextStepDate ? `next step ${day(o.nextStepDate, this.year)}` : "no next step date", { color: stepColor, size: 11 }))
        .when(Boolean(toggle), (el) => el.child(toggle)))
      .when(Boolean(step), (el) => el.child(this.caption(step, { size: 11 })));
    return card
      .child(title(undefined))
      .child(h_flex().flex_wrap().gap(4)
        .child(this.caption(`${o.stage} ·`, { dim: true }))
        .child(this.caption(money(o.amount), { color: amountColor }))
        .child(this.caption("·", { dim: true }))
        .child(closes))
      .when(detailed && Boolean(o.recordType), (el) => el.child(this.caption(o.recordType, { dim: true })))
      .child(h_flex().gap(6).items_center()
        .child(this.caption(date, { color: stepColor }))
        .when(Boolean(toggle), (el) => el.child(toggle)))
      .when(Boolean(step), (el) => el.child(this.caption(step)));
  }

  personCard(p, detailed, prefix = "person", isNewUser = false) {
    const facts = [
      p.role,
      p.areas?.length ? p.areas.join(", ") : null,

      p.last_active ? `last seen ${day(p.last_active, this.year)}` : null,
    ].filter(Boolean);
    const reasons = detailed ? p.reasons ?? [] : (p.reasons ?? []).slice(0, 1);
    return this.card(`${prefix}-${p.email}`)
      .child(h_flex().gap(6).items_center().justify_between()
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().min_w(0).child(this.text(p.name, { weight: "medium", truncate: true })))
          // A new user gets a small orange "new · Nov 18" tag (their sign-up date).
          .when(isNewUser, (el) => el.child(div().flex_none().px(5).rounded(4).border_1().border_color(ORANGE).text_size(10.5).text_color(ORANGE)
            .child(`new · ${day(p.signed_up ?? p.joined_at, this.year)}`))))
        .child(this.button(`${prefix}-draft-${p.email}`, "Draft", () => this.prompt(outreachPrompt(this.files.account, p, isNewUser), `Draft for ${p.name}`),
          { tip: this.inTab ? "Start a chat that drafts outreach (sends nothing)" : "Put an outreach prompt in this chat (press Enter to draft)" })))
      .child(this.caption(facts.join(" · "), { dim: true }))
      .when(reasons.length > 0, (el) => el.child(this.caption(reasons.join(" · "))));
  }

  productRow(p) {
    return v_flex().gap(1)
      .child(h_flex().justify_between().gap(6)
        .child(h_flex().flex_1().min_w(0).gap(4).child(this.text(p.name, { truncate: true })).child(this.text(`· ${money(p.latest)}`, { dim: true })))
        .when(p.change_pct !== null && p.change_pct !== undefined, (el) => el.child(div().id(`pct-${p.name}`).flex_none().text_size(12.5)
          .text_color(p.change_pct >= 0 ? GREEN : RED).tooltip(changeBasis(p)).child(signed(p.change_pct)))))
      .child(this.chart(`chart-${p.name}`, chartPoints(p, this.year)));
  }

  trendLines(sp, withFree) {
    const up = trending(sp, 1);
    const down = trending(sp, -1);
    const free = withFree ? freeTierSummary(sp) : null;
    return [
      up.length ? this.caption(`Growing: ${up.join(", ")}`, { color: GREEN }) : null,
      down.length ? this.caption(`Shrinking: ${down.join(", ")}`, { color: RED, weight: "medium" }) : null,
      free ? this.caption(free, { dim: true }) : null,
    ].filter(Boolean);
  }

  nextInvoice(sp) {
    return sp.next_invoice
      ? this.text(`Next invoice: ${day(sp.next_invoice.date, this.year)} · ${money(sp.next_invoice.amount)}${sp.next_invoice.is_estimate ? " est." : ""}`)
      : this.text("No upcoming invoice", { dim: true });
  }

  creditBlock(sp, c, detailed) {
    const out = c.left <= 0;
    const early = !out && (c.days_short ?? 0) >= 30;
    const monthsTo = (iso) => {
      const m = (Date.parse(iso) - Date.parse(this.today)) / (30.4 * 864e5);
      return m >= 0 ? ` (${m.toFixed(1)} months)` : "";
    };
    const term = [
      c.contract_month && c.contract_months ? `Month ${c.contract_month} of ${c.contract_months}` : null,
      c.expires ? `expires ${day(c.expires, this.year)}` : c.contract_end ? `ends ${day(c.contract_end, this.year)}` : null,
    ].filter(Boolean);
    const forecast = sp.next_invoice?.amount;
    return v_flex().gap(3)
      .child(out
        ? this.text("Out of credit · billed at list price", { color: RED, weight: "medium" })
        : h_flex().gap(4).child(this.text(`Credit left: ${money(c.left)}`))
          .when(c.days_left !== null && c.days_left !== undefined, (el) => el.child(this.text(`· ${c.days_left} days`, { color: early ? RED : undefined }))))
      .when(term.length > 0, (el) => el.child(this.caption(term.join(" · "), { dim: true })))
      .when(out && Boolean(c.burn), (el) => el.child(this.caption(`Using ${money(c.burn)}/month${c.contract_end ? ` until ${day(c.contract_end, this.year)}` : ""}`, { dim: true })))
      .when(!out && detailed && Boolean(c.runs_out), (el) => el.child(this.caption(
        `Runs out ${day(c.runs_out, this.year)}${monthsTo(c.runs_out)} at last month's usage${c.burn ? ` (${money(c.burn)}/month)` : ""}`, { color: early ? RED : this.t.dim })))
      .when(!out && detailed && Boolean(c.runs_out_forecast), (el) => el.child(this.caption(
        `Runs out ${day(c.runs_out_forecast, this.year)}${monthsTo(c.runs_out_forecast)} at this month's forecast${forecast ? ` (${money(forecast)}/month)` : ""}`, { dim: true })));
  }

  monthlyBlock(sp) {
    const h = sp.invoice_history ?? [];
    const last = h[h.length - 1];
    const before = h[h.length - 2];
    const change = last && before && before.amount > 0 ? ((last.amount - before.amount) / before.amount) * 100 : null;
    const avg = (n) => (h.length >= n ? h.slice(-n).reduce((t, x) => t + x.amount, 0) / n : null);
    const pitch = sp.annual_pitch;
    return v_flex().gap(3)
      .child(this.text(last ? `Last invoice: ${day(last.date, this.year)} · ${money(last.amount)}${change !== null ? ` ${signed(change)} vs ${day(before.date, this.year)}` : ""}` : "No invoices yet"))
      .when(avg(3) !== null, (el) => el.child(this.caption(`3-month avg ${money(avg(3))}${avg(6) !== null ? ` · 6-month avg ${money(avg(6))}` : ""}`, { dim: true })))
      .child(this.nextInvoice(sp))
      .when(Boolean(pitch), (el) => el.child(this.caption(`${pitch.self_serve
        ? `Annual pitch: ${money(pitch.credit)}/yr of credit saves ${money(pitch.savings)} (${pitch.discount_pct}% self-serve)`
        : `Annual pitch: ${money(pitch.credit)}/yr of credit saves ${money(pitch.savings)}–${money(pitch.max_savings)} (${pitch.discount_pct}–${pitch.max_pct}%)`} (based on the last 3 months' invoices)`)));
  }

  billing(sp, detailed) {
    const annual = sp.plan === "annual" && sp.credits;
    const history = this.chart("invoices", (sp.invoice_history ?? []).map((x) => ({ x: `Invoice ${day(x.date, this.year)}`, amount: x.amount })), annual ? GREEN : BLUE);
    if (annual) return v_flex().gap(4).child(this.creditBlock(sp, sp.credits, detailed)).when(detailed && Boolean(history), (el) => el.child(history));
    if (sp.invoice_history) return v_flex().gap(4).child(this.monthlyBlock(sp)).when(Boolean(history), (el) => el.child(history));
    return v_flex().child(this.nextInvoice(sp));
  }

  scoutCard(sc) {
    const people = (sc.contacts ?? []).map((c) => `${c.name ?? c.email ?? ""}${c.best ? " (best first contact)" : ""}`).filter(Boolean).join(", ");
    return this.card(`scout-${sc.id}`).gap(3)
      .child(this.caption(`${SCOUT_LABEL[sc.source] ?? sc.source}${sc.date ? ` · ${day(sc.date, this.year)}` : ""}`, { dim: true }))
      .child(this.link(`scout-l-${sc.id}`, sc.title, sc.url, { weight: true }))
      .when(Boolean(sc.summary), (el) => el.child(this.caption(sc.summary, { dim: true })))
      .when(Boolean(sc.size), (el) => el.child(this.caption(`Estimated size: ${sc.size}`, { dim: true })))
      .when(Boolean(sc.action), (el) => el.child(this.caption(`Do this: ${sc.action}`)))
      .when(Boolean(people), (el) => el.child(this.caption(`Contacts: ${people}`, { dim: true })));
  }

  // inline: the overview tab's header version (no gap above, no stretching).
  syncBar(inline = false) {
    const { status, bookAt } = this.sync ?? {};
    const now = Date.now();
    const since = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? ago(now - Date.parse(iso)) : null);
    const dataAt = status?.last_ok_at ?? bookAt;
    const running = Boolean(status?.started_at) && !status?.finished_at;
    const stuck = running && now - Date.parse(status.started_at) > SYNC_STUCK_MS;
    const failed = status?.finished_at ? status.failed ?? [] : [];
    let line;
    let bad = false;
    if (stuck) { line = `The last sync (${since(status.started_at)}) didn't finish.${dataAt ? ` Data is from ${since(dataAt)}.` : ""}`; bad = true; }
    else if (running) line = `Syncing… started ${since(status.started_at)}`;
    else if (failed.length) {
      line = `${failed.includes("all") ? "The last sync failed" : `The last sync failed for ${failed.join(", ")}`}${status.note ? `: ${status.note}` : ""}.${dataAt ? ` Data is from ${since(dataAt)}.` : ""}`;
      bad = true;
    } else line = dataAt ? `Synced ${since(dataAt)}` : "Not synced yet";
    return h_flex().when(!inline, (el) => el.mt(6).justify_between()).items_start().gap(inline ? 10 : 8)
      .child(div().when(!inline, (el) => el.flex_1()).min_w(0).child(this.caption(line, { color: bad ? RED : this.t.dim })))
      .when(!running || stuck, (el) => el.child(this.button("sync-now", "Sync now", () => this.prompt("/account-pane:sync", "Sync"),
        { underline: true, tip: this.inTab ? "Start a chat that runs the sync" : "Put /account-pane:sync in this chat (press Enter to start)" })));
  }

  // A quick note's Markdown, drawn simply: headings, bullets, the rest plain.
  noteView(text) {
    return v_flex().gap(1).children(text.split("\n").map((raw) => {
      const h = raw.match(/^#{1,6}\s+(.*)$/);
      const b = raw.match(/^(\s*)[-*+]\s+(.*)$/);
      const body = h ? h[1] : b ? `${b[1]}• ${b[2]}` : raw;
      return this.text(body.replace(/\*\*([^*]+)\*\*|`([^`]+)`/g, "$1$2") || " ", { weight: h ? "semibold" : undefined });
    }));
  }

  // --- tabs ----------------------------------------------------------------

  overview(a) {
    const f = this.files;
    const spend = f.spend;
    const live = this.liveSignals();
    const opps = this.opps();
    const people = f.people;
    // The overview tab has room for everything; the sidebar keeps the first few.
    const sigN = this.inTab ? Infinity : OVERVIEW_SIGNALS;
    const oppN = this.inTab ? Infinity : OVERVIEW_OPPS;
    const who = !people ? [] : this.inTab
      ? (() => {
        // Each person once: someone on both lists keeps their main card, tagged new.
        const fresh = new Map((people.new_users ?? []).map((p) => [p.email, p]));
        const main = (people.people ?? []).map((p) => (fresh.has(p.email) ? [{ ...p, signed_up: p.signed_up ?? fresh.get(p.email).signed_up }, true] : [p, false]));
        const seen = new Set((people.people ?? []).map((p) => p.email));
        return [...main, ...[...fresh.values()].filter((p) => !seen.has(p.email)).map((p) => [p, true])];
      })()
      : overviewPeople(people);
    const prodN = this.inTab ? Infinity : OVERVIEW_PRODUCTS;
    const sections = {
      // The overview tab shows links and the team beside the account's name instead.
      links: this.inTab ? null : this.section("links", "Links", v_flex().gap(4).child(this.linkRow(a))
        .when(Boolean(this.teamLine(a)), (el) => el.child(this.caption(this.teamLine(a), { dim: true })))),
      spend: this.section("spend", "Spend", spend
        ? v_flex().gap(6).child(this.billing(spend, false)).children(spend.products.slice(0, prodN).map((p) => this.productRow(p))).children(this.trendLines(spend, false))
        : this.notSynced(),
        spend && spend.products.length > prodN ? { label: "All spend", to: "spend" } : null),
      signals: this.section("signals", "Signals", !f.signals ? this.notSynced() : !live.length ? this.caption("Nothing that matters right now.", { dim: true })
        : v_flex().gap(6).children(live.slice(0, sigN).map((s) => this.signalCard(s, `ov-sig-${s.id}`, { label: "✕", tip: "Archive", fn: () => this.archiveSignal(s) }))),
        live.length > sigN ? { label: `All ${live.length} signals`, to: "signals" } : null),
      opps: this.section("opps", "Opportunities", !a.sfdc_id ? this.caption("No Salesforce account linked in Customer Analytics.", { dim: true })
        : !f.opps ? this.notSynced() : !opps.length ? this.caption("No open opportunities.", { dim: true })
        : v_flex().gap(6).children(opps.slice(0, oppN).map((o) => this.oppCard(o, false))),
        opps.length > oppN ? { label: `All ${opps.length}`, to: "opps" } : null,
        a.sfdc_id ? this.syncAge("opps", f.opps?.fetched_at) : null),
      people: this.section("people", "People", !people ? this.notSynced() : !people.people?.length && !people.new_users?.length ? this.caption("No active members found for this account.", { dim: true })
        : v_flex().gap(6).children(who.map(([p, fresh]) => this.personCard(p, false, fresh ? "ov-new" : "ov-person", fresh))),
        people && !this.inTab ? { label: `All ${(people.people?.length ?? 0) + (people.new_users?.length ?? 0)} people`, to: "people" } : null),
    };
    if (!this.inTab) return [sections.links, sections.spend, sections.signals, sections.opps, sections.people];
    // The overview tab: opportunities and signals | spend | people, by width.
    const col = (els) => v_flex().flex_1().min_w(0).gap(10).children(els);
    const n = this.width >= 1180 ? 3 : this.width >= 760 ? 2 : 1;
    const groups = n === 3 ? [[sections.opps, sections.signals], [sections.spend], [sections.people]]
      : n === 2 ? [[sections.opps, sections.signals, sections.people], [sections.spend]]
      : [[sections.opps, sections.signals, sections.spend, sections.people]];
    return [h_flex().w_full().items_start().gap(28).children(groups.map(col))];
  }

  linkRow(a) {
    return h_flex().flex_wrap().gap(4).items_center().children(accountLinks(a).flatMap(([label, href], i) => [
      i > 0 ? this.text("·", { dim: true }) : null,
      href ? this.link(`link-${label}`, label, href) : this.text(label, { dim: true }),
    ].filter(Boolean)));
  }

  teamLine(a) {
    return a.team?.length ? a.team.map((x) => `${x.role}: ${x.name}`).join(" · ") : a.csm ? `CSM: ${a.csm.name}` : "";
  }

  spendTab() {
    const sp = this.files.spend;
    if (!sp) return [this.notSynced()];
    const annual = sp.plan === "annual" && sp.credits;
    return [
      this.sectionTitle("Spend by product", this.syncAge("spend", sp.fetched_at)),
      ...(sp.products.length ? sp.products.map((p) => this.productRow(p)) : [this.caption("No product spend on recent invoices.", { dim: true })]),
      v_flex().gap(4)
        .child(this.button("toggle-details", `Details ${this.detailsOpen ? "▾" : "▸"}`, (cx) => { this.detailsOpen = !this.detailsOpen; store.set("detailsOpen", this.detailsOpen); cx.notify(); }, { size: 12, weight: true, dim: false }))
        .when(this.detailsOpen, (el) => el.children(this.trendLines(sp, true)).child(this.caption(notUsingSummary(sp), { dim: true }))),
      this.sectionTitle(annual ? "Credit & Invoices" : "Invoices"),
      this.billing(sp, true),
    ];
  }

  oppsTab(a) {
    if (!a.sfdc_id) return [this.caption("No Salesforce account linked in Customer Analytics.", { dim: true })];
    const opps = this.opps();
    const titles = this.liveSignals().map((s) => s.title);
    return [
      this.sectionTitle(`Open opportunities (${opps.length})`, this.syncAge("opps", this.files.opps?.fetched_at)),
      ...(!this.files.opps ? [this.notSynced()] : !opps.length ? [this.caption("No open opportunities.", { dim: true })] : opps.map((o) => this.oppCard(o, true))),
      this.sectionTitle("Skills"),
      ...TEAM_SKILLS.map((s) => h_flex().gap(8).items_center()
        .child(this.button(`skill-${s.name}`, s.label, () => this.prompt(skillPrompt(a, s, titles), s.label), { size: 12, weight: true, dim: false, underline: true }))
        .child(div().flex_1().min_w(0).child(this.caption(s.what, { dim: true, truncate: true })))),
      this.caption("Each runs the newest version from PostHog's team skills.", { dim: true }),
    ];
  }

  signalsTab() {
    const f = this.files;
    const shown = this.liveSignals();
    const archived = f["signal-state"]?.archived ?? {};
    const cutoff = Date.now() - ARCHIVE_VIEW_DAYS * 864e5;
    const past = Object.entries(archived).filter(([, x]) => Date.parse(x.signal.first_seen) >= cutoff).sort(([, x], [, y]) => y.archived_at.localeCompare(x.archived_at));
    const scouts = f.scouts?.scouts ?? [];
    return [
      this.sectionTitle(`Signals (${shown.length})`, f.signals ? this.syncAge("signals", f.signals.fetched_at) : null),
      ...(!f.signals ? [this.notSynced()] : !shown.length
        ? [this.caption("Nothing that matters right now. Signals only show for moves that are large for this account's size.", { dim: true })]
        : shown.map((s) => this.signalCard(s, `sig-${s.id}`, { label: "✕", tip: "Archive", fn: () => this.archiveSignal(s) }))),
      this.sectionTitle(`Slack Scouts (${scouts.length})`, f.scouts ? this.syncAge("scouts", f.scouts.fetched_at) : null),
      ...(!f.scouts ? [this.notSynced()] : !scouts.length ? [this.caption("No scout, cross-sell or spike posts about this account in the last 30 days.", { dim: true })] : scouts.map((s) => this.scoutCard(s))),
      ...(past.length ? [
        this.button("toggle-archived", `Archived (${past.length}) ${this.archiveOpen ? "▾" : "▸"}`, (cx) => { this.archiveOpen = !this.archiveOpen; store.set("archiveOpen", this.archiveOpen); cx.notify(); }, { size: 12, weight: true }),
        ...(this.archiveOpen ? past.map(([key, x]) => this.signalCard(x.signal, `arch-${key}`, { label: "↩", tip: "Restore", fn: () => this.setArchived(key, null) }, true)) : []),
      ] : []),
    ];
  }

  peopleTab() {
    const f = this.files.people;
    const people = f?.people ?? [];
    return [
      this.sectionTitle("Who to engage", f ? this.syncAge("people", f.fetched_at) : null),
      ...(!f ? [this.notSynced()] : !people.length ? [this.caption("No active members found for this account.", { dim: true })] : people.map((p) => this.personCard(p, true))),
      ...(f?.new_users ? [
        this.sectionTitle("New to PostHog"),
        ...(f.new_users.length ? f.new_users.map((p) => this.personCard(p, true, "new", true)) : [this.caption("No one here signed up to PostHog in the last 30 days.", { dim: true })]),
      ] : []),
    ];
  }

  notesTab(a) {
    const t = this.t;
    const ca = this.files["ca-notes"];
    const text = this.dirty ?? this.savedNote ?? "";
    const editing = this.editing ?? text.trim() === "";
    const status = this.caption(this.saving || this.dirty !== undefined ? "Saving…" : this.savedAt ? `Saved ${ago(Date.now() - this.savedAt)} to ${QUICKNOTE}` : `Saves automatically to ${QUICKNOTE} in this folder`, { dim: true });
    return [
      this.sectionTitle("Customer Analytics notes", ca ? this.syncAge("ca-notes", ca.fetched_at) : null),
      ...(!ca ? [this.notSynced()] : !ca.notes.length ? [this.caption("No notes on this account yet.", { dim: true })]
        : ca.notes.map((n) => v_flex().child(this.link(`ca-${n.id}`, n.title, n.url)).child(this.caption([day(n.created_at, this.year), n.author].filter(Boolean).join(" · "), { dim: true })))),
      ...(caUrl(a.account_id) ? [this.link("ca-all", "All notes in Customer Analytics", caUrl(a.account_id))] : []),
      this.sectionTitle("Quick notes"),
      editing
        ? Textarea.new(this.note).w_full().min_h(180).p(8).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground)
        : this.card("quicknote").child(text.trim() ? this.noteView(text) : this.text("No quick note yet.", { dim: true })),
      h_flex().gap(10).items_center()
        .child(editing
          ? this.button("note-save", "Save", async (cx) => { this.saveTimer?.cancel?.(); await this.saveNote(); this.editing = false; await this.load(); cx.notify(); }, { underline: true, dim: false })
          : this.button("note-edit", "Edit", (cx) => { this.editing = true; this.note.focus(); cx.notify(); }, { underline: true, dim: false }))
        .child(status),
    ];
  }

  liveSignals() {
    const archived = this.files["signal-state"]?.archived ?? {};
    return (this.files.signals?.signals ?? []).filter((s) => !(archiveKey(s) in archived));
  }

  opps() {
    return [...(this.files.opps?.rows ?? [])].sort((a, b) => (a.closeDate ?? "").localeCompare(b.closeDate ?? ""));
  }

  render() {
    if (this.edit) return this.renderEdit();
    const t = (this.t = theme());
    this.today = new Date().toISOString().slice(0, 10);
    this.year = this.today.slice(0, 4);
    const a = this.files.account;
    this.blockStarts = new WeakSet();
    const frame = (inner) => this.inTab
      ? div().size_full().bg(t.background).text_color(t.foreground).on_size_change((size, cx) => {
        if (Math.abs(size.width - (this.width ?? 0)) > 1) { this.width = size.width; cx.notify(); }
      }).child(v_flex().id("ap-scroll").size_full().overflow_y_scrollbar().child(v_flex().w_full().px(24).py(18).gap(10).children(inner)))
      : v_flex().id("ap-root").size_full().rounded(10).border_1().border_color(t.border).bg(t.background).text_color(t.foreground)
        .child(v_flex().id("ap-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().px(12).py(10).gap(9).children(inner)));
    if (this.folder === OPPS) return frame(this.allOppsView());
    // All accounts gets its own overview later; for now, a placeholder.
    if (this.folder === ALL) return frame([this.text("All accounts", { size: 17, weight: "semibold" }),
      this.caption("The overview across your whole book will go here.", { dim: true })]);
    if (!a) return frame([this.caption(this.folder ? "This account hasn't been synced yet. Ask Claude to sync your accounts." : "Focus a chat inside an account to see it here.", { dim: true })]);

    const tabs = h_flex().gap(3).children(TABS.map(([key, icon, label]) => h_flex().id(`tab-${key}`).flex_1().h(26).justify_center().items_center().gap(5).rounded(6)
      .cursor_pointer().text_size(12.5).tooltip(label)
      .bg(this.tab === key ? t.selected : t.raised).text_color(this.tab === key ? t.foreground : t.dim)
      .when(this.tab !== key, (el) => el.opacity(0.7))
      .hover((s) => s.opacity(1))
      .on_click((_e, cx) => this.go(key, cx))
      .child(icon).when(this.inTab, (el) => el.child(label))));

    const head = h_flex().items_center().justify_between().gap(8)
      .child(h_flex().flex_1().min_w(0).items_center().gap(16)
        .child(div().flex_none().child(this.text(a.name, { size: this.inTab ? 17 : 13.5, weight: "semibold", truncate: true })))
        .when(this.inTab, (el) => el.child(div().min_w(0).child(this.linkRow(a)))
          .when(Boolean(this.teamLine(a)), (el) => el.child(div().flex_none().child(this.caption(this.teamLine(a), { dim: true }))))))
      .when(!this.inTab && Boolean(caUrl(a.account_id)), (el) => el.child(this.button("open-ca", "Customer Analytics ↗", () => this.open(caUrl(a.account_id)), { tip: "Open in your browser" })))
      // In the overview tab, the sync status sits at the header's right, or under it when narrow.
      .when(this.inTab && this.width >= 1100, (el) => el.child(div().flex_none().child(this.syncBar(true))));
    const syncLine = this.inTab && !(this.width >= 1100) ? [h_flex().w_full().justify_end().mt(-6).child(this.syncBar(true))] : [];

    const body = this.tab === "spend" ? this.spendTab()
      : this.tab === "opps" ? this.oppsTab(a)
      : this.tab === "signals" ? this.signalsTab()
      : this.tab === "people" ? this.peopleTab()
      : this.tab === "notes" ? this.notesTab(a)
      : this.overview(a);
    const foot = this.tab === "overview" && !this.inTab ? [this.syncBar()] : [];
    return frame([head, ...syncLine, tabs, ...(this.inTab && this.tab !== "overview" ? this.columns(body) : body), ...foot]);
  }
}

Object.assign(AccountPane.prototype, editMethods);
