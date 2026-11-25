// My book: the accounts where I'm the TAM in Customer Analytics, as a
// tree. Each account holds folders and tasks; checking a task moves it to the
// account's archive, and a task can point at the agent working on it.
//
// Reads ~/work/accounts/roster.json (written by the weekly check, .sync/roster.py) and
// each account's tasks.json: { folders: ["a", "a/b"], tasks: [...], archive: [...] }.
// The same mod draws its own menus and dialogs (props().menu / props().dialog).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { home, theme, terminals, agents, run, openOverlay, closeOverlay, props, readTextFile, writeTextFile, watchFolder, exec, checking, layout, nextCommand, spaces, focused, shared, setShared } from "herdr";

const WORK = () => `${home()}/work`;
const ROOT = () => `${WORK()}/accounts`;
// ~/.config/tam-herdr/config.json (kept out of the shared repo): the Customer Analytics
// project's URL, and more workspaces for the Work section ({name, folder} in ~/work).
let CA_BASE = null;
let EXTRA_WORK = [];
const loadConf = () => readTextFile(`${home()}/.config/tam-herdr/config.json`)
  .then((t) => {
    const c = JSON.parse(t ?? "{}") ?? {};
    CA_BASE = c.posthog_project_url?.replace(/\/+$/, "") ?? null;
    EXTRA_WORK = (c.work_spaces ?? []).filter((w) => w?.name && w?.folder && w.folder !== ALL && !w.folder.includes("/"));
  }, () => null);
// "All accounts": book-wide work, listed first. It's an account like the others
// (folders, tasks, chats) but lives in ~/work/all-accounts and has no account pane.
const ALL = "all-accounts";
const ALL_ACCOUNT = { name: "All accounts", folder: ALL };
// All accounts > Opportunities opens an overview of every account's opps.
const OPPS_FOLDER = "Opportunities";
const OPPS = { name: "Opportunities", folder: "all-accounts:opportunities" };
// The Work section: All accounts, then other workspaces that aren't accounts
// (~/work/<folder>, no account pane, clicking the name folds it).
let WORK_SPACES = [ALL_ACCOUNT];
const isWork = (folder) => WORK_SPACES.some((w) => w.folder === folder);
const dirOf = (folder) => (isWork(folder) ? `${WORK()}/${folder}` : `${ROOT()}/${folder}`);
// The account folder a path is in (~/accounts is a link to ~/work/accounts).
function folderOf(cwd) {
  for (const root of [`${ROOT()}/`, `${home()}/accounts/`]) {
    if (!cwd?.startsWith(root)) continue;
    const f = cwd.slice(root.length).split("/")[0];
    return f && !f.startsWith(".") ? f : null;
  }
  return WORK_SPACES.find((w) => cwd === dirOf(w.folder) || cwd?.startsWith(`${dirOf(w.folder)}/`))?.folder ?? null;
}
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const INDENT = 14;
// Task indicators: an agent working (yellow, breathing), waiting on me (light red),
// finished or marked unread (blue). Folders and accounts stack their tasks' dots.
const DOT = { blocked: "#f28b82", working: "#e8b422", done: "#4c8df6", unread: "#4c8df6" };
const URGENCY = ["blocked", "working", "done", "unread"];
const MAX_DOTS = 4;
const ROW = 26;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const empty = () => ({ folders: [], tasks: [], archive: [] });
// How long a task has been around: 5m, 3h, 2d, 1w, 1M, 4M (from created_at).
function age(iso) {
  const ms = Date.now() - Date.parse(iso ?? "");
  if (!(ms >= 0)) return "";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d >= 30 ? `${Math.floor(d / 30)}M` : d >= 7 ? `${Math.floor(d / 7)}w` : d >= 1 ? `${d}d` : h >= 1 ? `${h}h` : `${Math.max(1, m)}m`;
}

const newId = () => `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function parse(text) {
  try {
    const d = JSON.parse(text);
    return { ...empty(), ...d, folders: d.folders ?? [], tasks: d.tasks ?? [], archive: d.archive ?? [] };
  } catch { return empty(); }
}

// Change one account's tasks.json, retrying once if it changed underneath us.
async function mutate(folder, fn) {
  const path = `${dirOf(folder)}/tasks.json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await readTextFile(path);
    const data = text ? parse(text) : empty();
    fn(data);
    try {
      await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", text);
      return;
    } catch (e) {
      if (attempt) throw e;
    }
  }
}

// A random v4 UUID, for Claude's --session-id.
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === "x" ? r : (r & 3) | 8).toString(16);
});

// A Claude Code tab for one of a task's chats, in the account's folder.
// Each chat is a Claude session saved on the task (task.chats: {session, name}),
// so it can be reopened with --resume after its terminal is gone. The terminal
// labels itself tam.task / tam.account / tam.chat (hc label, with its own
// $HC_TERMINAL_ID) before Claude starts, which is how the sidebar finds it.
// A new chat knows the task and account but waits for me, unless `run` is set.
// A chat saved with a `cwd` (one started elsewhere and moved into a task)
// resumes there, since Claude keeps sessions by folder.
async function startChat({ folder, account, id, title, session, name, cwd, run: go }) {
  const context = [
    ...(folder === ALL
      ? [`You're helping with a task that spans my book of accounts: "${title}".`,
        "You're in ~/work/all-accounts; AGENTS.md here explains the setup. Each account's folder is ~/work/accounts/<account>, with its own AGENTS.md and JSON files."]
      : isWork(folder)
      ? [`You're helping with a task in my ${account} workspace: "${title}".`, `Its folder is ~/work/${folder}; AGENTS.md there explains it.`]
      : [`You're helping with a task for ${account}: "${title}".`,
        `You're in the account's folder (~/work/accounts/${folder}); AGENTS.md and the JSON files here have the account's context.`]),
    "Never write to Salesforce, Customer Analytics or Slack unless I explicitly ask you to.",
  ].join("\n");
  let args;
  if (session) args = ["--resume", session];
  else {
    session = uuid();
    let first = false;
    await mutate(folder, (d) => {
      const task = [...d.tasks, ...d.archive].find((t) => t.id === id);
      if (!task) return;
      task.chats = task.chats ?? [];
      first = task.chats.length === 0;
      name = name ?? (task.chats.length ? `${title} (${task.chats.length + 1})` : title);
      task.chats.push({ session, name, created_at: new Date().toISOString() });
    });
    args = ["--session-id", session];
    if (first && !go) setShared("accounts.prefill", { session, text: title, at: Date.now() });
  }
  name = name ?? title;
  args.push("-n", name, "--append-system-prompt", context);
  if (go) args.push(`Work on the task: ${title}`);
  const script = '"$1" label "$HC_TERMINAL_ID" "tam.task=$2" "tam.account=$3" "tam.chat=$4" >/dev/null 2>&1; shift 4; exec claude "$@"';
  return run("tab.new", {
    name: tabName(account, name),
    folder: cwd ?? dirOf(folder),
    argv: ["/bin/sh", "-c", script, "tam", `${home()}/.local/bin/hc`, id, folder, session, ...args],
    focus: true,
  });
}

