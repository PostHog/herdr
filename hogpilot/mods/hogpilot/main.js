// Hogpilot: the book of accounts from hogpilot's local store, and the account card
// (`hp context`) for the account the focused terminal is working on.
// Read-only: it never writes to hogpilot's store or config.
//
// Optional settings live in data/hogpilot.json under Herdr's home (see RECIPE.md):
//   accounts      folder of account folders, each with <Name>/<Name>.md carrying `posthog_org_id:`
//   claudeFolder  where "Ask Claude" starts (default: the focused terminal's folder)
//   notesPanel    true to open dossiers in a `notes` mod in the panel-body stack
//   hp            path to the hp CLI (default: ~/.local/bin/hp)

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, theme, home, appHome, readTextFile, focused, agents, spaces, watchFolder, run, setShared, notify, checking } from "herdr";

const expand = (p) => (typeof p === "string" && p ? p.replace(/^~(?=\/|$)/, home()).replace(/\/+$/, "") : null);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const norm = (s) => String(s ?? "").toLowerCase().replace(/\b(ltd|limited|group|prod|inc)\b/g, "").replace(/[^a-z0-9]/g, "");
const money = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);

const ROSTER_SQL = `
select b.org_id as org_id,
       coalesce(json_extract(b.data, '$.display_name'), b.account) as name,
       (select count(*) from account_signals s where s.org_id = b.org_id and s.closed_on is null) as signals,
       (select coalesce(max(s.arr_at_stake), 0) from account_signals s where s.org_id = b.org_id and s.closed_on is null) as stake,
       (select count(*) from memory_facts m where m.scope = b.org_id and m.invalid_at is null) as facts
from book b
where coalesce(json_extract(b.data, '$.active'), 1)
order by signals desc, stake desc, name collate nocase`;

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return null;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default class Hogpilot extends View {
  init(_props, cx) {
    this.config = {};
    this.hp = `${home()}/.local/bin/hp`;
    this.db = `${home()}/.local/state/hogpilot/state.db`;
    this.log = `${home()}/.config/hogpilot/distill.log`;
    this.book = [];
    this.dossiers = {};
    this.status = null;
    this.pinned = null;
    this.showBook = false;
    this.card = "";
    this.cardFor = null;
    this.loading = false;
    this.error = null;
    this.lastIngest = null;
    this.width = 368;
    if (checking()) return;
    this.reload(cx);
    cx.timer.every(300000, (cx) => this.reload(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        let changed;
        try { changed = await watchFolder(`${home()}/.config/hogpilot`); } catch { return; }
        if (changed.some((p) => p.endsWith("distill.log"))) this.reload(cx, true);
      }
    });
  }

  reload(cx, fromLog = false) {
    cx.spawn(async (cx) => {
      try {
        await this.loadConfig();
        const r = await exec("/usr/bin/sqlite3", ["-json", "-cmd", ".timeout 3000", "-cmd", "PRAGMA query_only = 1", this.db, ROSTER_SQL], { timeout: 15000 });
        if (r.code !== 0) throw new Error(`${r.stderr.trim() || `sqlite3 exited ${r.code}`} (${this.db})`);
        this.book = r.stdout.trim() ? JSON.parse(r.stdout) : [];
        this.dossiers = await this.findDossiers();
        await this.readStatus(fromLog);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.cardFor = null;
      cx.notify();
    });
  }

  async loadConfig() {
    let c = {};
    try { c = JSON.parse((await readTextFile(`${appHome()}/data/hogpilot.json`)) ?? "{}") ?? {}; } catch { c = {}; }
    this.config = { accounts: expand(c.accounts), claudeFolder: expand(c.claudeFolder), notesPanel: c.notesPanel === true };
    this.hp = expand(c.hp) ?? `${home()}/.local/bin/hp`;
  }

  // Dossiers are <accounts>/<Name>/<Name>.md with a `posthog_org_id:` line. No accounts folder, no dossiers.
  async findDossiers() {
    const out = {};
    const root = this.config.accounts;
    if (!root) return out;
    const r = await exec("/usr/bin/grep", ["-rH", "--include=*.md", "-m1", "^posthog_org_id:", root], { timeout: 10000 }).catch(() => null);
    const re = new RegExp(`^(${escapeRe(root)}/([^/]+)/([^/]+)\\.md):posthog_org_id:\\s*"?([0-9a-f-]{36})`);
    for (const line of (r?.stdout ?? "").split("\n")) {
      const m = line.match(re);
      if (m && m[2] === m[3]) out[m[4]] = { path: m[1], folder: m[2] };
    }
    return out;
  }

  async readStatus(fromLog) {
    const r = await exec("/usr/bin/tail", ["-n", "200", this.log], { timeout: 5000 }).catch(() => null);
    const lines = (r?.stdout ?? "").split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
    const last = (kind) => [...lines].reverse().find((l) => l.split(" ")[1] === kind);
    const ingest = last("ingest");
    const pull = last("team-pull");
    const captured = ingest?.match(/captured (\d+) facts/)?.[1];
    this.status = {
      ingestAt: ingest?.split(" ")[0] ?? null,
      captured: captured ? Number(captured) : null,
      pullFailed: Boolean(pull && /rc=[1-9]/.test(pull)),
      pullError: pull?.split(": ").slice(1).join(": ").trim() ?? null,
    };
    if (fromLog && ingest && this.lastIngest && ingest !== this.lastIngest && captured && Number(captured) > 0) {
      notify({ title: "Hogpilot", body: `Captured ${captured} fact${captured === "1" ? "" : "s"} from a session`, level: "success", timeout: 6000 });
    }
    this.lastIngest = ingest ?? this.lastIngest;
  }

  detect() {
    const f = focused();
    const cwd = f?.cwd ?? spaces().find((s) => s.active)?.folder ?? "";
    const root = this.config.accounts;
    const folder = root && cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1).split("/")[0] : null;
    if (folder) {
      const hit = Object.entries(this.dossiers).find(([, d]) => d.folder === folder);
      if (hit) return this.book.find((a) => a.org_id === hit[0]) ?? null;
    }
    const agent = agents().find((a) => a.address === f?.agent);
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs.find((t) => t.active);
    const texts = [agent?.tab_name, tab?.named ? tab.name : null, space?.named ? space.name : null].filter(Boolean).map(norm);
    let best = null;
    for (const a of this.book) {
      const key = norm(a.name);
      const folderKey = norm(this.dossiers[a.org_id]?.folder);
      for (const k of [key, folderKey]) {
        if (k.length >= 3 && texts.some((t) => t.includes(k)) && (!best || k.length > best.len)) best = { a, len: k.length };
      }
    }
    return best?.a ?? null;
  }

  loadCard(account, cx) {
    if (!account || this.cardFor === account.org_id || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(this.hp, ["context", account.org_id], { timeout: 20000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `hp exited ${r.code}`);
        this.card = r.stdout.replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
        this.error = null;
      } catch (e) {
        this.card = "";
        this.error = String(e?.message ?? e);
      }
      this.cardFor = account.org_id;
      this.loading = false;
      cx.notify();
    });
  }

  openDossier(account) {
    const d = this.dossiers[account.org_id];
    if (!d) return;
    if (!this.config.notesPanel) {
      exec("/usr/bin/open", [d.path], { timeout: 10000 }).catch(() => {});
      return;
    }
    setShared("notes.open", { path: d.path, line: 1, at: Date.now() });
    run("layout.select", { stack: "panel-body", child: "notes" });
    run("layout.show", { id: "panel" });
  }

  askClaude(account) {
    const name = this.dossiers[account.org_id]?.folder ?? account.name;
    run("tab.new", {
      name,
      folder: this.config.claudeFolder ?? focused()?.cwd ?? home(),
      argv: ["claude"],
      task: `Catch me up on ${name}: read its hogpilot card and dossier, then tell me what needs doing.`,
    });
  }

  button(t, id, label, tip, fn, primary = false) {
    return div().id(id).px(8).h(24).flex_none().flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(primary ? t.selected : t.raised).text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => fn(cx)).child(label);
  }

  row(t, a, current) {
    const meta = [a.signals ? `${a.signals} signal${a.signals === 1 ? "" : "s"}` : null, a.stake ? `${money(a.stake)} at stake` : null, a.facts ? `${a.facts} facts` : null]
      .filter(Boolean).join(" · ");
    return h_flex().id(`hp-${a.org_id}`).px(8).py(5).flex_none().rounded(8).gap(8).items_center().cursor_pointer()
      .when(current, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.pinned = a.org_id; this.showBook = false; cx.notify(); })
      .child(div().size(7).flex_none().rounded(4).bg(a.signals ? (a.stake >= 50000 ? t.blocked : t.working) : t.border))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(this.dossiers[a.org_id]?.folder ?? a.name))
        .when(Boolean(meta), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(meta))));
  }

  render(cx) {
    const t = theme();
    const auto = this.detect();
    const account = this.showBook ? null : this.pinned ? this.book.find((a) => a.org_id === this.pinned) ?? null : auto;
    if (account) this.loadCard(account, cx);
    const s = this.status;

    const statusLine = h_flex().px(16).pb(6).gap(6).flex_none().items_center().text_size(11).text_color(t.dim)
      .child(div().truncate().child(s?.ingestAt ? `Last capture ${ago(s.ingestAt)}${s.captured != null ? ` · ${s.captured} facts` : ""}` : "No captures yet"))
      .when(Boolean(s?.pullFailed), (el) => el.child(div().id("hp-pull").text_color(t.blocked).tooltip(s.pullError ?? "Team pull failed").child("· team pull failing")));

    const header = h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
      .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Hogpilot"))
      .child(h_flex().gap(10).items_center()
        .child(div().id("hp-refresh").text_size(14).text_color(t.dim).hover((st) => st.text_color(t.foreground))
          .tooltip("Reload the book and card").on_click((_e, cx) => this.reload(cx)).child("↻"))
        .child(div().id("hp-close").text_size(14).text_color(t.dim).hover((st) => st.text_color(t.foreground))
          .tooltip("Close panel").on_click(() => run("layout.hide", { id: "panel" })).child("×")));

    const root = v_flex().id("root").size_full().min_h(0).bg(t.surface).text_size(13)
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .child(header).child(statusLine)
      .when(Boolean(this.error), (el) => el.child(div().px(16).pb(6).text_size(11).text_color(t.blocked).child(this.error)));

    if (!account) {
      const hint = auto
        ? h_flex().px(16).pb(8).gap(6).flex_none().items_center()
          .child(this.button(t, "hp-follow", `Follow focus: ${this.dossiers[auto.org_id]?.folder ?? auto.name}`, "Show the card for the focused terminal's account",
            (cx) => { this.showBook = false; this.pinned = null; cx.notify(); }, true))
        : div().px(16).pb(6).text_size(11).text_color(t.dim)
          .child("Open a terminal in an account folder, or name a tab after an account, and its card shows here.");
      return root
        .child(hint)
        .child(v_flex().id("hp-book").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar()
          .children(this.book.map((a) => this.row(t, a, a.org_id === auto?.org_id))));
    }

    const name = this.dossiers[account.org_id]?.folder ?? account.name;
    const bar = h_flex().px(16).pb(8).gap(6).flex_none().items_center().flex_wrap()
      .child(this.button(t, "hp-back", "← Book", "Show the whole book",
        (cx) => { this.pinned = null; this.showBook = true; cx.notify(); }))
      .child(this.button(t, "hp-ask", "Ask Claude", `New Claude tab about ${name}`, () => this.askClaude(account), true))
      .when(Boolean(this.dossiers[account.org_id]), (el) => el.child(this.button(t, "hp-dossier", "Dossier", "Open the dossier", () => this.openDossier(account))))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(this.pinned ? "pinned" : "following focus"));

    const body = this.loading && this.cardFor !== account.org_id
      ? h_flex().px(16).gap(6).items_center().text_size(12).text_color(t.dim)
        .child(svg("mods/workspace-chrome/spinner.svg").size(13).spin(900)).child(`Reading ${name}…`)
      : div().id("hp-card").flex_1().min_h(0).px(16).pb(10).text_size(12.5).text_color(t.foreground)
        .child(TextView.markdown(`hp-md-${account.org_id}`, this.card).selectable(true).scrollable(true));

    return root.child(bar).child(body);
  }
}
