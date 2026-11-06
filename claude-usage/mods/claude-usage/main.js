import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, props, agents, spaces, home, openOverlay, closeOverlay, nextCommand, notify, playSound, shared, setShared, readTextFile } from "herdr";
import { WINDOWS, dataDir, tapPath, auth, configDir, projectsDir, connection, connect, disconnect, prune, clearReports, ensureDataDir, limits, sessionOf, findTranscript, Totals, modelName } from "./data.js";

const ICON = (name) => `mods/claude-usage/icons/${name}.svg`;
const REFRESH_EVERY = 10000;
const AUTH_EVERY = 300000;
const SESSIONS_EVERY = 5000;
const DIM_AFTER = 3600000;
const PREFS = "claude-usage.prefs";
const SEEN = "claude-usage.seen";
const ACCOUNT = "claude-usage.account";
const DEFAULTS = { warn: 80, urgent: 95, sound: true };
const PLANS = { pro: "Claude Pro", max: "Claude Max", team: "Claude Team", enterprise: "Claude Enterprise", ultra: "Claude Ultra" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const prefs = () => ({ ...DEFAULTS, ...(shared(PREFS) ?? {}) });

function clock(d) {
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

function resetText(sec) {
  const at = sec * 1000;
  const left = at - Date.now();
  if (left <= 0) return `reset at ${clock(new Date(at))}`;
  if (left < 3600000) return `resets in ${Math.max(1, Math.round(left / 60000))}m`;
  const d = new Date(at);
  return `resets ${d.toDateString() === new Date().toDateString() ? "" : `${DAYS[d.getDay()]} `}${clock(d)}`;
}

function until(sec) {
  const left = sec * 1000 - Date.now();
  if (left < 3600000) return "";
  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  return h < 24 ? `, in ${h}h ${m}m` : "";
}

function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function count(n) {
  if (n >= 999950) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 999.5) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const monthDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

const tilde = (path) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);

export default class ClaudeUsage extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay ?? null;
    this.page = props()?.page ?? "usage";
    this.auth = null;
    this.authAt = 0;
    this.link = null;
    this.original = "";
    this.data = null;
    this.rows = null;
    this.totals = new Totals();
    this.transcripts = new Map();
    this.busy = {};
    this.error = null;
    this.pending = null;
    this.alerted = new Set(JSON.parse(localStorage.getItem("alerted") ?? "[]"));

    cx.timer.every(REFRESH_EVERY, (cx) => this.refresh(cx));
    cx.timer.every(60000, (cx) => cx.notify());
    if (this.overlay) cx.timer.every(SESSIONS_EVERY, (cx) => this.refreshSessions(cx));
    else {
      ensureDataDir().then(() => prune()).catch(() => null);
      cx.timer.every(3600000, () => prune());
    }
    this.refresh(cx, true);

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "settings" || c === "account") {
          if (!this.overlay) this.openSettings(c === "account" ? "account" : "usage");
        }
        else if (this.pending && c === this.pending) await this.act(c.split("-")[0], cx);
        cx.notify();
      }
    });
  }

  refresh(cx, first = false) {
    if (this.busy.refresh) return;
    this.busy.refresh = true;
    cx.spawn(async (cx) => {
      try {
        const signedOut = this.auth && (this.auth.loggedIn === false || this.auth.missing);
        if (first || Date.now() - this.authAt > (signedOut ? REFRESH_EVERY : AUTH_EVERY)) {
          this.auth = await auth();
          this.authAt = Date.now();
          if (!this.overlay) await this.checkAccount();
        }
        if (this.auth && !this.auth.missing) {
          try {
            this.link = await connection(configDir(this.auth));
            this.original = this.link.connected ? ((await readTextFile(`${dataDir()}/original-command`)) ?? "") : (this.link.settings?.statusLine?.command ?? "");
          } catch (e) {
            this.link = { error: String(e?.message ?? e) };
          }
        }
        this.data = await limits();
        this.remember();
        if (!this.overlay) this.alert();
        if (first && this.overlay) this.refreshSessions(cx);
        this.failed = null;
      } catch (e) {
        this.failed = String(e?.message ?? e);
      } finally {
        this.busy.refresh = false;
        cx.notify();
      }
    });
  }

  remember() {
    const sig = JSON.stringify(this.data?.windows ?? {});
    const seen = shared(SEEN);
    if (this.overlay || seen?.sig === sig) return;
    setShared(SEEN, { sig, at: seen ? Date.now() : null });
  }

  alert() {
    const { warn, urgent, sound } = prefs();
    for (const w of WINDOWS) {
      const v = this.data?.windows?.[w.key];
      if (!v || v.resets * 1000 <= Date.now()) continue;
      const level = v.used >= urgent ? "urgent" : v.used >= warn ? "warn" : null;
      if (!level) continue;
      const key = `${w.key}:${v.resets}:${level}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      this.alerted.add(`${w.key}:${v.resets}:warn`);
      notify({
        title: `${w.title} at ${Math.round(v.used)}%`,
        body: `${resetText(v.resets).replace(/^r/, "R")}.`,
        level: level === "urgent" ? "error" : "warning",
        timeout: 10000,
        action: { name: "claude-usage.settings" },
      });
      if (sound && level === "urgent") playSound("blocked");
    }
    localStorage.setItem("alerted", JSON.stringify([...this.alerted].slice(-40)));
  }

  async checkAccount() {
    const a = this.auth;
    if (!a || a.missing || a.loggedIn === false) return;
    const who = `${a.email ?? ""}|${a.orgId ?? ""}`;
    const last = shared(ACCOUNT);
    if (last === who) return;
    if (last) await clearReports();
    setShared(ACCOUNT, who);
  }

  refreshSessions(cx) {
    if (this.busy.sessions || this.page !== "usage" || !this.auth || this.auth.missing) return;
    this.busy.sessions = true;
    cx.spawn(async (cx) => {
      try {
        const dir = configDir(this.auth);
        const rows = [];
        for (const a of agents().filter((a) => a.app === "claude-code" && !a.address.includes("/"))) {
          try {
            const sid = await sessionOf(a.address, dir);
            if (!sid) continue;
            let transcript = this.data?.sessions.get(sid)?.transcript ?? this.transcripts.get(sid);
            if (!transcript) {
              transcript = await findTranscript(projectsDir(this.auth), sid);
              if (transcript) this.transcripts.set(sid, transcript);
            }
            if (!transcript) continue;
            const t = await this.totals.of(transcript);
            rows.push({ address: a.address, name: a.tab_name, space: a.space_name, status: a.status, ...t, model: modelName(t.model, this.data?.sessions.get(sid)?.model) });
          } catch {
            continue;
          }
        }
        this.rows = rows;
      } finally {
        this.busy.sessions = false;
        cx.notify();
      }
    });
  }

  openSettings(page) {
    openOverlay({ mod: "claude-usage", kind: "dialog", width: 720, height: 560, props: { page } });
  }

  ask(action, title, detail) {
    this.pending = `${action}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 200, props: { title, detail, command: { name: `claude-usage.${this.pending}` } } });
  }

  async act(action, cx) {
    this.pending = null;
    if (action === "logout") {
      this.startClaude("Claude logout", ["claude", "auth", "logout"]);
      return;
    }
    this.busy.link = true;
    cx.notify();
    try {
      const dir = configDir(this.auth);
      if (action === "connect") await connect(dir);
      else await disconnect(dir);
      this.error = null;
      notify({
        title: action === "connect" ? "Connected to Claude Code" : "Disconnected from Claude Code",
        body: action === "connect" ? "Your plan limits arrive with your next Claude reply." : "Your statusline setting is back as it was.",
        level: "success",
        timeout: 6000,
      });
    } catch (e) {
      this.error = String(e?.message ?? e);
      notify({ title: action === "connect" ? "Couldn't connect" : "Couldn't disconnect", body: this.error, level: "error" });
    } finally {
      this.busy.link = false;
      this.refresh(cx);
    }
  }

  startClaude(name, argv) {
    const local = spaces().find((s) => s.machine == null && s.active) ?? spaces().find((s) => s.machine == null);
    if (local) run("tab.new", { name, space: local.id, argv });
    else run("space.new", { name, argv, machine: "" });
    this.authAt = 0;
    if (this.overlay) closeOverlay(this.overlay);
  }

  askConnect() {
    this.ask("connect", "Connect Claude Code?", "Sets Claude Code's statusline to a small script that saves your plan limits, then runs your own statusline. Your statusline looks the same. Disconnect puts it back.");
  }

  color(t, used) {
    const { warn, urgent } = prefs();
    return used >= urgent ? t.blocked : used >= warn ? t.working : t.accent;
  }

  icon(name, color, size = 14) {
    return svg(ICON(name)).size(size).flex_none().text_color(color);
  }

  button(t, id, label, onClick, solid = false) {
    return div().id(id).px(12).py(5).rounded(6).flex_none().cursor_pointer().text_size(12.5).font_medium()
      .when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!solid, (el) => el.bg(t.raised).border_1().border_color(t.input).text_color(t.foreground))
      .hover((s) => s.opacity(0.85))
      .on_click((e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  bar(t, used, h) {
    const pct = Math.max(0, Math.min(100, used));
    return div().flex_1().min_w(0).h(h).rounded(h / 2).bg(t.selected).overflow_hidden()
      .child(div().w(`${pct}%`).h(h).bg(this.color(t, used)));
  }

  state() {
    const a = this.auth;
    if (!a) return { kind: "loading", text: "Checking Claude Code." };
    if (a.missing) return { kind: "missing", text: "Claude Code isn't installed here." };
    if (a.loggedIn === false) return { kind: "signedout", text: "Claude Code is signed out." };
    const windows = this.data?.windows ?? {};
    const has = Object.keys(windows).length > 0;
    if (this.link?.error) return { kind: "error", text: this.link.error };
    if (!this.link?.connected) return { kind: "unlinked", text: "Connect Claude Code to see your plan limits here." };
    if (!has && a.authMethod && a.authMethod !== "claude.ai") return { kind: "nolimits", text: "This login has no plan limits. Session tokens still show in Settings." };
    if (!has) return { kind: "waiting", text: "Your limits arrive with your next Claude reply." };
    return { kind: "ok" };
  }

  render(cx) {
    const t = theme();
    return this.overlay ? this.renderSettings(t, cx) : this.renderStrip(t, cx);
  }

  renderRail(t, s) {
    const rows = s.kind === "ok"
      ? WINDOWS.filter((w) => this.data.windows[w.key]).map((w) => {
        const v = this.data.windows[w.key];
        const reset = v.resets * 1000 <= Date.now();
        return v_flex().items_center().gap(1)
          .child(div().text_size(10).text_color(t.muted).child(w.label))
          .child(div().text_size(12).font_medium().text_color(reset ? t.muted : this.color(t, v.used)).child(reset ? "--" : `${Math.round(v.used)}`));
      })
      : [this.icon("chart", t.muted, 16)];
    const tip = s.kind === "ok"
      ? WINDOWS.filter((w) => this.data.windows[w.key]).map((w) => `${w.long}: ${Math.round(this.data.windows[w.key].used)}%, ${resetText(this.data.windows[w.key].resets)}`).join("\n")
      : s.text;
    return v_flex().id("cu-rail").size_full().items_center().justify_end().gap(8).pb(12).cursor_pointer()
      .tooltip(tip)
      .on_click(() => this.openSettings(s.kind === "ok" || s.kind === "waiting" ? "usage" : "account"))
      .children(rows);
  }

  renderStrip(t, cx) {
    const s = this.state();
    if (this.narrow) return this.sized(this.renderRail(t, s));
    const seen = shared(SEEN);
    const stale = Boolean(this.failed);
    const old = stale || (seen?.at && Date.now() - seen.at > DIM_AFTER);
    const card = v_flex().id("cu-strip").flex_none().gap(8).px(12).pt(8).pb(9).rounded(8)
      .bg(t.surface).border_1().border_color(t.border).cursor_pointer()
      .on_click(() => this.openSettings("usage"))
      .child(h_flex().h(16).line_height("16px").items_center().gap(8)
        .child(div().flex_1().text_size(11).font_medium().text_color(t.muted).child("Claude usage"))
        .when(s.kind === "ok" && stale, (el) => el.child(div().id("cu-stale").text_size(11).text_color(t.working).tooltip(this.failed).child("couldn't refresh")))
        .when(s.kind === "ok" && !stale && Boolean(seen?.at), (el) => el.child(div().text_size(11).text_color(t.muted).child(ago(Date.now() - seen.at))))
        .child(div().id("cu-gear").cursor_pointer().text_color(t.muted).hover((st) => st.text_color(t.foreground))
          .tooltip("Usage settings")
          .on_click((e, cx) => {
            cx.stop_propagation();
            this.openSettings(s.kind === "ok" || s.kind === "waiting" ? "usage" : "account");
          })
          .child(this.icon("settings", t.muted, 14))));

    if (s.kind !== "ok") {
      card.child(div().text_size(12).text_color(t.muted).child(s.text));
      if (s.kind === "signedout") card.child(h_flex().child(this.button(t, "cu-login", "Log in", () => this.startClaude("Claude login", ["claude", "auth", "login"]), true)));
      if (s.kind === "unlinked") card.child(h_flex().child(this.button(t, "cu-connect", this.busy.link ? "Connecting" : "Connect", () => this.askConnect(), true)));
    } else {
      for (const w of WINDOWS) {
        const v = this.data.windows[w.key];
        if (!v) continue;
        const reset = v.resets * 1000 <= Date.now();
        card.child(v_flex().gap(2).when(Boolean(old), (el) => el.opacity(0.6))
          .child(h_flex().h(16).line_height("16px").items_center().gap(8)
            .child(div().w(34).flex_none().text_size(12).text_color(t.muted).child(w.label))
            .child(this.bar(t, reset ? 0 : v.used, 5))
            .child(div().w(34).flex_none().text_right().text_size(12).text_color(reset ? t.muted : v.used >= prefs().warn ? this.color(t, v.used) : t.foreground).child(reset ? "--" : `${Math.round(v.used)}%`)))
          .child(div().pl(42).h(14).line_height("14px").text_size(11).text_color(t.muted).child(resetText(v.resets))));
      }
    }
    return this.sized(v_flex().id("cu-root").size_full().justify_end().px(10).pb(8).child(card));
  }

  sized(el) {
    return el.on_size_change((size, cx) => {
      const narrow = size.width < 150;
      if (narrow !== this.narrow) {
        this.narrow = narrow;
        cx.notify();
      }
    });
  }

  renderSettings(t, cx) {
    const nav = (id, label, icon) => {
      const on = this.page === id;
      return h_flex().id(`cu-nav-${id}`).gap(8).items_center().px(8).py(7).rounded(6).cursor_pointer()
        .text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.bg(t.selected))
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.page = id;
          if (id === "usage") this.refreshSessions(cx);
          cx.notify();
        })
        .child(this.icon(icon, on ? t.foreground : t.muted, 15))
        .child(label);
    };
    return h_flex().size_full().text_size(13).text_color(t.foreground)
      .child(v_flex().w(176).flex_none().h_full().bg(t.chrome).border_r_1().border_color(t.border).px(10).py(16).gap(2)
        .child(div().px(8).pb(12).font_semibold().child("Claude usage"))
        .child(nav("usage", "Usage", "chart"))
        .child(nav("account", "Account", "user")))
      .child(v_flex().flex_1().min_w(0).h_full().px(24).py(20).gap(18).overflow_y_scrollbar()
        .child(h_flex().items_center()
          .child(div().flex_1().text_size(16).font_semibold().child(this.page === "usage" ? "Usage" : "Account"))
          .child(div().id("cu-close").cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground))
            .on_click(() => closeOverlay(this.overlay))
            .child(this.icon("x", t.muted, 14))))
        .children(this.page === "usage" ? this.usagePage(t) : this.accountPage(t)));
  }

  heading(t, text) {
    return div().text_size(11).font_medium().text_color(t.muted).child(text);
  }

  box(t) {
    return v_flex().gap(12).p(14).rounded(8).border_1().border_color(t.border);
  }

  usagePage(t) {
    const s = this.state();
    const seen = shared(SEEN);
    const limitsBox = this.box(t);
    if (s.kind !== "ok") {
      limitsBox.child(div().text_color(t.muted).child(s.text));
      if (s.kind === "unlinked") limitsBox.child(h_flex().child(this.button(t, "cu-connect-u", "Connect", () => this.askConnect(), true)));
      if (s.kind === "signedout") limitsBox.child(h_flex().child(this.button(t, "cu-login-u", "Log in", () => this.startClaude("Claude login", ["claude", "auth", "login"]), true)));
    } else {
      for (const w of WINDOWS) {
        const v = this.data.windows[w.key];
        if (!v) continue;
        const reset = v.resets * 1000 <= Date.now();
        limitsBox.child(h_flex().items_center().gap(12)
          .child(div().w(64).flex_none().child(w.long))
          .child(this.bar(t, reset ? 0 : v.used, 6))
          .child(div().w(44).flex_none().text_right().text_color(reset ? t.muted : v.used >= prefs().warn ? this.color(t, v.used) : t.foreground).child(reset ? "--" : `${Math.round(v.used)}%`))
          .child(div().w(180).flex_none().text_color(t.muted).child(`${resetText(v.resets)}${reset ? "" : until(v.resets)}`)));
      }
      limitsBox.child(div().text_size(12).text_color(t.muted).child(`From Claude Code after each reply.${seen?.at ? ` Last change ${ago(Date.now() - seen.at)}.` : ""}`));
    }

    const cols = [["Session", null], ["Model", 84], ["Output", 64], ["Input + cache write", 132], ["Cache read", 80]];
    const head = h_flex().gap(8).pb(6).text_size(12).font_medium().text_color(t.muted)
      .children(cols.map(([label, w], i) => (w ? div().w(w).flex_none().when(i > 1, (el) => el.text_right()) : div().flex_1().min_w(0)).child(label)));
    const dot = (status) => ({ working: t.working, blocked: t.blocked, done: t.done }[status] ?? t.idle);
    const rows = (this.rows ?? []).map((r) => h_flex().id(`cu-row-${r.address}`).gap(8).py(8).border_t_1().border_color(t.border).text_size(12).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        run("agent.focus", { terminal: r.address });
        closeOverlay(this.overlay);
      })
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().w(7).h(7).rounded(4).flex_none().bg(dot(r.status)))
        .child(div().truncate().child(r.name))
        .child(div().truncate().text_color(t.muted).child(r.space)))
      .child(div().w(84).flex_none().text_color(t.muted).child(r.model || "--"))
      .child(div().w(64).flex_none().text_right().child(count(r.output)))
      .child(div().w(132).flex_none().text_right().child(count(r.input)))
      .child(div().w(80).flex_none().text_right().child(count(r.cacheRead))));
    const empty = this.rows == null ? "Reading transcripts." : "No Claude Code sessions in Herdr on this computer.";

    const { warn, urgent, sound } = prefs();
    const set = (patch) => setShared(PREFS, { ...prefs(), ...patch });
    const stepper = (id, label, value, min, max, key) => h_flex().gap(8).items_center()
      .child(label)
      .child(this.button(t, `${id}-down`, "-", () => set({ [key]: Math.max(min, value - 5) })))
      .child(div().w(40).text_right().child(`${value}%`))
      .child(this.button(t, `${id}-up`, "+", () => set({ [key]: Math.min(max, value + 5) })));

    return [
      v_flex().gap(10).child(this.heading(t, "Plan limits")).child(limitsBox),
      v_flex().gap(4).child(this.heading(t, "Sessions on this computer")).child(v_flex().pt(6).child(head).children(rows))
        .when(!rows.length, (el) => el.child(div().py(8).text_size(12).text_color(t.muted).child(empty)))
        .child(div().pt(6).text_size(12).text_color(t.muted).child("Token counts come from each session's own transcript, subagents included. A click on a row opens its tab.")),
      v_flex().gap(10).child(this.heading(t, "Alerts"))
        .child(h_flex().gap(20).items_center().flex_wrap()
          .child(stepper("cu-warn", "Warn at", warn, 50, urgent - 5, "warn"))
          .child(stepper("cu-urgent", "Urgent at", urgent, warn + 5, 100, "urgent"))
          .child(h_flex().id("cu-sound").gap(8).items_center().cursor_pointer()
            .on_click(() => set({ sound: !sound }))
            .child(div().w(14).h(14).rounded(3).border_1().border_color(t.input).when(sound, (el) => el.bg(t.accent)))
            .child("Sound when urgent"))),
    ];
  }

  accountPage(t) {
    const a = this.auth;
    const account = this.box(t);
    if (!a) account.child(div().text_color(t.muted).child("Checking Claude Code."));
    else if (a.missing) account.child(div().text_color(t.muted).child("Claude Code isn't installed here, or Herdr can't find it on your PATH."));
    else if (a.loggedIn === false) {
      account.child(h_flex().items_center().gap(12)
        .child(div().flex_1().child("Signed out"))
        .child(this.button(t, "cu-login-a", "Log in", () => this.startClaude("Claude login", ["claude", "auth", "login"]), true)));
    } else {
      const plan = PLANS[a.subscriptionType] ?? (a.authMethod === "claude.ai" ? "Claude" : a.authMethod ?? "API key");
      const expires = a.loginExpiresAt ? monthDay(a.loginExpiresAt) : null;
      account.child(h_flex().items_center().gap(12)
        .child(h_flex().w(34).h(34).rounded(17).flex_none().bg(t.raised).items_center().justify_center().font_semibold().text_color(t.accent).child((a.email ?? "?").slice(0, 1).toUpperCase()))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(8).items_center()
            .child(div().w(7).h(7).rounded(4).flex_none().bg(t.done))
            .child(div().font_medium().child("Signed in"))
            .child(div().truncate().text_color(t.muted).child(a.email ?? "")))
          .child(div().text_color(t.muted).child(`${plan}.${expires ? ` Your login expires ${expires}.` : ""}`)))
        .child(this.button(t, "cu-logout", "Log out", () => this.ask("logout", "Log out of Claude Code?", "Opens a tab that runs claude auth logout. Every Claude Code session on this computer signs out."))));
    }

    const link = this.box(t);
    const l = this.link;
    if (!l) link.child(div().text_color(t.muted).child("Checking."));
    else if (l.error) link.child(div().text_color(t.blocked).child(l.error));
    else {
      link.child(h_flex().items_center().gap(12)
        .child(h_flex().flex_1().gap(8).items_center()
          .child(div().w(7).h(7).rounded(4).flex_none().bg(l.connected ? t.done : t.idle))
          .child(div().font_medium().child(l.connected ? "Connected" : "Not connected"))
          .child(div().text_color(t.muted).child(l.connected ? "limits arrive after each reply" : "")))
        .child(this.busy.link
          ? div().text_color(t.muted).child("Working")
          : l.connected
            ? this.button(t, "cu-disconnect", "Disconnect", () => this.ask("disconnect", "Disconnect Claude Code?", "Puts your old statusline setting back. The strip stops getting your plan limits."))
            : this.button(t, "cu-connect-a", "Connect", () => this.askConnect(), true)))
        .child(div().text_color(t.muted).child("Claude Code gives your statusline your plan limits. The mod saves a copy, then runs your own statusline command, so your statusline looks the same."))
        .child(v_flex().gap(4).p(10).rounded(6).bg(t.chrome).text_size(12)
          .child(h_flex().gap(8).child(div().w(72).flex_none().text_color(t.muted).child(l.connected ? "statusline" : "changes to")).child(div().truncate().child(tilde(tapPath()))))
          .child(h_flex().gap(8).child(div().w(72).flex_none().text_color(t.muted).child("then runs")).child(div().truncate().child(this.original || "nothing, you have no statusline"))))
        .child(div().text_size(12).text_color(t.muted).child(`It edits ${tilde(l.path)}. Disconnect puts your old setting back.`));
    }
    for (const e of [this.error, this.failed].filter(Boolean)) link.child(div().text_size(12).text_color(t.blocked).child(e));

    return [
      v_flex().gap(10).child(this.heading(t, "Claude account")).child(account)
        .child(div().text_size(12).text_color(t.muted).child("Log in and Log out open a tab that runs Claude Code's own sign-in. This mod never reads or keeps your login.")),
      v_flex().gap(10).child(this.heading(t, "Claude Code connection")).child(link),
    ];
  }
}