// "Account · task", the task cut short so the account always shows.
function tabName(account, title) {
  return `${account} · ${title.length > 32 ? `${title.slice(0, 31)}…` : title}`;
}

// Everything a menu item or dialog can do. Runs in whichever copy was clicked.
async function act(a) {
  switch (a.do) {
    case "add-task": {
      // A new task goes straight to its first chat.
      const id = newId();
      await mutate(a.folder, (d) => d.tasks.push({ id, title: a.title, folder: a.path ?? "", source: "me", created_at: new Date().toISOString() }));
      if (a.account) await startChat({ folder: a.folder, account: a.account, id, title: a.title });
      return;
    }
    case "add-folder":
      return mutate(a.folder, (d) => {
        const p = a.path ? `${a.path}/${a.title}` : a.title;
        if (!d.folders.includes(p)) d.folders.push(p);
      });
    case "rename-chat":
      // The saved name, and the open tab's name when it's running.
      if (a.tab) run("tab.rename", { id: a.tab, name: tabName(a.account, a.title) });
      if (!a.session) return;
      return mutate(a.folder, (d) => { for (const t of [...d.tasks, ...d.archive]) for (const c of t.chats ?? []) if (c.session === a.session) c.name = a.title; });
    case "forget-chat":
      return mutate(a.folder, (d) => { for (const t of [...d.tasks, ...d.archive]) if (t.chats) t.chats = t.chats.filter((c) => c.session !== a.session); });
    case "rename-task":
      return mutate(a.folder, (d) => { for (const t of [...d.tasks, ...d.archive]) if (t.id === a.id) t.title = a.title; });
    case "done":
      return mutate(a.folder, (d) => {
        // A pinned task stays put until it's unpinned.
        const i = d.tasks.findIndex((t) => t.id === a.id && !t.pinned);
        if (i >= 0) d.archive.unshift({ ...d.tasks.splice(i, 1)[0], done_at: new Date().toISOString() });
      });
    case "restore":
      return mutate(a.folder, (d) => {
        const i = d.archive.findIndex((t) => t.id === a.id);
        if (i < 0) return;
        const { done_at, ...t } = d.archive.splice(i, 1)[0];
        if (t.folder && !d.folders.includes(t.folder)) t.folder = "";
        d.tasks.push(t);
      });
    case "delete":
      return mutate(a.folder, (d) => {
        d.tasks = d.tasks.filter((t) => t.id !== a.id);
        d.archive = d.archive.filter((t) => t.id !== a.id);
      });
    case "delete-folder":
      // Its tasks and sub-folders move up to the folder above.
      return mutate(a.folder, (d) => {
        const up = a.path.includes("/") ? a.path.slice(0, a.path.lastIndexOf("/")) : "";
        const lift = (p) => (p === a.path ? up : p.startsWith(`${a.path}/`) ? (up ? `${up}/` : "") + p.slice(a.path.length + 1) : p);
        d.folders = [...new Set(d.folders.filter((p) => p !== a.path).map(lift))];
        for (const t of [...d.tasks, ...d.archive]) t.folder = lift(t.folder ?? "");
      });
    case "open":
      return exec("open", [a.target]);
    case "focus":
      return run("agent.focus", { terminal: a.terminal });
    case "chat":
      return startChat(a);
    case "overview": {
      // One "<Account> · Overview" tab for every account: an open one switches
      // to this account (the pane follows "overview.folder") and is renamed.
      const name = `${a.name} · Overview`;
      setShared("overview.folder", a.folder);
      for (const sp of spaces()) {
        const tab = sp.tabs.find((x) => x.name?.endsWith(" · Overview"));
        if (!tab) continue;
        if (!sp.active) run("space.select", { id: sp.id });
        if (tab.name !== name) run("tab.rename", { id: tab.id, name });
        return run("tab.select", { id: tab.id });
      }
      return run("tab.new", { name, mod: "tam-account-pane", props: { folder: a.folder }, focus: true });
    }
    case "pin":
    case "unpin":
      return mutate(a.folder, (d) => { for (const t of d.tasks) if (t.id === a.id) { if (a.do === "pin") t.pinned = true; else delete t.pinned; } });
    case "unread":
    case "read":
      return mutate(a.folder, (d) => { for (const t of d.tasks) if (t.id === a.id) { if (a.do === "unread") t.unread = true; else delete t.unread; } });
  }
}

