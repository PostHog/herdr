// The mod's overlays, each opened with props { view, ... }:
//   pickup { report }  start a report locally (worktree + agent)
//   cloud  { report }  start one of a report's cloud actions, or ask
//   new                a task from scratch, local or cloud
//   action { action: "archive" | "pr", task, pr }  confirm, then do it
//   menu   { task, pr, git }  a task's right-click menu
//   report-menu { report }    a report's right-click menu

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, run, shared, knownAgents, pickFolder, notify } from "herdr";
import { ph, loadConfig, checkoutOf, expand } from "./ph.js";
import { repoInfo, worktreeStatus, slug } from "./git.js";
import { taskById, taskOfReport, spaceOf, goToTask } from "./store.js";
import { startLocal, startCloudAction, startCloudTask, openDraftPr, archiveTask, branchFor, openPr, heldByOther, addJob, jobOf, JOB_SAYS, DISMISS, LEAVE } from "./flows.js";
import { openReport } from "./sidebar.js";
import { button, choice, input, label, prNumber } from "./ui.js";

const close = () => closeOverlay(props().overlay);

// The frame every dialog shares: a title, a scrolling body, a status line and buttons.
function frame(view, t, title, body, buttons) {
  return v_flex().id("ph-dialog").track_focus(view.handle)
    .on_key_down((e, cx) => { if (e.key === "escape" && !view.busy) { close(); cx.stop_propagation(); } })
    .size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(13)
    .child(h_flex().flex_none().items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
    .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(body))
    .child(h_flex().flex_none().pt(14).gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(12).text_color(view.error ? t.blocked : t.dim).child(view.error ?? view.progress ?? ""))
      .children(buttons));
}

// Runs `work` with the dialog's progress line, closing it when the work is done.
function perform(view, cx, work, done) {
  if (view.busy) return;
  Object.assign(view, { busy: true, error: null, progress: "Working…" });
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      await work((text) => { view.progress = text; cx.notify(); });
      close();
      if (done) notify({ title: done, level: "success" });
    } catch (e) {
      Object.assign(view, { busy: false, error: e.message ?? String(e), progress: null });
      cx.notify();
    }
  });
}

// The installed agents, the configured one chosen.
async function loadAgents(view, config) {
  try {
    view.agents = (await knownAgents()).filter((a) => a.installed);
  } catch {
    view.agents = [];
  }
  view.agent = (view.agents.find((a) => a.key === config.agent) ?? view.agents[0])?.key ?? null;
}

const agentChoices = (view, t) => h_flex().gap(6).flex_wrap().children(view.agents.length
  ? view.agents.map((a) => choice(t, `agent-${a.key}`, a.name, view.agent === a.key, (_e, cx) => { view.agent = a.key; cx.notify(); }))
  : [div().text_size(12).text_color(t.blocked).child("No coding agent is installed.")]);

export class Pickup {
  init(p, cx) {
    this.handle = cx.focus_handle();
    this.report = p.report;
    this.pr = openPr(this.report);
    this.continuePr = Boolean(this.pr);
    this.held = heldByOther(this.report, shared("ph-inbox.mine"));
    this.claim = !this.held;
    this.agents = [];
    this.path = InputState.new({ placeholder: "~/path/to/checkout" });
    this.branch = InputState.new({ value: branchFor(this.report.title, "inbox") });
    cx.spawn(async (cx) => {
      const config = await loadConfig();
      const path = checkoutOf(config, this.report.repo_slug) ?? checkoutOf(config, config.default_repo);
      if (path) this.path.set_value(path);
      await loadAgents(this, config);
      cx.notify();
    });
    this.handle.focus();
  }

  start(cx) {
    const repoPath = expand(this.path.value().trim());
    const branch = this.branch.value().trim();
    if (!repoPath) return Object.assign(this, { error: "Choose the repository's local checkout." }) && cx.notify();
    if (!this.continuePr && !branch) return Object.assign(this, { error: "Name the branch." }) && cx.notify();
    perform(this, cx, (step) => startLocal({
      title: this.report.title, repoPath, branch, agent: this.agent, report: this.report,
      continuePr: this.continuePr ? this.pr : null, claim: this.claim, step,
    }));
  }

