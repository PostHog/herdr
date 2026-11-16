// The sidebar block: Tasks (what you picked up or started, with live agent,
// git and pull-request state) over Inbox (the PostHog reports waiting for you).
// Click a task to go to its space, a report to read it; right-click either for its menu.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, layout, run, spaces, panes, focused, shared, setShared, openOverlay, notify, window, nextCommand } from "herdr";
import { ph, CONFIG_PATH } from "./ph.js";
import { worktreeStatus, pullRequest } from "./git.js";
import { activeTasks, archivedTasks, taskById, taskOfReport, patchTask, spaceOf, goToTask } from "./store.js";
import { attachPr, jobs, waitingJobs, jobOf, runJob, dropJob, JOB_SAYS, JOB_REMOVES } from "./flows.js";
import { icon, priority, statusMark, ago, prNumber } from "./ui.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The same test the other sidebar mods use for the rail.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const INBOX_EVERY = 5 * 60000;
const PAGE = 25;
const OPEN = "in_progress,pending_input,ready";
const GIT_EVERY = 30000;
const PR_EVERY = 90000;
const CLOUD_EVERY = 60000;
const CLOUD_OVER = new Set(["completed", "failed", "cancelled"]);
const ROW = ["id", "title", "summary", "status", "priority", "work_state", "assignee", "pull_requests", "personal_reason", "created_at", "updated_at", "_posthogUrl"];

const row = (r) => Object.fromEntries(ROW.map((k) => [k, r[k]]));

export function openReport(report) {
  setShared("ph-inbox.report", { id: report.id, row: report });
  const here = spaces().find((s) => s.id === focused()?.space) ?? spaces().find((s) => s.active);
  const tabs = new Set((here?.tabs ?? []).map((tab) => tab.id));
  const pane = panes().find((p) => p.mod === "ph-inbox" && tabs.has(p.tab));
  if (pane) run("tab.select", { id: pane.tab });
  else run("tab.new", { name: "Inbox", space: here?.id, mod: "ph-inbox", props: { view: "report" } });
}

const newTask = () => openOverlay({ mod: "ph-inbox", kind: "dialog", modal: true, width: 540, height: 660, props: { view: "new" } });
const triage = () => openOverlay({ mod: "ph-inbox", kind: "dialog", modal: true, width: 1100, height: 720, props: { view: "triage" } });