export default class Accounts extends View {
  init(_props, cx) {
    this.scroll = ScrollHandle.new();
    const p = props() ?? {};
    this.mode = p.dialog ? "dialog" : p.menu ? "menu" : "list";
    if (this.mode === "dialog") return this.initDialog(cx);
    if (this.mode === "menu") return;
    // Two copies sit in the sidebar: Accounts, and Work (props.section "work"),
    // which lists only All accounts. Each keeps its own folding (this.key).
    this.work = p.section === "work";
    setShared("work.folders", WORK_SPACES.map((w) => w.folder));
    this.roster = null; // roster.json
    this.data = {}; // folder -> tasks.json, parsed
    this.hover = null;
    try { this.open = new Set(JSON.parse(localStorage.getItem(this.key("open")) ?? "[]")); } catch { this.open = new Set(); }
    this.seen = localStorage.getItem(this.key("seen")) ?? "";
    try { this.arch = new Set(JSON.parse(localStorage.getItem(this.key("arch")) ?? "[]")); } catch { this.arch = new Set(); }
    // Search: off until the header's button opens it; Esc or × closes and clears it.
    this.searching = false;
    this.query = "";
    this.search = InputState.new({ placeholder: "Search accounts and tasks" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    if (checking()) return;
    cx.spawn(async (cx) => { await loadConf(); WORK_SPACES = [ALL_ACCOUNT, ...EXTRA_WORK]; this.start(cx); });
  }

  // After the config is read, since the Work section's folders come from it.
  start(cx) {
    setShared("work.folders", WORK_SPACES.map((w) => w.folder));
    // Focus changes don't redraw this list, so the right-hand pane is checked on a timer.
    cx.timer.every(300, (cx) => { this.syncCurrent(cx); if (!this.work) { this.syncPanel(); this.prefill(); } });
    cx.spawn(async (cx) => { await this.reload(); cx.notify(); });
    // keys.json: "cmd-shift-n": "tam-accounts.new-task" opens New task with no account chosen;
    // "cmd-k": "tam-accounts.search" opens (or refocuses) the search above the list.
    if (!this.work) cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "new-task") this.dialog(this.newTask());
        if (cmd === "opps") this.openOverview(OPPS);
        if (cmd === "search") {
          if (!this.searching) this.toggleSearch(cx);
          else { this.search.focus(); cx.notify(); }
        }
      }
    });
    for (const dir of [ROOT(), ...WORK_SPACES.map((w) => dirOf(w.folder))]) {
      cx.spawn(async (cx) => {
        for (;;) {
          await watchFolder(dir);
          await this.reload();
          cx.notify();
        }
      });
    }
  }

  async reload() {
    const text = await readTextFile(`${ROOT()}/roster.json`);
    let roster = null;
    try { roster = text ? JSON.parse(text) : null; } catch { roster = this.roster; }
    if (!roster) {
      // No weekly check yet: fall back to the synced book.
      try {
        const book = JSON.parse((await readTextFile(`${ROOT()}/book.json`)) ?? "{}");
        roster = { accounts: (book.accounts ?? []).map((a) => ({ ...a, folder: a.name.toLowerCase().replace(/,?\s*(inc|llc|ltd)\.?$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })), removed: [] };
      } catch { roster = { accounts: [], removed: [] }; }
    }
    this.roster = roster;
    const folders = [...WORK_SPACES.map((w) => w.folder), ...[...roster.accounts, ...(roster.removed ?? [])].map((a) => a.folder).filter(Boolean)];
    const loaded = await Promise.all(folders.map((f) => readTextFile(`${dirOf(f)}/tasks.json`).then((t) => [f, t ? parse(t) : empty()], () => [f, empty()])));
    this.data = Object.fromEntries(loaded);
  }

  key(name) {
    return this.work ? `work.${name}` : name;
  }

  toggle(key) {
    if (this.open.has(key)) this.open.delete(key); else this.open.add(key);
    localStorage.setItem(this.key("open"), JSON.stringify([...this.open]));
  }

  // --- menus and dialogs ---------------------------------------------------

  popup(items) {
    openOverlay({ mod: "tam-accounts", kind: "popup", width: 210, height: 34 + items.length * 30, props: { menu: items } });
  }

  dialog(d) {
    openOverlay({ mod: "tam-accounts", kind: "dialog", width: 440, props: { dialog: d } });
  }

  // The New task dialog, with the account (and folder) filled in when known.
  newTask(folder = null, path = "") {
    return { title: "New task", ok: "Add", pick: true, accounts: this.pickable(), action: { do: "add-task", folder, path } };
  }

  pickable() {
    return [...WORK_SPACES, ...(this.roster?.accounts ?? [])].map((a) => ({ name: a.name, folder: a.folder, folders: (this.data[a.folder] ?? empty()).folders }));
  }

  initDialog(cx) {
    const d = props().dialog;
    this.input = InputState.new({ value: d.value ?? "", placeholder: d.pick ? "What needs doing?" : "" });
    this.text = d.value ?? "";
    this.error = null;
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.handle = cx.focus_handle();
    if (d.pick) {
      // New task: pick the account (and folder) here. Without one, the account list starts open.
      this.acct = d.action.folder ?? null;
      this.path = d.action.path ?? "";
      this.list = this.acct ? null : "account";
      this.filter = InputState.new({ placeholder: "Find an account" });
      this.filterText = "";
      this.filter.on("change", (_e, cx) => { this.filterText = this.filter.value(); cx.notify(); });
      this.filter.on("submit", (_e, cx) => { const first = this.matches()[0]; if (first) this.pickAccount(first.folder, cx); });
    }
    const first = d.confirm ? this.handle : d.pick && !this.acct ? this.filter : this.input;
    first.focus();
    cx.timer.after(400, () => first.focus());
  }

  matches() {
    const q = this.filterText.trim().toLowerCase();
    return props().dialog.accounts.filter((a) => a.name.toLowerCase().includes(q));
  }

  pickAccount(folder, cx) {
    if (folder !== this.acct) this.path = "";
    this.acct = folder;
    this.list = null;
    this.input.focus();
    cx.notify();
  }

  async submit(cx) {
    const p = props();
    if (p.dialog.confirm) {
      try { await act(p.dialog.action); closeOverlay(p.overlay); } catch (e) { this.error = `Couldn't save: ${e?.message ?? e}`; cx?.notify(); }
      return;
    }
    const title = this.text.trim();
    if (p.dialog.pick && !this.acct) { this.list = "account"; this.filter.focus(); cx?.notify(); return; }
    if (!title) return;
    // Save before closing: closing first ends this copy, and the write with it.
    try {
      await act({ ...p.dialog.action, ...(p.dialog.pick ? { folder: this.acct, path: this.path, account: p.dialog.accounts.find((x) => x.folder === this.acct)?.name } : {}), title });
      closeOverlay(p.overlay);
    } catch (e) {
      this.error = `Couldn't save: ${e?.message ?? e}`;
      cx?.notify();
    }
  }

  renderDialog() {
    const t = theme();
    const d = props().dialog;
    // The main button is red for a delete.
    const solid = d.danger ? t.blocked : t.solid;
    const button = (id, text, primary, fn, off) => h_flex().id(id).h(28).px(12).items_center().rounded(6)
      .border_1().border_color(primary ? solid : t.input).bg(primary ? solid : t.raised)
      .text_color(primary ? (d.danger ? "#ffffff" : t.solid_foreground) : t.foreground).text_size(12.5).font_medium()
      .when(off, (el) => el.opacity(0.5)).when(!off, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(fn))
      .child(text);
    const ready = d.confirm || (this.text.trim() && (!d.pick || this.acct));
    return v_flex().id("acct-dialog").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (d.confirm && e.key === "enter") { cx.stop_propagation(); this.submit(cx); return; }
        if (e.key !== "escape") return;
        cx.stop_propagation();
        if (this.list) { this.list = null; this.input.focus(); cx.notify(); } else closeOverlay(props().overlay);
      })
      .w_full().p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_baseline().gap(6)
        .child(div().text_size(14).font_semibold().child(d.title))
        .when(!d.pick, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(d.where ?? ""))))
      .when(Boolean(d.pick), (el) => el.children(this.pickers(d, t)))
      .when(Boolean(d.detail), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(d.detail)))
      .when(!d.confirm, (el) => el.child(Input.new(this.input).h(30).px(8).rounded(6).border_1().border_color(this.list ? t.input : t.accent).bg(t.background).text_size(13).text_color(t.foreground)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().gap(8).justify_end()
        .child(button("d-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("d-ok", d.ok ?? "Save", true, (_e, cx) => this.submit(cx), !ready)));
  }

  // The Account and Folder fields of the New task dialog, each a dropdown that opens in place.
  pickers(d, t) {
    const acct = d.accounts.find((a) => a.folder === this.acct);
    const field = (id, label, value, placeholder, which, off) => h_flex().gap(8).items_center()
      .child(div().w(56).flex_none().text_size(12).text_color(t.dim).child(label))
      .child(h_flex().id(id).flex_1().min_w(0).h(28).px(8).gap(6).items_center().rounded(6)
        .border_1().border_color(this.list === which ? t.accent : t.input).bg(t.raised).text_size(12.5)
        .when(off, (el) => el.opacity(0.5))
        .when(!off, (el) => el.cursor_pointer().hover((s) => s.border_color(t.accent)).on_click((_e, cx) => {
          this.list = this.list === which ? null : which;
          if (this.list === "account") { this.filter.set_value(""); this.filterText = ""; this.filter.focus(); }
          cx.notify();
        }))
        .child(div().flex_1().min_w(0).truncate().text_color(value ? t.foreground : t.dim).child(value || placeholder))
        .child(svg(ICON("chevron-down")).size(12).text_color(t.dim).flex_none()));
    const option = (id, text, on, fn, depth = 0) => h_flex().id(id).h(26).flex_none().pl(8 + depth * INDENT).pr(8).gap(6).items_center().rounded(5)
      .cursor_pointer().hover((s) => s.bg(t.hover)).when(on, (el) => el.bg(t.selected)).on_click(fn)
      .child(div().flex_1().min_w(0).truncate().child(text))
      .when(on, (el) => el.child(svg(ICON("check")).size(11).text_color(t.accent).flex_none()));
    const listBox = (children) => v_flex().p(4).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12.5)
      .child(v_flex().id("pick-list").max_h(216).overflow_y_scrollbar().children(children));
    const out = [field("pick-account", "Account", acct?.name, "Choose an account", "account", false)];
    if (this.list === "account") {
      const found = this.matches();
      out.push(v_flex().ml(64).gap(4)
        .child(Input.new(this.filter).h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(listBox(found.length
          ? found.map((a) => option(`pa-${a.folder}`, a.name, a.folder === this.acct, (_e, cx) => this.pickAccount(a.folder, cx)))
          : [div().h(26).px(8).flex().items_center().text_color(t.dim).child("No account matches")])));
    }
    out.push(field("pick-folder", "Folder", this.path ? this.path.split("/").join(" / ") : (acct ? "Top level" : ""), "Choose an account first", "folder", !acct || !acct.folders.length));
    if (this.list === "folder" && acct) {
      const pick = (path) => (_e, cx) => { this.path = path; this.list = null; this.input.focus(); cx.notify(); };
      out.push(div().ml(64).child(listBox([
        option("pf-top", "Top level", this.path === "", pick("")),
        ...[...acct.folders].sort().map((f) => option(`pf-${f}`, f.split("/").pop(), this.path === f, pick(f), f.split("/").length - 1)),
      ])));
    }
    return out;
  }

  renderMenu() {
    const t = theme();
    const p = props();
    return v_flex().w_full().p(5).bg(t.popover).text_size(13).text_color(t.foreground).children(
      p.menu.map((it, i) => it.sep
        ? div().h(1).my(4).mx(6).bg(t.border)
        : h_flex().id(`m-${i}`).h(26).px(9).items_center().rounded(5).cursor_pointer()
          .when(Boolean(it.danger), (el) => el.text_color(t.blocked))
          .hover((s) => s.bg(t.selected))
          .on_click(async () => {
            // Act before closing: closing ends this copy, and anything still saving with it.
            if (it.dialog) openOverlay({ mod: "tam-accounts", kind: "dialog", width: 440, props: { dialog: it.dialog } });
            else await act(it.action).catch(() => {});
            closeOverlay(p.overlay);
          })
          .child(it.label)));
  }

  // --- the tree ------------------------------------------------------------

  openOverview(a) {
    return act({ do: "overview", folder: a.folder, name: a.name });
  }

  // The account pane on the right shows only while a chat in an account has focus,
  // unless the tab bar's Account Info button turned it off ("account.panel").
  syncPanel() {
    const f = focused();
    const term = f?.terminal ? terminals().find((x) => x.address === f.terminal) : null;
    const acct = term?.labels?.["tam.account"] ?? folderOf(term?.cwd);
    const inAccount = Boolean(acct) && !isWork(acct);
    const show = inAccount && shared("account.panel") !== false;
    if (show === this.panelShown) return;
    this.panelShown = show;
    run(show ? "layout.show" : "layout.hide", { id: "account-panel" });
  }

  // What's showing, for the sidebar's highlight: a chat's terminal labels, an
  // Overview tab's account, or a terminal opened in an account's folder.
  syncCurrent(cx) {
    const f = focused();
    const term = f?.terminal ? terminals().find((x) => x.address === f.terminal) : null;
    const l = term?.labels ?? {};
    let cur = null;
    if (l["tam.account"]) cur = { account: l["tam.account"], task: l["tam.task"] ?? null, chat: l["tam.chat"] ?? null, terminal: term.address };
    else if (!term && spaces().flatMap((sp) => sp.tabs).find((x) => x.id === f?.tab)?.name?.endsWith(" · Overview")) cur = { account: shared("overview.folder") ?? null };
    else if (folderOf(term?.cwd)) cur = { account: folderOf(term.cwd) };
    const key = JSON.stringify(cur);
    if (key === this.currentKey) return;
    this.currentKey = key;
    this.current = cur;
    cx.notify();
  }

  // A task's first chat opens with the task's name typed in (not sent): once
  // Claude is ready and the chat still has focus, it's pasted via the
  // clipboard, which is put back after a second.
  async prefill() {
    const p = shared("accounts.prefill");
    if (!p || this.prefilling) return;
    if (Date.now() - p.at > 20000) { setShared("accounts.prefill", null); return; }
    const term = terminals().find((x) => x.labels?.["tam.chat"] === p.session);
    if (!term) return;
    this.seenAt = this.seenAt ?? {};
    this.seenAt[p.session] = this.seenAt[p.session] ?? Date.now();
    const ready = term.status === "idle" || (Date.now() - this.seenAt[p.session] > 4000 && term.status !== "working" && term.status !== "blocked");
    if (!ready || focused()?.terminal !== term.address) return;
    this.prefilling = true;
    setShared("accounts.prefill", null);
    try {
      await exec("/bin/sh", ["-c", "sleep 0.5"]);
      const old = await exec("pbpaste", []).then((r) => r.stdout, () => null);
      await exec("/bin/sh", ["-c", 'printf %s "$1" | pbcopy', "sh", p.text]);
      if (focused()?.terminal === term.address) run("terminal.paste", {});
      if (old !== null) await exec("/bin/sh", ["-c", 'sleep 1; printf %s "$1" | pbcopy', "sh", old]);
    } finally {
      this.prefilling = false;
    }
  }

  accountMenu(a) {
    const where = a.name;
    this.popup([
      { label: "Open overview", action: { do: "overview", folder: a.folder, name: a.name } },
      { sep: true },
      { label: "New task", dialog: this.newTask(a.folder) },
      { label: "New folder", dialog: { title: "New folder", where, ok: "Add", action: { do: "add-folder", folder: a.folder, path: "" } } },
      { sep: true },
      { label: "Show in Finder", action: { do: "open", target: dirOf(a.folder) } },
      ...(a.account_id && CA_BASE ? [{ label: "Open in Customer Analytics", action: { do: "open", target: `${CA_BASE}/customer_analytics/accounts/${a.account_id}` } }] : []),
    ]);
  }

  folderMenu(a, path) {
    const where = `${a.name} / ${path}`;
    this.popup([
      { label: "New task here", dialog: this.newTask(a.folder, path) },
      { label: "New folder inside", dialog: { title: "New folder", where, ok: "Add", action: { do: "add-folder", folder: a.folder, path } } },
      { sep: true },
      { label: "Delete folder", danger: true, action: { do: "delete-folder", folder: a.folder, path } },
    ]);
  }

  taskMenu(a, task, archived) {
    this.popup([
      ...(archived
        ? [{ label: "Move back to tasks", action: { do: "restore", folder: a.folder, id: task.id } }]
        : task.pinned ? [] : [{ label: "Mark done", action: { do: "done", folder: a.folder, id: task.id } }]),
      ...(archived ? [] : [task.pinned
        ? { label: "Unpin", action: { do: "unpin", folder: a.folder, id: task.id } }
        : { label: "Pin", action: { do: "pin", folder: a.folder, id: task.id } }]),
      { label: "Rename", dialog: { title: "Rename task", where: a.name, value: task.title, action: { do: "rename-task", folder: a.folder, id: task.id } } },
      ...(archived ? [] : [task.unread
        ? { label: "Mark as read", action: { do: "read", folder: a.folder, id: task.id } }
        : { label: "Mark as unread", action: { do: "unread", folder: a.folder, id: task.id } }]),
      ...(archived ? [] : [{ label: "New chat", action: this.chatAction(a, task) },
        { label: "New chat that starts on it", action: { ...this.chatAction(a, task), run: true } }]),
      ...(this.agentAddress(task) ? [{ label: "Go to its agent", action: { do: "focus", terminal: this.agentAddress(task) } }] : []),
      { sep: true },
      { label: "Delete", danger: true, dialog: this.confirmDelete(a, task) },
    ]);
  }

  confirmDelete(a, task) {
    const n = task.chats?.length ?? 0;
    return { title: "Delete task?", where: a.name, confirm: true, ok: "Delete", danger: true,
      detail: `"${task.title}" will be gone for good${n ? `, along with its list of ${n} chat${n > 1 ? "s" : ""} (the Claude sessions themselves stay)` : ""}. To keep it, check it off instead.`,
      action: { do: "delete", folder: a.folder, id: task.id } };
  }

  chatAction(a, task) {
    return { do: "chat", folder: a.folder, account: a.name, id: task.id, title: task.title };
  }

  // A task's chats: its saved sessions (with their terminal when running), then
  // running terminals labelled tam.task=<id> that aren't saved (older chats).
  // `live` is rebuilt each render: { byAddr, byTask, byChat }.
  chatsOf(task, live) {
    const saved = (task.chats ?? []).map((c) => ({ ...c, term: live.byChat.get(c.session) ?? null }));
    const known = new Set(saved.map((c) => c.term).filter(Boolean));
    const own = task.terminal && live.byAddr.get(task.terminal);
    const loose = [...(live.byTask.get(task.id) ?? []), ...(own ? [own] : [])].filter((x, i, all) => !known.has(x) && all.indexOf(x) === i)
      .map((x) => ({ name: x.labels?.where?.split(" / ").pop() || x.title || "Chat", term: x }));
    return [...saved, ...loose];
  }

  // The running terminals among a task's chats.
  agentsOf(task, live) {
    return this.chatsOf(task, live).map((c) => c.term).filter(Boolean);
  }

  agentAddress(task) {
    const live = this.live ?? { byAddr: new Map(), byTask: new Map(), byChat: new Map() };
    const a = this.agentsOf(task, live);
    return (a.find((x) => x.status === "blocked") ?? a.find((x) => x.status === "working") ?? a[0])?.address ?? null;
  }

  // A task's one indicator: its most urgent agent, else unread, else none.
  indicator(task, live) {
    const st = new Set(this.agentsOf(task, live).map((x) => x.status));
    return ["blocked", "working", "done"].find((s) => st.has(s)) ?? (task.unread ? "unread" : null);
  }

  dot(kind, t, ring) {
    return div().size(8).flex_none().rounded(4).bg(DOT[kind])
      .when(ring, (el) => el.border_1().border_color(t.chrome))
      .when(kind === "working", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1400 }));
  }

  // One dot per task with an indicator, most urgent first, side by side.
  dots(kinds, t) {
    const sorted = kinds.filter(Boolean).sort((x, y) => URGENCY.indexOf(x) - URGENCY.indexOf(y));
    if (!sorted.length) return null;
    const shown = sorted.slice(0, MAX_DOTS);
    return h_flex().flex_none().items_center().gap(3)
      .children(shown.map((k) => this.dot(k, t, false)))
      .when(sorted.length > MAX_DOTS, (el) => el.child(div().ml(3).text_size(10.5).text_color(t.dim).child(`+${sorted.length - MAX_DOTS}`)));
  }

  row(id, depth, t, selected = false) {
    return h_flex().id(id).h(ROW).flex_none().pl(6 + depth * INDENT).pr(6).gap(6).items_center().rounded(6)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover)).on_hover((on, cx) => { this.hover = on ? id : this.hover === id ? null : this.hover; cx.notify(); });
  }

  addButton(id, t, fn) {
    return this.iconButton(id, "plus", "New task", t, fn);
  }

  iconButton(id, icon, tip, t, fn, on = false) {
    return h_flex().id(id).size(18).flex_none().items_center().justify_center().rounded(4)
      .text_color(on ? t.foreground : t.dim).when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(svg(ICON(icon)).size(12));
  }

  // The hover archive button on an account or folder: shows or hides the tasks
  // archived there, remembered per folder (hidden at first).
  archiveButton(id, a, path, t) {
    const key = `${a.folder}:${path}`;
    const on = this.arch.has(key);
    return this.iconButton(id, "archive", on ? "Hide archived" : "Show archived", t, (cx) => {
      if (on) this.arch.delete(key); else { this.arch.add(key); this.open.add(path ? key : a.folder); localStorage.setItem(this.key("open"), JSON.stringify([...this.open])); }
      localStorage.setItem(this.key("arch"), JSON.stringify([...this.arch]));
      cx.notify();
    }, on);
  }

  chevron(open, t) {
    return svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).text_color(t.dim).flex_none();
  }

  // A task: click goes to its chat (the one needing me first), or starts one.
  // Its chats list under it; the hover "+" starts another.
  taskRow(a, task, depth, t, live, archived, label = task.title) {
    const id = `task-${a.folder}-${task.id}`;
    // Running chats always list; closed ones only while the task's archive
    // button is on (the hover icon, shown when it has closed chats).
    const all = archived ? [] : this.chatsOf(task, live);
    const key = `${a.folder}:task:${task.id}`;
    const closed = all.filter((c) => !c.term);
    const showClosed = this.arch.has(key);
    const chats = showClosed ? all : all.filter((c) => c.term);
    const kind = archived ? null : this.indicator(task, live);
    const shown = this.hover === id;
    // Chats list only under the task that's showing (or while its closed chats are shown).
    const cur = this.current;
    const mine = !archived && cur?.account === a.folder && cur?.task === task.id;
    const open = chats.length > 0 && (mine || showClosed);
    const ageW = Math.max(24, depth * INDENT - 6);
    const chatShown = open && chats.some((c) => (c.session ? cur?.chat === c.session : c.term?.address === cur?.terminal));
    // The age sits at the row's far left, in the indent before the checkbox.
    const row = this.row(id, 0, t, mine && !chatShown)
      .on_mouse_down("right", () => this.taskMenu(a, task, archived))
      .on_click(() => {
        if (task.unread) act({ do: "read", folder: a.folder, id: task.id });
        if (archived) return;
        // Its running chat (the one needing me first), else its last chat reopened, else a new one.
        const to = this.agentAddress(task);
        const last = (task.chats ?? []).at(-1);
        act(to ? { do: "focus", terminal: to } : last ? { ...this.chatAction(a, task), session: last.session, name: last.name, cwd: last.cwd } : this.chatAction(a, task));
      })
      .child(div().w(ageW).flex_none().whitespace_nowrap().text_size(10).text_color(t.dim).tooltip(task.created_at ? `Created ${new Date(task.created_at).toLocaleString()}` : "").child(age(task.created_at)))
      .when(Boolean(task.pinned) && !archived, (el) => el.child(h_flex().id(`${id}-pin`).size(14).flex_none().items_center().justify_center()
        .tooltip("Pinned: unpin it to check it off").child(svg(ICON("pin")).size(12).text_color(t.muted))))
      .when(!task.pinned || archived, (el) => el.child(h_flex().id(`${id}-box`).size(14).flex_none().items_center().justify_center().rounded(4)
        .border_1().border_color(archived ? t.dim : t.input).when(archived, (el) => el.bg(t.dim))
        .cursor_pointer().hover((s) => s.border_color(t.accent))
        .on_click((_e, cx) => { cx.stop_propagation(); act({ do: archived ? "restore" : "done", folder: a.folder, id: task.id }); })
        .when(archived, (el) => el.child(svg(ICON("check")).size(10).text_color(t.background)))))
      .child(div().flex_1().min_w(0).truncate().text_color(archived ? t.dim : t.foreground).when(archived, (el) => el.line_through())
        .tooltip(label).child(label))
      .when(task.source === "signal" && !archived && !shown, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("signal")))
      .when(Boolean(kind) && !shown, (el) => el.child(this.dot(kind, t, false)))
      .when(chats.length > 1 && !shown, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(chats.length))))
      .when(shown && !archived, (el) => el.child(this.iconButton(`${id}-chat`, "plus", "New chat", t, () => act(this.chatAction(a, task)))))
      .when((shown || showClosed) && closed.length > 0, (el) => el.child(this.iconButton(`${id}-arch`, "archive", showClosed ? "Hide closed chats" : `Show ${closed.length} closed chat${closed.length > 1 ? "s" : ""}`, t, (cx) => {
        if (showClosed) this.arch.delete(key); else this.arch.add(key);
        localStorage.setItem(this.key("arch"), JSON.stringify([...this.arch]));
        cx.notify();
      }, showClosed)))
      .when(shown, (el) => el.child(h_flex().id(`${id}-del`).size(18).flex_none().items_center().justify_center().rounded(4)
        .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.blocked)).tooltip("Delete task")
        .on_click((_e, cx) => { cx.stop_propagation(); this.dialog(this.confirmDelete(a, task)); })
        .child(svg(ICON("x")).size(11))));
    if (!open) return [row];
    return [row, ...chats.map((c) => this.chatRow(a, task, c, ageW, t))];
  }

  // One of a task's chats: click goes to it, or reopens it when it isn't running.
  // Its icon lines up with the task's checkbox (after the task's age column).
  chatRow(a, task, c, ageW, t) {
    const x = c.term;
    const kind = ["blocked", "working", "done"].includes(x?.status) ? x.status : null;
    const open = () => act(x ? { do: "focus", terminal: x.address } : { ...this.chatAction(a, task), session: c.session, name: c.name, cwd: c.cwd });
    const cur = this.current;
    const here = Boolean(cur?.terminal) && (c.session ? cur.chat === c.session : x?.address === cur.terminal);
    return this.row(`chat-${c.session ?? x?.address}`, 0, t, here)
      .on_click(open)
      .on_mouse_down("right", () => this.popup([
        { label: x ? "Go to chat" : "Reopen chat", action: x ? { do: "focus", terminal: x.address } : { ...this.chatAction(a, task), session: c.session, name: c.name, cwd: c.cwd } },
        { label: "Rename", dialog: { title: "Rename chat", where: a.name, value: c.name, action: { do: "rename-chat", folder: a.folder, account: a.name, session: c.session ?? null, tab: x?.labels?.["herdr.tab"] ?? null } } },
        ...(c.session ? [{ sep: true }, { label: "Remove from task", danger: true, action: { do: "forget-chat", folder: a.folder, session: c.session } }] : []),
      ]))
      .child(div().w(ageW).flex_none())
      .child(svg(ICON("terminal")).size(12).text_color(x ? t.muted : t.dim).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(x ? t.muted : t.dim).tooltip(x ? c.name : `${c.name} (closed: click to reopen)`).child(c.name))
      .child(kind ? this.dot(kind, t, false) : div().flex_none().text_size(10.5).text_color(t.dim).child(x ? x.status ?? "" : ""));
  }

  // Folders and tasks under `path` ("" = the account itself).
  subtree(a, d, path, depth, t, live) {
    const kids = d.folders.filter((f) => (path ? f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes("/") : !f.includes("/"))).sort();
    const out = [];
    for (const f of kids) {
      const key = `${a.folder}:${f}`;
      const open = this.open.has(key);
      const inside = d.tasks.filter((x) => (x.folder ?? "") === f || (x.folder ?? "").startsWith(`${f}/`));
      const count = inside.length;
      const marks = this.dots(inside.map((x) => this.indicator(x, live)), t);
      const opps = a.folder === ALL && f === OPPS_FOLDER;
      const holds = (!open && this.current?.account === a.folder && inside.some((x) => x.id === this.current?.task)) || (opps && this.current?.account === OPPS.folder);
      // Opportunities: the chevron folds it, the rest of the row opens its overview.
      out.push(this.row(`f-${key}`, depth, t, holds)
        .on_click((_e, cx) => { if (opps) this.openOverview(OPPS); else { this.toggle(key); cx.notify(); } })
        .on_mouse_down("right", () => this.folderMenu(a, f))
        .child(opps
          ? h_flex().id(`f-${key}-chev`).flex_none().size(16).items_center().justify_center().rounded(4).hover((s) => s.bg(t.raised))
            .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(key); cx.notify(); })
            .child(this.chevron(open, t))
          : this.chevron(open, t))
        .child(svg(ICON("folder")).size(13).text_color(t.muted).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(f.split("/").pop()))
        .when(Boolean(marks) && this.hover !== `f-${key}`, (el) => el.child(marks))
        .when(count > 0 && this.hover !== `f-${key}`, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(count))))
        .when(this.hover === `f-${key}`, (el) => el.child(this.addButton(`f-${key}-add`, t, () => this.dialog(this.newTask(a.folder, f)))))
        .when(this.hover === `f-${key}` || this.arch.has(key), (el) => el.when(this.archivedIn(d, f).length > 0, (el) => el.child(this.archiveButton(`f-${key}-arch`, a, f, t)))));
      if (open) out.push(...this.subtree(a, d, f, depth + 1, t, live));
    }
    const here = d.tasks.filter((x) => (x.folder ?? "") === path);
    for (const task of [...here.filter((x) => x.pinned), ...here.filter((x) => !x.pinned)]) out.push(...this.taskRow(a, task, depth, t, live, false));
    if (this.arch.has(path ? `${a.folder}:${path}` : `${a.folder}:`)) for (const task of this.archivedIn(d, path)) out.push(...this.taskRow(a, task, depth, t, live, true));
    return out;
  }

  // Archived tasks that sat directly in `path`; ones whose folder is gone count as top level.
  archivedIn(d, path) {
    return d.archive.filter((x) => {
      const f = x.folder && d.folders.includes(x.folder) ? x.folder : "";
      return f === path;
    });
  }

  account(a, t, live, gone) {
    const d = this.data[a.folder] ?? empty();
    const key = a.folder;
    const open = this.open.has(key);
    const id = `a-${key}`;
    const marks = this.dots(d.tasks.map((x) => this.indicator(x, live)), t);
    // The chevron folds the account; the rest of the row opens its overview tab.
    const cur = this.current;
    const here = cur?.account === a.folder && (!cur.task || !open || !d.tasks.some((x) => x.id === cur.task));
    const rows = [this.row(id, 0, t, here)
      .on_click((_e, cx) => {
        if (isWork(a.folder) && a.folder !== ALL) { this.toggle(key); cx.notify(); }
        else if (!gone) this.openOverview(a);
      })
      .on_mouse_down("right", () => this.accountMenu(a))
      .child(h_flex().id(`${id}-chev`).flex_none().size(16).items_center().justify_center().rounded(4).hover((s) => s.bg(t.raised))
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(key); cx.notify(); })
        .child(this.chevron(open, t)))
      .child(div().flex_1().min_w(0).truncate().text_color(gone ? t.dim : t.foreground).child(a.name))
      .when(gone, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("left book")))
      .when(Boolean(marks) && this.hover !== id, (el) => el.child(marks))
      .when(d.tasks.length > 0 && this.hover !== id, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(d.tasks.length))))
      .when(this.hover === id && !gone, (el) => el.child(this.addButton(`${id}-add`, t, () => this.dialog(this.newTask(a.folder)))))
      .when((this.hover === id || this.arch.has(`${key}:`)) && this.archivedIn(d, "").length > 0, (el) => el.child(this.archiveButton(`${id}-arch`, a, "", t)))];
    if (!open) return rows;
    rows.push(...this.subtree(a, d, "", 1, t, live));
    return rows;
  }

  render() {
    if (this.mode === "dialog") return this.renderDialog();
    if (this.mode === "menu") return this.renderMenu();
    const t = theme();
    const r = this.roster ?? { accounts: [], removed: [] };
    // agents() knows what I've seen: a finished agent I've looked at is "idle", not "done".
    const seen = new Map(agents().map((x) => [x.address, x]));
    const running = terminals().filter((x) => x.state !== "finished")
      .map((x) => (seen.has(x.address) ? { ...x, status: seen.get(x.address).status, focused: seen.get(x.address).focused } : x));
    const live = { byAddr: new Map(running.map((x) => [x.address, x])), byTask: new Map(), byChat: new Map() };
    for (const x of running) {
      const id = x.labels?.["tam.task"];
      if (id) live.byTask.set(id, [...(live.byTask.get(id) ?? []), x]);
      if (x.labels?.["tam.chat"]) live.byChat.set(x.labels["tam.chat"], x);
    }
    this.live = live;
    // Looking at a task's chat reads the task.
    for (const x of running) {
      const id = x.labels?.["tam.task"];
      const folder = x.labels?.["tam.account"];
      if (!x.focused || !id || !folder || this.reading === id) continue;
      if ((this.data[folder]?.tasks ?? []).some((task) => task.id === id && task.unread)) {
        this.reading = id;
        act({ do: "read", folder, id }).finally(() => { this.reading = null; });
      }
    }
    const checked = r.checked_at ? new Date(r.checked_at) : null;
    const news = checked && r.checked_at !== this.seen ? [
      ...(r.added ?? []).map((n) => `New in your book: ${n}`),
      ...(r.removed ?? []).filter((x) => x.removed_at === r.checked_at.slice(0, 10)).map((x) => `Left your book: ${x.name}`),
    ] : [];
    if (this.work) {
      if (narrow()) return v_flex().size_full().bg(t.chrome);
      return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
        .child(h_flex().h(31).flex_none().pl(16).pr(10).items_center().text_size(11.5).text_color(t.dim).child("Work"))
        .child(v_flex().id("work-list").flex_1().min_h(0).px(8).pb(10).overflow_y_scrollbar().track_scroll(this.scroll)
          .children(WORK_SPACES.flatMap((w) => this.account(w, t, live, false))));
    }
    const header = h_flex().h(31).flex_none().pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
      .child(div().id("acct-title")
        .tooltip(checked ? `Checked against Customer Analytics on ${checked.toDateString()}` : "Not checked against Customer Analytics yet")
        .child(`Accounts (${r.accounts.length})`))
      .child(div().id("acct-search").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .when(this.searching, (el) => el.bg(t.selected).text_color(t.foreground))
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.toggleSearch(cx))
        .child(svg(ICON("search")).size(14)));
    const searchBar = h_flex().id("acct-search-bar").mx(8).mb(6).h(28).flex_none().pl(8).pr(4).gap(6).items_center().rounded(6)
      .border_1().border_color(t.accent).bg(t.background)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.toggleSearch(cx); } })
      .child(svg(ICON("search")).size(12).text_color(t.dim).flex_none())
      .child(Input.new(this.search).flex_1().min_w(0).text_size(12.5).text_color(t.foreground))
      .child(div().id("acct-search-x").size(20).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.toggleSearch(cx))
        .child(svg(ICON("x")).size(11)));
    const q = this.searching ? this.query.trim().toLowerCase() : "";
    const rows = q ? this.results(r, q, t, live) : [
      ...r.accounts.flatMap((a) => this.account(a, t, live, false)),
      ...(r.removed ?? []).filter((a) => a.folder).flatMap((a) => this.account(a, t, live, true)),
    ];
    if (narrow()) return v_flex().size_full().bg(t.chrome);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(header)
      .when(news.length > 0, (el) => el.child(v_flex().mx(8).mb(6).p(8).gap(4).rounded(6).bg(t.raised).text_size(12)
        .children(news.map((n) => div().text_color(t.foreground).child(n)))
        .child(div().id("news-ok").text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { this.seen = r.checked_at; localStorage.setItem(this.key("seen"), this.seen); cx.notify(); }).child("Got it"))))
      .when(this.searching, (el) => el.child(searchBar))
      // A fixed id and handle keep the scroll position across redraws (without
      // them the list jumped back to the top whenever a status changed).
      .child(v_flex().id("account-list").flex_1().min_h(0).px(8).pb(10).overflow_y_scrollbar().track_scroll(this.scroll).children(rows));
  }

  toggleSearch(cx) {
    this.searching = !this.searching;
    this.query = "";
    this.search.set_value("");
    if (this.searching) this.search.focus();
    cx.notify();
  }

  // Matching accounts, each followed by its matching tasks (open, then archived),
  // with the folder a task sits in shown before its title.
  results(r, q, t, live) {
    const out = [];
    const all = [...WORK_SPACES.map((w) => [w, false]), ...r.accounts.map((a) => [a, false]), ...(r.removed ?? []).filter((a) => a.folder).map((a) => [a, true])];
    for (const [a, gone] of all) {
      const d = this.data[a.folder] ?? empty();
      const hit = (task) => task.title.toLowerCase().includes(q) || (task.folder ?? "").toLowerCase().includes(q);
      const open = d.tasks.filter(hit);
      const done = d.archive.filter(hit);
      if (!a.name.toLowerCase().includes(q) && !open.length && !done.length) continue;
      out.push(this.row(`s-${a.folder}`, 0, t)
        .on_click((_e, cx) => { this.open.add(a.folder); localStorage.setItem(this.key("open"), JSON.stringify([...this.open])); this.toggleSearch(cx); })
        .on_mouse_down("right", () => this.accountMenu(a))
        .child(div().flex_1().min_w(0).truncate().text_color(gone ? t.dim : t.foreground).child(a.name))
        .when(d.tasks.length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(d.tasks.length)))));
      for (const task of open) out.push(...this.taskRow(a, task, 1, t, live, false, task.folder ? `${task.folder} / ${task.title}` : task.title));
      for (const task of done) out.push(...this.taskRow(a, task, 1, t, live, true, task.folder ? `${task.folder} / ${task.title}` : task.title));
    }
    if (!out.length) out.push(h_flex().h(ROW).flex_none().px(8).items_center().text_size(12).text_color(t.dim).child("Nothing matches."));
    return out;
  }
}