  render() {
    const t = theme();
    const number = prNumber(this.pr);
    const set = (patch) => (_e, cx) => { Object.assign(this, patch); cx.notify(); };
    return frame(this, t, "Start locally", [
      div().pt(4).text_size(12.5).text_color(t.muted).child(this.report.title),
      ...(this.held ? [div().pt(10).text_size(12).text_color(t.ansi3).child(`${this.held} holds this report. Starting here leaves their claim in place.`)] : []),
      label(t, `Local checkout${this.report.repo_slug ? ` of ${this.report.repo_slug}` : ""}`),
      h_flex().gap(8).items_center()
        .child(input(t, Input.new(this.path)).flex_1())
        .child(button(t, "browse", "Browse…", (_e, cx) => cx.spawn(async (cx) => { const dir = await pickFolder({ prompt: "Choose" }); if (dir) { this.path.set_value(dir); cx.notify(); } }))),
      ...(this.pr ? [label(t, "Start from"), h_flex().gap(6)
        .child(choice(t, "from-pr", `Pull request #${number}`, this.continuePr, set({ continuePr: true })))
        .child(choice(t, "from-new", "A new branch", !this.continuePr, set({ continuePr: false })))] : []),
      ...(this.continuePr ? [] : [label(t, "Branch"), input(t, Input.new(this.branch))]),
      label(t, "Agent"),
      agentChoices(this, t),
      ...(this.held ? [] : [label(t, "PostHog"), h_flex().gap(6)
        .child(choice(t, "claim-yes", "Claim the report", this.claim, set({ claim: true })))
        .child(choice(t, "claim-no", "Don't claim", !this.claim, set({ claim: false })))]),
    ], [
      button(t, "cancel", "Cancel", close, { disabled: this.busy }),
      button(t, "start", "Start", (_e, cx) => this.start(cx), { primary: true, disabled: this.busy || !this.agent }),
    ]);
  }
}

const ACTION_NAME = { get_it_merged: "Get it merged", make_it_green: "Make it green", suggested_prompt: "Suggested" };

export class Cloud {
  init(p, cx) {
    this.handle = cx.focus_handle();
    this.report = p.report;
    this.actions = null;
    this.ask = TextareaState.new({ placeholder: "Ask about this report, or say what to do…", rows: 3 });
    cx.spawn(async (cx) => {
      try {
        this.actions = (await ph("inbox-report-actions-list", { id: this.report.id })).results ?? [];
      } catch (e) {
        this.actions = [];
        this.error = e.message;
      }
      cx.notify();
    });
    this.handle.focus();
  }

  start(cx, args) {
    perform(this, cx, async (step) => {
      step("Starting the cloud run…");
      await startCloudAction(this.report, args);
    }, "Cloud run started");
  }

  render() {
    const t = theme();
    const local = taskOfReport(this.report.id);
    const row = (a, i) => h_flex().gap(10).py(8).items_start().border_b_1().border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(11.5).text_color(t.dim).child(ACTION_NAME[a.action] ?? a.action))
        .child(div().text_size(12.5).text_color(a.available ? t.foreground : t.dim).child(a.text ?? ""))
        .when(!a.available && Boolean(a.disabled_reason), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(a.disabled_reason))))
      .child(button(t, `run-${i}`, "Run", (_e, cx) => this.start(cx, { action: a.action, suggested_prompt_index: a.suggested_prompt_index ?? null }), { disabled: this.busy || !a.available }));
    return frame(this, t, "Start in cloud", [
      div().pt(4).text_size(12.5).text_color(t.muted).child(this.report.title),
      div().pt(6).text_size(11.5).text_color(t.dim).child("Each run is a PostHog cloud task, billed to your organization."),
      ...(local?.worktree ? [div().pt(8).text_size(12).text_color(t.ansi3).child("A local task is already working on this report. Two agents on one branch collide.")] : []),
      ...(this.actions === null ? [div().pt(14).text_size(12).text_color(t.dim).child("Loading the report's actions…")] : this.actions.map(row)),
      label(t, "Or ask"),
      Textarea.new(this.ask).h(76).p(8).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground),
      h_flex().pt(8).justify_end().child(button(t, "run-ask", "Run", (_e, cx) => {
        const message = this.ask.value().trim();
        if (message) this.start(cx, { action: "ask", message: message.slice(0, 2000) });
      }, { disabled: this.busy })),
    ], [button(t, "cancel", "Close", close, { disabled: this.busy })]);
  }
}