export class Sidebar {
  init(props, cx) {
    this.compact = Boolean(props?.compact);
    this.reports = [];
    this.count = null;
    this.fetched = 0;
    this.error = null;
    this.loading = false;
    this.ranker = null; // "personal" when your stored personal ranking ordered the list
    this.rankingId = null; // keeps later pages in the first page's order
    this.live = {}; // task id -> { git, pr, cloud, gitAt, prAt, cloudAt }
    this.showArchived = false;
    try {
      const kept = JSON.parse(localStorage.getItem("inbox") ?? "null");
      if (kept) Object.assign(this, { reports: kept.reports, count: kept.count, fetched: kept.at });
    } catch {}
    this.refresh(cx);
    cx.timer.every(INBOX_EVERY, (cx) => this.refresh(cx));
    cx.timer.every(5000, (cx) => this.tick(cx));
    this.tick(cx);
    // Keys: "ph-inbox.new" opens the New task dialog, "ph-inbox.triage" the triage round,
    // "ph-inbox.refresh" reloads the inbox.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        cx.notify(); // a loop left over from an older build of the mod ends here
        if (command === "new") newTask();
        else if (command === "triage") triage();
        else if (command === "refresh") this.refresh(cx);
      }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [list, mine] = await Promise.all([
          ph("inbox-reports-list", { view: "for_you", sort: "personal", limit: PAGE, include_source_metadata: false }),
          ph("inbox-reports-list", { assignee: "mine", status: OPEN, limit: 200, include_source_metadata: false }),
        ]);
        this.reports = (list.results ?? []).map(row);
        this.count = list.count ?? this.reports.length;
        this.ranker = list.ranker ?? null;
        this.rankingId = list.ranking_id ?? null;
        this.fetched = Date.now();
        this.error = null;
        localStorage.setItem("inbox", JSON.stringify({ reports: this.reports, count: this.count, at: this.fetched }));
        const ids = (mine.results ?? []).map((r) => r.id);
        if (JSON.stringify(ids) !== JSON.stringify(shared("ph-inbox.mine") ?? [])) setShared("ph-inbox.mine", ids);
      } catch (e) {
        this.error = { code: e.code, message: e.message };
      }
      this.loading = false;
      cx.notify();
    });
  }

  // The next page, in the order the first one came in.
  more(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const list = await ph("inbox-reports-list", {
          view: "for_you", sort: "personal", limit: PAGE, offset: this.reports.length, include_source_metadata: false,
          ...(this.rankingId ? { ranking_id: this.rankingId } : {}),
        });
        const have = new Set(this.reports.map((r) => r.id));
        this.reports = [...this.reports, ...(list.results ?? []).map(row).filter((r) => !have.has(r.id))];
        this.count = list.count ?? this.count;
        this.error = null;
      } catch (e) {
        this.error = { code: e.code, message: e.message };
      }
      this.loading = false;
      cx.notify();
    });
  }

  // Takes a report that left the inbox out of the list.
  remove(id) {
    if (!this.reports.some((r) => r.id === id)) return;
    this.reports = this.reports.filter((r) => r.id !== id);
    if (this.count) this.count--;
    localStorage.setItem("inbox", JSON.stringify({ reports: this.reports, count: this.count, at: this.fetched }));
  }

  // Does the waiting jobs (flows.js), oldest first.
  work(cx) {
    if (this.working || !waitingJobs().length) return;
    this.working = true;
    cx.spawn(async (cx) => {
      try {
        for (let job; (job = waitingJobs()[0]); ) {
          if ((await runJob(job)) && JOB_REMOVES.has(job.kind)) this.remove(job.report.id);
          cx.notify();
        }
      } finally {
        this.working = false;
      }
    });
  }

  // Looks at the tasks whose git, pull request or cloud run is due, one pass at a time.
  tick(cx) {
    if (this.checking || window()?.active === false) return;
    const now = Date.now();
    const due = activeTasks().filter((task) => {
      const l = this.live[task.id] ?? {};
      return (task.worktree && now - (l.gitAt ?? 0) > GIT_EVERY)
        || ((task.worktree || task.pr_url) && l.pr?.state !== "merged" && now - (l.prAt ?? 0) > PR_EVERY)
        || (task.cloud?.task_id && !l.cloudOver && now - (l.cloudAt ?? 0) > CLOUD_EVERY);
    });
    if (!due.length) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        for (const task of due) {
          await this.check(task.id);
          cx.notify();
        }
      } finally {
        this.checking = false;
      }
    });
  }

  async check(id) {
    const l = (this.live[id] ??= {});
    const now = Date.now();
    let task = taskById(id);
    if (!task) return;
    if (task.worktree && now - (l.gitAt ?? 0) > GIT_EVERY) {
      l.gitAt = now;
      l.git = await worktreeStatus(task.worktree, task.base);
    }
    const here = task.worktree && !l.git?.missing;
    if ((here || task.pr_url) && l.pr?.state !== "merged" && now - (l.prAt ?? 0) > PR_EVERY) {
      l.prAt = now;
      // A branch with nothing on it yet has no pull request to look for.
      if (task.pr_url) l.pr = (await pullRequest({ url: task.pr_url })) ?? l.pr;
      else if (l.git?.commits > 0) l.pr = await pullRequest({ path: task.worktree });
      if (l.pr && !task.pr_attached) await attachPr(task, l.pr.url);
      task = taskById(id) ?? task;
      if (l.pr?.state === "merged" && !task.merged_notified) {
        patchTask(id, { merged_notified: true });
        notify({ title: "Pull request merged", body: `${task.title}: archive it from Tasks when you're done.`, level: "success" });
      }
    }
    if (task.cloud?.task_id && !l.cloudOver && now - (l.cloudAt ?? 0) > CLOUD_EVERY) {
      l.cloudAt = now;
      try {
        const c = await ph("tasks-retrieve", { id: task.cloud.task_id });
        const run = c.latest_run ?? {};
        l.cloud = { status: run.status ?? c.status ?? null, error: run.error_message ?? null };
        l.cloudOver = CLOUD_OVER.has(l.cloud.status);
        const url = run.output?.pr_url;
        // A cloud run attaches its own pull request to the report.
        if (url && !task.pr_url) patchTask(id, { pr_url: url, pr_attached: true });
      } catch (e) {
        l.cloud = { status: null, error: e.message };
      }
    }
  }

  go(task, cx) {
    if (goToTask(task)) return;
    if (task.worktree && !this.live[task.id]?.git?.missing) run("space.new", { folder: task.worktree });
    else if (task.cloud?.task_url) cx.open_url(task.cloud.task_url);
    else if (task.pr_url) cx.open_url(task.pr_url);
  }

  menu(task) {
    const l = this.live[task.id] ?? {};
    openOverlay({ mod: "ph-inbox", kind: "popup", width: 230, height: 320, props: { view: "menu", task: task.id, pr: l.pr ?? null, git: l.git ?? null } });
  }

  // What a task's second line says on the right: changes, its pull request, its cloud run.
  tokens(task, t) {
    const l = this.live[task.id] ?? {};
    const out = [];
    const tok = (text, color) => out.push(div().flex_none().text_color(color ?? t.dim).child(text));
    if (l.git?.missing) tok("no worktree", t.blocked);
    if (l.git?.dirty) tok(`±${l.git.dirty}`, t.ansi3);
    if (l.git?.unpushed) tok(`↑${l.git.unpushed}`, t.ansi2);
    if (task.cloud) {
      const s = l.cloud?.status;
      tok(`☁ ${s ? s.replace(/_/g, " ") : "…"}`, s === "failed" ? t.blocked : s === "in_progress" || s === "queued" ? t.working : t.dim);
    }
    const number = l.pr?.number ?? prNumber(task.pr_url);
    if (number) {
      const pr = l.pr;
      const state = !pr ? "" : pr.state === "merged" ? " merged" : pr.state === "closed" ? " closed" : pr.state === "draft" ? " draft" : "";
      tok(`#${number}${state}`, pr?.state === "merged" ? t.done : t.muted);
      if (pr && pr.state !== "merged" && pr.state !== "closed") {
        if (pr.conflict) tok("conflict", t.blocked);
        if (pr.failing) tok(`✗${pr.failing}`, t.blocked);
        else if (pr.pending) tok("…", t.working);
        else if (pr.checks) tok("✓", t.ansi2);
        if (pr.review === "approved") tok("appr", t.ansi2);
        if (pr.review === "changes") tok("changes", t.ansi3);
      }
    }
    return out;
  }

  taskRow(task, t) {
    const space = spaceOf(task);
    const mark = task.worktree ? statusMark(t, space ? space.status ?? "idle" : null) : div().w(14).flex_none().text_size(11).text_color(t.dim).child("☁");
    const where = task.worktree ? [task.repo?.split("/").pop(), task.branch].filter(Boolean).join(" · ") : "cloud task";
    return v_flex().id(`task-${task.id}`).px(8).h(46).flex_none().justify_center().gap(2).rounded(8).cursor_pointer()
      .when(Boolean(space?.active), (el) => el.bg(t.selected))
      .when(!space?.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.go(task, cx))
      .on_mouse_down("right", () => this.menu(task))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().w(14).flex_none().justify_center().child(mark))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(task.title)))
      .child(h_flex().pl(22).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(where))
        .children(this.tokens(task, t)));
  }

  reportRow(r, t, shown) {
    const task = taskOfReport(r.id);
    const number = prNumber((r.pull_requests ?? []).find((p) => !p.merged && p.state !== "closed")?.url);
    const mine = (shared("ph-inbox.mine") ?? []).includes(r.id);
    const job = jobOf(r.id);
    const state = job ? JOB_SAYS[job.kind] : task ? "in Tasks" : number ? `#${number}` : mine ? "yours" : r.assignee ? "claimed" : r.status === "pending_input" ? "needs input" : "";
    return v_flex().id(`report-${r.id}`).px(8).h(46).flex_none().justify_center().gap(2).rounded(8).cursor_pointer()
      .when(shown === r.id, (el) => el.bg(t.selected))
      .when(shown !== r.id, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => openReport(r))
      .on_mouse_down("right", () => openOverlay({ mod: "ph-inbox", kind: "popup", width: 230, height: 292, props: { view: "report-menu", report: r } }))
      .child(h_flex().gap(8).items_center()
        .child(priority(t, r.priority))
        .child(div().flex_1().min_w(0).truncate().text_color(task ? t.muted : t.foreground).child(r.title)))
      .child(h_flex().pl(30).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(r.personal_reason ?? r.summary ?? ""))
        .when(Boolean(state), (el) => el.child(div().flex_none().text_color(task || mine ? t.accent : t.dim).child(state)))
        .child(div().flex_none().child(ago(r.updated_at))));
  }

  // Why the inbox is empty, when it is.
  notice(t) {
    const say = (text, color) => div().px(8).py(6).text_size(12).text_color(color ?? t.dim).child(text);
    if (this.error?.code === "no_key") {
      return [say("Add a PostHog personal API key to connect your inbox:"), say(CONFIG_PATH, t.muted)];
    }
    if (this.error && !this.reports.length) return [say(this.error.message, t.blocked)];
    if (!this.reports.length) return [say(this.loading ? "Loading…" : this.fetched ? "Nothing is waiting for you." : "")];
    return this.error ? [say(`Showing the list from ${ago(this.fetched)} ago. ${this.error.message}`, t.blocked)] : [];
  }

  rail(t) {
    const cell = (el) => h_flex().flex_none().h(26).justify_center().items_center().child(el);
    return v_flex().size_full().min_h(0).bg(t.chrome).pt(6).gap(2).overflow_hidden()
      .children(activeTasks().map((task) => {
        const space = spaceOf(task);
        return cell(h_flex().id(`rail-${task.id}`).w(32).h(26).rounded(6).justify_center().items_center().tooltip(task.title)
          .when(Boolean(space?.active), (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.go(task, cx))
          .child(task.worktree ? statusMark(t, space ? space.status ?? "idle" : null) : div().text_size(11).text_color(t.dim).child("☁")));
      }))
      .child(cell(h_flex().id("rail-inbox").w(32).h(26).rounded(6).justify_center().items_center().text_size(11.5).text_color(t.muted)
        .tooltip(`${this.count ?? 0} inbox reports for you`).hover((s) => s.bg(t.hover))
        .on_click(() => run("layout.resize", { id: "sidebar", px: 300 }))
        .child(String(this.count ?? "·"))));
  }

  inboxHead(t) {
    const tool = (id, name, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(svg(name.includes("/") ? name : icon(name)).size(14));
    const title = this.count === null ? "Inbox" : this.count > this.reports.length && !this.compact ? `Inbox · ${this.reports.length} of ${this.count}` : `Inbox · ${this.count}`;
    const status = this.loading ? "Refreshing…" : this.compact && this.error ? (this.error.code === "no_key" ? "No API key" : "Failed") : this.fetched ? ago(this.fetched) : "";
    return h_flex().h(31).pl(8).pr(2).flex_none().items_center().gap(2).text_size(11.5).text_color(t.dim)
      .child(div().flex_1().child(title))
      .child(div().flex_none().pr(4).text_size(11).when(this.compact && Boolean(this.error), (el) => el.text_color(t.blocked).tooltip(this.error.message)).child(status))
      .child(tool("inbox-triage", "layers", "Triage the inbox", triage))
      .child(tool("inbox-refresh", "mods/ph-inbox/refresh.svg", "Refresh the inbox", (_e, cx) => this.refresh(cx)));
  }

  render(cx) {
    const t = theme();
    this.work(cx);
    if (narrow()) return this.rail(t);
    if (this.compact) return v_flex().size_full().min_h(0).bg(t.chrome).px(8).justify_center().child(this.inboxHead(t));
    const starting = jobs().filter((j) => j.kind === "start" || j.error);
    const active = activeTasks(), archived = archivedTasks();
    const shown = shared("ph-inbox.report")?.id ?? null;
    const head = (text, ...right) => h_flex().h(31).pl(8).pr(2).flex_none().items_center().gap(2).text_size(11.5).text_color(t.dim)
      .child(div().flex_1().child(text)).children(right);
    const tool = (id, name, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(svg(name.includes("/") ? name : icon(name)).size(14));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar()
        .child(head("Tasks", tool("task-new", "plus", "New task", newTask)))
        .when(!active.length && !starting.length, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("Pick up a report below, or start a task with +.")))
        .children(starting.map((j) => h_flex().id(`job-${j.report.id}`).px(8).h(46).flex_none().gap(8).items_center().rounded(8)
          .when(Boolean(j.error), (el) => el.cursor_pointer().tooltip(`${j.error} Click to dismiss.`).hover((s) => s.bg(t.hover)).on_click(() => dropJob(j.report.id)))
          .child(h_flex().w(14).flex_none().justify_center().child(statusMark(t, j.error ? "blocked" : "working")))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_color(t.muted).child(j.report.title))
            .child(div().truncate().text_size(11.5).text_color(j.error ? t.blocked : t.dim).child(j.error ?? j.step ?? "Waiting to start…")))))
        .children(active.map((task) => this.taskRow(task, t)))
        .when(archived.length > 0, (el) => el.child(h_flex().id("archived-toggle").h(26).px(8).flex_none().items_center().gap(6).rounded(6).text_size(11.5).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.showArchived = !this.showArchived; cx.notify(); })
          .child(svg(icon(this.showArchived ? "chevron-down" : "chevron-right")).size(11)).child(`Archived (${archived.length})`)))
        .when(this.showArchived, (el) => el.children(archived.map((task) => h_flex().id(`archived-${task.id}`).h(26).pl(26).pr(8).flex_none().items_center().rounded(6)
          .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover)).on_mouse_down("right", () => this.menu(task))
          .child(div().flex_1().min_w(0).truncate().child(task.title)))))
        .child(this.inboxHead(t).mt(10))
        .children(this.notice(t))
        .when(this.reports.length > 0 && this.ranker !== null && this.ranker !== "personal", (el) => el.child(div().px(8).pb(4).text_size(11.5).text_color(t.dim).child("No personal ranking yet: PostHog's recommended order.")))
        .children(this.reports.map((r) => this.reportRow(r, t, shown)))
        .when(this.count > this.reports.length, (el) => el.child(h_flex().id("inbox-more").h(30).px(8).mt(2).flex_none().items_center().rounded(8).text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.more(cx))
          .child(this.loading ? "Loading…" : `Show ${Math.min(PAGE, this.count - this.reports.length)} more`))));
  }
}
