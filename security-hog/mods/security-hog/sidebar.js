// The sidebar block: the open SecurityHog findings of your team (or yours),
// most severe first. A click shows one in the "Security" tab.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, spaces, panes, focused, shared, setShared, nextCommand, openOverlay, closeOverlay } from "herdr";
import { sh, signIn, loadConfig, myEmail, CONFIG_PATH } from "./sh.js";
import { fixOf, spaceOfFix } from "./fix.js";
import { severity, verdict, ago, repoName } from "./ui.js";

const EVERY = 10 * 60000;
const PAGE = 50;
const ROW = ["id", "title", "severity", "status", "source", "repository", "team", "assigneeEmail", "triageVerdict", "vendorCreatedAt", "firstSeenAt", "url"];
const row = (v) => Object.fromEntries(ROW.map((k) => [k, v[k]]));

export function openFinding(v) {
  setShared("security-hog.finding", { id: v.id, row: v });
  const here = spaces().find((s) => s.id === focused()?.space) ?? spaces().find((s) => s.active);
  const tabs = new Set((here?.tabs ?? []).map((tab) => tab.id));
  const pane = panes().find((p) => p.mod === "security-hog" && tabs.has(p.tab));
  if (pane) run("tab.select", { id: pane.tab });
  else run("tab.new", { name: "Security", space: here?.id, mod: "security-hog", props: { view: "finding" } });
}

const openList = () => openOverlay({ mod: "security-hog", kind: "dialog", modal: true, width: 560, height: 640, props: { view: "list" } });
const isUrgent = (v) => ["critical", "high"].includes((v.severity ?? "").toLowerCase());