export class NewTask {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.config = { repos: {} };
    this.repo = null; // "owner/name" from the config, or a picked folder
    this.where = "local";
    this.agents = [];
    this.title = InputState.new({ placeholder: "Short name for the task" });
    this.prompt = TextareaState.new({ placeholder: "What should the agent do?", rows: 6 });
    this.branch = InputState.new({ placeholder: "task/<from the title>" });
    cx.spawn(async (cx) => {
      this.config = await loadConfig();
      this.repo = this.config.default_repo ?? Object.keys(this.config.repos)[0] ?? null;
      await loadAgents(this, this.config);
      cx.notify();
    });
    this.title.focus();
  }

  start(cx) {
    const title = this.title.value().trim();
    const prompt = this.prompt.value().trim();
    const fail = (error) => { this.error = error; cx.notify(); };
    if (!title) return fail("Give the task a title.");
    if (!prompt) return fail("Say what the agent should do.");
    if (!this.repo) return fail("Choose a repository.");
    const repoPath = checkoutOf(this.config, this.repo) ?? this.repo;
    if (this.where === "cloud") {
      return perform(this, cx, async (step) => {
        step("Starting the cloud task…");
        const repository = this.repo.startsWith("/") ? (await repoInfo(repoPath))?.slug : this.repo;
        if (!repository) throw new Error("That folder has no GitHub remote for a cloud task to use.");
        await startCloudTask({ title, prompt, repository });
      }, "Cloud task started");
    }
    const branch = this.branch.value().trim() || branchFor(title, "task");
    perform(this, cx, (step) => startLocal({ title, prompt, repoPath, branch, agent: this.agent, step }));
  }

  render() {
    const t = theme();
    const set = (patch) => (_e, cx) => { Object.assign(this, patch); cx.notify(); };
    const repos = Object.keys(this.config.repos ?? {});
    const picked = this.repo && !repos.includes(this.repo) ? [this.repo] : [];
    return frame(this, t, "New task", [
      label(t, "Title"),
      input(t, Input.new(this.title)),
      label(t, "Instructions"),
      Textarea.new(this.prompt).h(132).p(8).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground),
      label(t, "Repository"),
      h_flex().gap(6).flex_wrap()
        .children([...repos, ...picked].map((r) => choice(t, `repo-${slug(r)}`, r.startsWith("/") ? r.split("/").pop() : r, this.repo === r, set({ repo: r }))))
        .child(choice(t, "repo-browse", "Browse…", false, (_e, cx) => cx.spawn(async (cx) => { const dir = await pickFolder({ prompt: "Choose" }); if (dir) { this.repo = dir; cx.notify(); } }))),
      label(t, "Run it"),
      h_flex().gap(6)
        .child(choice(t, "where-local", "Locally, in a worktree", this.where === "local", set({ where: "local" })))
        .child(choice(t, "where-cloud", "In PostHog's cloud", this.where === "cloud", set({ where: "cloud" }))),
      ...(this.where === "local" ? [label(t, "Branch"), input(t, Input.new(this.branch)), label(t, "Agent"), agentChoices(this, t)]
        : [div().pt(10).text_size(11.5).text_color(t.dim).child("A PostHog cloud task, billed to your organization.")]),
    ], [
      button(t, "cancel", "Cancel", close, { disabled: this.busy }),
      button(t, "create", "Start", (_e, cx) => this.start(cx), { primary: true, disabled: this.busy || (this.where === "local" && !this.agent) }),
    ]);
  }
}

// Archive a task, or open its draft pull request: says what will happen first.
export class Action {
  init(p, cx) {
    this.handle = cx.focus_handle();
    this.task = taskById(p.task);
    this.action = p.action;
    this.pr = p.pr ?? null;
    this.git = null;
    cx.spawn(async (cx) => {
      this.git = this.task?.worktree ? await worktreeStatus(this.task.worktree, this.task.base) : {};
      cx.notify();
    });
    this.handle.focus();
  }

  render() {
    const t = theme();
    const task = this.task, g = this.git;
    const line = (text, color) => div().pt(8).text_size(12.5).text_color(color ?? t.muted).child(text);
    if (!task) return frame(this, t, "Task", [line("This task is gone.")], [button(t, "cancel", "Close", close)]);
    if (this.action === "pr") {
      const blocked = !g ? "Checking the worktree…" : g.missing ? "The worktree is gone." : g.dirty ? `${g.dirty} uncommitted changes. Commit them first.` : !g.commits ? "There are no commits on this branch yet." : null;
      return frame(this, t, "Open a draft pull request", [
        line(task.title, t.foreground),
        line(`Pushes ${task.branch} to origin and opens a draft pull request on ${task.repo}.`),
        ...(task.report_id && task.claim_id ? [line("The pull request is then attached to the PostHog report.")] : []),
        ...(blocked ? [line(blocked, g ? t.blocked : t.dim)] : []),
      ], [
        button(t, "cancel", "Cancel", close, { disabled: this.busy }),
        button(t, "confirm", "Push and open", (_e, cx) => perform(this, cx, async (step) => { step("Pushing…"); await openDraftPr(task); }, "Draft pull request opened"), { primary: true, disabled: this.busy || Boolean(blocked) }),
      ]);
    }
    const merged = this.pr?.state === "merged";
    const lose = g?.dirty ? `${g.dirty} uncommitted changes will be lost.` : g?.unpushed && !merged ? `${g.unpushed} commits aren't pushed. The branch ${task.branch} stays in the repository.` : null;
    return frame(this, t, "Archive task", [
      line(task.title, t.foreground),
      ...(spaceOf(task) ? [line("Closes its space and the terminals in it.")] : []),
      ...(task.worktree ? [line(`Removes the worktree ${task.worktree.replace(/^.*\/\.herdr\//, "~/.herdr/")}. The branch is kept.`)] : []),
      ...(task.report_id && task.claim_id && !merged ? [line("Releases your claim on the PostHog report if nothing was merged.")] : []),
      ...(task.cloud ? [line("Its cloud task keeps running in PostHog.")] : []),
      ...(!g ? [line("Checking the worktree…", t.dim)] : lose ? [line(lose, t.blocked)] : []),
    ], [
      button(t, "cancel", "Cancel", close, { disabled: this.busy }),
      button(t, "confirm", g?.dirty ? "Discard and archive" : "Archive", (_e, cx) => perform(this, cx, (step) => archiveTask(task, { force: Boolean(g?.dirty), merged, step })), { primary: true, disabled: this.busy || !g }),
    ]);
  }
}

export class Menu {
  init(p) {
    this.task = taskById(p.task);
    this.pr = p.pr ?? null;
    this.git = p.git ?? null;
  }