export class Sidebar {
  init(props, cx) {
    this.compact = Boolean(props?.compact);
    this.overlay = props?.overlay ?? null;
    this.findings = [];
    this.total = null;
    this.fetched = 0;
    this.error = null;
    this.loading = false;
    this.config = null;
    this.me = null;
    this.width = Infinity;
    this.signedInAt = shared("security-hog.signin")?.at ?? null;
    const kept = shared("security-hog.list");
    if (kept) Object.assign(this, { findings: kept.findings, total: kept.total, fetched: kept.at, keptFilter: kept.filter });
    cx.spawn(async (cx) => {
      this.config = await loadConfig();
      this.me = await myEmail(this.config);
      if (this.keptFilter && this.keptFilter !== this.filter()) this.findings = [];
      this.refresh(cx);
    });
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        cx.notify();
        if (command === "refresh") this.refresh(cx);
      }
    });
  }

  filter() {
    const chosen = shared("security-hog.filter");
    return chosen === "mine" || !this.config?.team ? "mine" : "team";
  }

  setFilter(filter, cx) {
    if (filter === this.filter()) return;
    setShared("security-hog.filter", filter);
    this.findings = [];
    this.total = null;
    this.refresh(cx);
  }

  args(offset) {
    const who = this.filter() === "team" ? { team: [this.config.team] } : { assignee: ["me"] };
    return { ...who, status: "open", sort: "severity", order: "desc", limit: PAGE, offset };
  }

  refresh(cx, { more = false } = {}) {
    if (this.loading || !this.config) return;
    if (shared("security-hog.signin")?.state === "waiting") return;
    this.loading = true;
    cx.notify();
    const filter = this.filter();
    cx.spawn(async (cx) => {
      try {
        const r = await sh("list_vulnerabilities", this.args(more ? this.findings.length : 0));
        if (filter === this.filter()) {
          const rows = (r.vulnerabilities ?? []).map(row);
          const have = new Set(more ? this.findings.map((v) => v.id) : []);
          this.findings = more ? [...this.findings, ...rows.filter((v) => !have.has(v.id))] : rows;
          this.total = r.total ?? this.findings.length;
          this.fetched = Date.now();
          this.error = null;
          setShared("security-hog.list", { findings: this.findings, total: this.total, at: this.fetched, filter });
        }
      } catch (e) {
        this.error = { code: e.code, message: e.message };
      }
      this.loading = false;
      cx.notify();
    });
  }

  findingRow(v, t, shown) {
    const fix = fixOf(v.id);
    const fixing = fix ? spaceOfFix(fix) : null;
    const mine = this.me && v.assigneeEmail?.toLowerCase() === this.me;
    const who = mine ? "you" : v.assigneeEmail ? v.assigneeEmail.split("@")[0] : "";
    const roomy = Boolean(this.overlay);
    return v_flex().id(`finding-${v.id}`).px(roomy ? 12 : 8).h(roomy ? 60 : 46).flex_none().justify_center().gap(roomy ? 5 : 2).rounded(8).cursor_pointer()
      .when(shown === v.id, (el) => el.bg(t.selected))
      .when(shown !== v.id, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => {
        openFinding(v);
        if (this.overlay) closeOverlay(this.overlay);
      })
      .child(h_flex().gap(8).items_center()
        .child(severity(t, v.severity))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(v.title)))
      .child(h_flex().pl(40).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${v.id} · ${repoName(v.repository)}`))
        .when(Boolean(fix), (el) => el.child(div().flex_none().text_color(fixing ? t.working : t.accent).child(fixing ? "fixing" : "fix started")))
        .child(verdict(t, v.triageVerdict) ?? div())
        .when(Boolean(who), (el) => el.child(div().flex_none().max_w(70).truncate().text_color(mine ? t.accent : t.dim).child(who)))
        .child(div().flex_none().child(ago(v.vendorCreatedAt ?? v.firstSeenAt))));
  }

  notice(t) {
    const say = (text, color) => div().px(8).py(6).text_size(12).text_color(color ?? t.dim).child(text);
    const signin = shared("security-hog.signin");
    if (signin?.state === "waiting") return [say("Finish signing in in your browser…")];
    if (this.error?.code === "login") {
      return [
        say(this.error.message),
        h_flex().id("sign-in").mx(8).mt(2).h(30).px(12).flex_none().items_center().justify_center().rounded(8).bg(t.solid)
          .text_color(t.solid_foreground).text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88))
          .on_click(() => signIn()).child("Sign in to SecurityHog"),
        ...(signin?.error ? [say(signin.error, t.blocked)] : []),
      ];
    }
    if (this.error && !this.findings.length) return [say(this.error.message, t.blocked)];
    if (!this.findings.length) {
      if (this.loading || !this.config) return [say("Loading…")];
      if (!this.fetched) return [];
      return this.filter() === "team" ? [say(`Nothing open for ${this.config.team}.`)] : [
        say("Nothing open is assigned to you."),
        ...(this.config.team ? [] : [say(`Set "team" in ${CONFIG_PATH} to see your team's findings.`)]),
      ];
    }
    return this.error ? [say(`Showing the list from ${ago(this.fetched)} ago. ${this.error.message}`, t.blocked)] : [];
  }

  head(t) {
    const tab = (id, text, filter) => {
      const on = this.filter() === filter;
      return div().id(id).h(22).px(8).flex_none().flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
        .text_color(on ? t.foreground : t.dim).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setFilter(filter, cx)).child(text);
    };
    const status = this.loading ? "Refreshing…" : this.fetched ? ago(this.fetched) : "";
    return h_flex().h(31).pl(8).pr(2).flex_none().items_center().gap(4).text_size(11.5).text_color(t.dim)
      .child(div().flex_none().pr(2).child(this.total === null ? "Security" : `Security · ${this.total}`))
      .when(Boolean(this.config?.team), (el) => el.child(tab("filter-team", this.config.team, "team")))
      .child(tab("filter-mine", "Mine", "mine"))
      .child(div().flex_1())
      .child(div().flex_none().pr(4).text_size(11).child(status))
      .child(div().id("refresh").size(26).flex_none().flex().items_center().justify_center().rounded(6).tooltip("Refresh")
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
        .child(svg("mods/security-hog/refresh.svg").size(14)));
  }

  // The header bar alone, for a layout that keeps another list in the sidebar.
  compactBar(t) {
    const urgent = this.findings.filter(isUrgent).length;
    const signin = shared("security-hog.signin");
    const tool = (id, name, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(svg(name).size(14));
    let status = div().flex_none().pr(4).text_size(11).child(this.loading ? "Refreshing…" : this.fetched ? ago(this.fetched) : "");
    if (signin?.state === "waiting") status = div().flex_none().pr(4).text_size(11).child("Signing in…");
    else if (this.error?.code === "login") {
      status = div().id("compact-sign-in").flex_none().px(6).h(22).flex().items_center().rounded(6).text_size(11).text_color(t.accent)
        .cursor_pointer().tooltip(this.error.message).hover((s) => s.bg(t.hover)).on_click(() => signIn()).child("Sign in");
    } else if (this.error) {
      status = div().id("compact-error").flex_none().pr(4).text_size(11).text_color(t.blocked).tooltip(this.error.message).child("Failed");
    }
    const who = this.filter() === "team" ? this.config?.team : "mine";
    return h_flex().h(31).pl(8).pr(2).flex_none().items_center().gap(2).text_size(11.5).text_color(t.dim)
      .child(h_flex().id("compact-title").flex_1().min_w(0).gap(6).items_center().cursor_pointer().tooltip("Show the findings").on_click(openList)
        .child(div().flex_none().child(this.total === null ? "Security" : `Security · ${this.total}`))
        .when(urgent > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`${urgent} high+`)))
        .when(Boolean(who), (el) => el.child(div().min_w(0).truncate().child(who))))
      .child(status)
      .child(tool("compact-list", "mods/workspace-chrome/layers.svg", "Show the findings", openList))
      .child(tool("refresh", "mods/security-hog/refresh.svg", "Refresh", (_e, cx) => this.refresh(cx)));
  }

  rail(t) {
    const urgent = this.findings.filter(isUrgent).length;
    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).items_center()
      .when(this.compact, (el) => el.justify_center())
      .when(!this.compact, (el) => el.pt(6))
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(h_flex().id("rail-count").w(32).h(26).rounded(6).justify_center().items_center().text_size(11.5)
        .text_color(urgent ? t.ansi1 : t.muted).tooltip(`${this.total ?? 0} open findings, ${urgent} critical or high`)
        .hover((s) => s.bg(t.hover)).on_click(() => (this.compact ? openList() : run("layout.resize", { id: "sidebar", px: 300 })))
        .child(String(this.total ?? "·")));
  }

  render(cx) {
    const t = theme();
    const at = shared("security-hog.signin")?.at ?? null;
    if (at !== this.signedInAt) {
      this.signedInAt = at;
      this.refresh(cx);
    }
    if (this.width < 160) return this.rail(t);
    if (this.compact) {
      return v_flex().id("root").size_full().min_h(0).bg(t.chrome).px(8).justify_center()
        .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
        .child(this.compactBar(t));
    }
    const shown = shared("security-hog.finding")?.id ?? null;
    return v_flex().id("root").size_full().min_h(0).bg(this.overlay ? t.popover : t.chrome).text_size(13)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(v_flex().flex_1().min_h(0).px(this.overlay ? 12 : 8).pt(this.overlay ? 6 : 0).pb(14).gap(this.overlay ? 4 : 0).overflow_y_scrollbar()
        .child(this.head(t))
        .children(this.notice(t))
        .children(this.findings.map((v) => this.findingRow(v, t, shown)))
        .when(this.total > this.findings.length, (el) => el.child(h_flex().id("more").h(30).px(8).mt(2).flex_none().items_center().rounded(8).text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx, { more: true }))
          .child(this.loading ? "Loading…" : `Show ${Math.min(PAGE, this.total - this.findings.length)} more`))));
  }
}