  render() {
    const t = theme();
    const task = this.task;
    if (!task) return div();
    const act = (action) => () => openOverlay({ mod: "ph-inbox", kind: "dialog", modal: true, width: 480, height: 300, props: { view: "action", action, task: task.id, pr: this.pr } });
    const space = spaceOf(task);
    const prUrl = this.pr?.url ?? task.pr_url;
    const archived = task.state === "archived";
    const items = [
      space && ["Go to its space", () => goToTask(task)],
      !space && !archived && task.worktree && !this.git?.missing && ["Open a space in its worktree", () => run("space.new", { folder: task.worktree })],
      task.report_id && ["Read the report", () => openReport({ id: task.report_id, title: task.title, _posthogUrl: task.report_url })],
      task.report_url && ["Open the report in PostHog", (cx) => cx.open_url(task.report_url)],
      task.cloud?.task_url && ["Open the cloud task", (cx) => cx.open_url(task.cloud.task_url)],
      prUrl && [`Open pull request #${prNumber(prUrl)}`, (cx) => cx.open_url(prUrl)],
      !prUrl && !archived && task.worktree && ["Open a draft pull request…", act("pr")],
      !archived && ["Archive…", act("archive")],
    ].filter(Boolean);
    return v_flex().w_full().p(4).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .children(items.map(([text, action], i) => h_flex().id(`menu-${i}`).h(28).px(10).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { close(); action(cx); })
        .child(text)));
  }
}

const menuRow = (t, id, text, action) => h_flex().id(id).h(28).px(10).flex_none().items_center().rounded(6).cursor_pointer()
  .hover((s) => s.bg(t.hover)).on_click(action).child(div().flex_1().min_w(0).truncate().child(text));

// A report's right-click menu. Its choices become jobs (flows.js), which the
// sidebar does after this popup has closed. Dismiss and Not mine ask why first.
export class ReportMenu {
  init(p) {
    this.report = p.report;
    this.sub = null; // "dismiss" | "leave" while its reasons show
  }

  render() {
    const t = theme();
    const r = this.report;
    const root = v_flex().w_full().p(4).bg(t.popover).text_size(12.5).text_color(t.foreground);
    const job = (kind, more) => () => { close(); addJob(kind, r, more); };
    const note = (text, color) => div().px(10).py(5).text_size(11.5).text_color(color ?? t.dim).child(text);
    if (this.sub) {
      const pr = prNumber(openPr(r));
      return root
        .child(note(this.sub === "dismiss" ? "Dismiss because" : "Not mine because"))
        .children((this.sub === "dismiss" ? DISMISS : LEAVE).map(([reason, text, state], i) => menuRow(t, `why-${i}`, text, job(this.sub, { reason, state }))))
        .when(this.sub === "dismiss" && Boolean(pr), (el) => el.child(note(`Closes pull request #${pr}.`, t.ansi3)))
        .child(menuRow(t, "why-back", "Back", (_e, cx) => { this.sub = null; cx.notify(); }).text_color(t.muted));
    }
    const mine = shared("ph-inbox.mine") ?? [];
    const task = taskOfReport(r.id);
    const isMine = mine.includes(r.id);
    const held = heldByOther(r, mine);
    const busy = jobOf(r.id);
    const dialog = (view, width, height) => () => { close(); openOverlay({ mod: "ph-inbox", kind: "dialog", modal: true, width, height, props: { view, report: r } }); };
    const ask = (sub) => (_e, cx) => { this.sub = sub; cx.notify(); };
    const items = [
      ["Read the report", () => { close(); openReport(r); }],
      task && ["Go to its task", () => { close(); goToTask(task); }],
      ...(busy ? [] : [
        !task && !held && ["Start now", job("start")],
        !task && ["Start locally…", dialog("pickup", 540, 520)],
        ["Start in cloud…", dialog("cloud", 580, 560)],
        !held && !isMine && ["Claim", job("claim")],
        isMine && !task && ["Release my claim", job("release")],
        ["Dismiss…", ask("dismiss")],
        ["Snooze until it recurs", job("snooze")],
        !isMine && ["Not mine…", ask("leave")],
      ]),
      ["Open in PostHog", (_e, cx) => { close(); cx.open_url(r._posthogUrl); }],
    ].filter(Boolean);
    return root
      .when(Boolean(busy), (el) => el.child(note(`Busy: ${JOB_SAYS[busy.kind]}`)))
      .when(Boolean(held), (el) => el.child(note(`${held} holds this report.`)))
      .children(items.map(([text, action], i) => menuRow(t, `report-menu-${i}`, text, action)));
  }
}
