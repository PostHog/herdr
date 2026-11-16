// What the buttons do: start a task locally or in PostHog's cloud, hand its
// pull request to the report, archive it. Every PostHog write here follows a click.

import { run, knownAgents, notify, shared, setShared, spaces } from "herdr";
import { ph, loadConfig, checkoutOf } from "./ph.js";
import { repoInfo, addWorktree, removeWorktree, createPullRequest, slug } from "./git.js";
import { saveTask, patchTask, taskOfReport, spaceOf, newId } from "./store.js";

export const branchFor = (title, prefix) => `${prefix}/${slug(title, 44)}`;
const short = (title) => (title.length > 34 ? `${title.slice(0, 33)}…` : title);
const OPEN = new Set(["open", "draft"]);

// The report's pull request still worth continuing, if any.
export const openPr = (report) => (report?.pull_requests ?? []).find((p) => OPEN.has(p.state) && !p.merged)?.url ?? null;

// Whoever else holds the report, as "Name" (null: free, or one of `mine`, the
// ids of the reports this user claimed).
export function heldByOther(report, mine) {
  const a = report?.assignee;
  if (!a || (mine ?? []).includes(report.id)) return null;
  const u = a.responsible_user ?? a.user;
  return u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email : "someone else";
}

export function reportPrompt(report, branch) {
  return [
    `You are picking up the PostHog inbox report "${report.title}".`,
    `Report: ${report._posthogUrl} (id ${report.id})`,
    "",
    report.summary ?? "",
    "",
    "Before changing code:",
    `1. Read the report's work log with the PostHog MCP: inbox-report-artefacts-list with report_id ${report.id}. Follow the newest "## Verification plan" if it has one.`,
    "2. Verify the diagnosis against the code in this checkout. A report is a diagnosis, not ground truth: if it does not hold up, stop and say why instead of implementing.",
    "",
    `Then implement the fix on this branch (${branch}) and commit it. Do not claim the report or attach pull requests yourself: the Herdr inbox does that. If you open a pull request, reference ${report._posthogUrl} in its description.`,
  ].join("\n");
}

async function agentNamed(name) {
  const list = await knownAgents();
  const agent = list.find((a) => a.key === name && a.installed) ?? list.find((a) => a.installed);
  if (!agent) throw new Error("No coding agent is installed on this machine.");
  return agent;
}

// A worktree, a space in it, an agent with `prompt` as its first message, and
// the task record. `report`: also claims it unless `claim` is false.
export async function startLocal({ title, prompt, repoPath, branch, agent, report = null, continuePr = null, claim = true, step = () => {} }) {
  step("Checking the repository…");
  const repo = await repoInfo(repoPath);
  if (!repo) throw new Error(`${repoPath} is not a git repository.`);
  const made = await addWorktree(repo, branch, { pr: continuePr, step });
  let claimId = null, claimError = null;
  if (report && claim) {
    step("Claiming the report…");
    try {
      claimId = (await ph("inbox-reports-claim", { id: report.id }))?.assignee?.claim_id ?? null;
    } catch (e) {
      claimError = e.message;
    }
  }
  step("Starting the agent…");
  const program = await agentNamed(agent);
  const text = prompt ?? reportPrompt(report, made.branch);
  // Unnamed, so the space follows its checkout and nests under its repo.
  run("space.new", { folder: made.path, tab: short(title), argv: program.run, task: text });
  const old = report ? taskOfReport(report.id) : null;
  saveTask({
    ...(old ?? { id: newId(), created_at: Date.now(), state: "active" }),
    title,
    source: report ? "report" : "scratch",
    report_id: report?.id ?? null,
    report_url: report?._posthogUrl ?? null,
    claim_id: claimId ?? old?.claim_id ?? null,
    repo: repo.slug ?? repo.name,
    repo_path: repo.main,
    branch: made.branch,
    base: made.base,
    worktree: made.path,
    pr_url: continuePr ?? old?.pr_url ?? null,
    pr_attached: Boolean(continuePr) || (old?.pr_attached ?? false),
  });
  if (claimError) notify({ title: "Started, but the report wasn't claimed", body: claimError, level: "warning" });
}

// A PostHog cloud run on a report: one of its listed actions, or `ask` with a message.
export async function startCloudAction(report, { action, suggested_prompt_index = null, message = null }) {
  const args = { id: report.id, action };
  if (suggested_prompt_index !== null) args.suggested_prompt_index = suggested_prompt_index;
  if (message) args.message = message;
  const r = await ph("inbox-report-actions-run", args, 180000);
  const old = taskOfReport(report.id);
  saveTask({
    ...(old ?? { id: newId(), created_at: Date.now(), state: "active", source: "report", worktree: null, branch: null, repo: report.repo_slug ?? null }),
    title: old?.title ?? report.title,
    report_id: report.id,
    report_url: report._posthogUrl,
    cloud: { task_id: r.task_id, run_id: r.run_id ?? null, task_url: r.task_url ?? r._posthogUrl ?? null, started_at: Date.now() },
  });
  if (r.run_error) notify({ title: "The cloud task was created, but its run didn't start", body: String(r.run_error), level: "warning" });
  return r;
}

// A PostHog cloud task from scratch.
export async function startCloudTask({ title, prompt, repository }) {
  const r = await ph("tasks-create-and-run", { title, description: prompt, ...(repository ? { repository } : {}) }, 180000);
  saveTask({
    id: newId(), created_at: Date.now(), state: "active", source: "scratch", title,
    report_id: null, report_url: null, claim_id: null, repo: repository ?? null, repo_path: null, branch: null, base: null, worktree: null,
    cloud: { task_id: r.id ?? r.task_id, run_id: r.latest_run?.id ?? r.run_id ?? null, task_url: r._posthogUrl ?? r.task_url ?? null, started_at: Date.now() },
    pr_url: null, pr_attached: false,
  });
  if (r.run_error) notify({ title: "The cloud task was created, but its run didn't start", body: String(r.run_error), level: "warning" });
  return r;
}

// Tells the report about a task's pull request, once.
export async function attachPr(task, url) {
  patchTask(task.id, { pr_url: url, pr_attached: true });
  // Only for a report this task claimed: someone else's claim is theirs to update.
  if (!task.report_id || !task.claim_id) return;
  try {
    await ph("inbox-reports-claim", { id: task.report_id, claim_id: task.claim_id, pull_requests: [url] });
    notify({ title: "Pull request attached to the report", body: task.title, level: "success" });
  } catch (e) {
    notify({ title: "Couldn't attach the pull request to the report", body: e.message, level: "warning" });
  }
}

export async function openDraftPr(task) {
  const body = task.report_url ? `PostHog inbox report: ${task.report_url}` : "";
  const url = await createPullRequest(task.worktree, task.branch, task.title, body);
  await attachPr(task, url);
  return url;
}

// Closes the task's space, removes its worktree (the branch stays), and gives
// the report back when nothing landed.
export async function archiveTask(task, { force = false, merged = false, step = () => {} } = {}) {
  const space = spaceOf(task);
  if (space) run("space.close", { id: space.id, confirmed: true });
  if (task.worktree) {
    step("Removing the worktree…");
    await removeWorktree(task.repo_path, task.worktree, force);
  }
  if (task.report_id && task.claim_id && !merged) {
    step("Releasing the report…");
    try {
      const report = await ph("inbox-reports-retrieve", { id: task.report_id });
      const landed = ["resolved", "monitoring", "closed", "suppressed"].includes(report.status) || (report.pull_requests ?? []).some((p) => p.merged);
      if (!landed && report.assignee?.claim_id === task.claim_id) await ph("inbox-reports-claim", { id: task.report_id, release: true });
    } catch (e) {
      notify({ title: "Archived, but the report's claim wasn't released", body: e.message, level: "warning" });
    }
  }
  saveTask({ ...task, state: "archived", archived_at: Date.now() });
}

// A report started with the defaults: its own repository's checkout (else the
// default one), an inbox/ branch or its open pull request, the configured agent.
// The space you were in stays the one shown.
export async function startReport(row, step = () => {}) {
  step("Reading the report…");
  const config = await loadConfig();
  const report = { ...row, ...(await ph("inbox-reports-retrieve", { id: row.id })) };
  // A report that names its repository starts there or not at all.
  const repoPath = checkoutOf(config, report.repo_slug ?? config.default_repo);
  if (!repoPath) throw new Error(`No local checkout is configured for ${report.repo_slug ?? "the default repository"}.`);
  const here = spaces().find((s) => s.active)?.id;
  await startLocal({ title: report.title, repoPath, branch: branchFor(report.title, "inbox"), agent: config.agent, report, continuePr: openPr(report), step });
  step("Opening the space…");
  if (here) run("space.select", { id: here });
}

// Jobs: work asked for by a view that may close before it ends (triage). They
// wait in shared state and the sidebar, which stays, does them one at a time:
// { kind: "start" | "claim" | "release", report: { id, title, _posthogUrl }, at,
//   step: what it is doing now, error: why it stopped }
// A failed job stays, shown under Tasks, until it is dismissed or tried again.
// runJob answers whether it worked.
//   state, reason: for "dismiss" and "leave" }
// kind: "start" | "claim" | "release" | "dismiss" | "snooze" | "leave".
const JOBS = "ph-inbox.jobs";
const JOB_KEPT = 15 * 60000; // one left over from an earlier session is not done late

export const jobs = () => (shared(JOBS) ?? []).filter((j) => Date.now() - j.at < JOB_KEPT);
export const waitingJobs = () => jobs().filter((j) => !j.error);
export const jobOf = (reportId) => waitingJobs().find((j) => j.report.id === reportId) ?? null;
export const dropJob = (reportId) => setShared(JOBS, jobs().filter((j) => j.report.id !== reportId));
const patchJob = (reportId, patch) => setShared(JOBS, jobs().map((j) => (j.report.id === reportId ? { ...j, ...patch } : j)));

export function addJob(kind, report, more = {}) {
  if (jobOf(report.id)) return;
  const job = { kind, ...more, report: { id: report.id, title: report.title, _posthogUrl: report._posthogUrl }, at: Date.now() };
  setShared(JOBS, [...jobs().filter((j) => j.report.id !== report.id), job]);
}

const JOB_FAILED = {
  start: "Couldn't start the report", claim: "Couldn't claim the report", release: "Couldn't release the report",
  dismiss: "Couldn't dismiss the report", snooze: "Couldn't snooze the report", leave: "Couldn't step off the report",
};
// What a waiting job says on its report's row, and the kinds that take the report out of the inbox.
export const JOB_SAYS = { start: "starting…", claim: "claiming…", release: "releasing…", dismiss: "dismissing…", snooze: "snoozing…", leave: "leaving…" };
export const JOB_REMOVES = new Set(["dismiss", "snooze", "leave"]);

// Why a report is dismissed: [PostHog's reason code, what the choice says, the state it moves to].
export const DISMISS = [
  ["already_fixed", "Already fixed", "resolved"],
  ["no_action_needed", "No action needed", "resolved"],
  ["analysis_wrong", "Analysis is wrong", "suppressed"],
  ["report_unclear", "Unclear", "suppressed"],
  ["wontfix_intentional", "Intentional behaviour", "suppressed"],
  ["wontfix_irrelevant", "Not relevant", "suppressed"],
];
// Why you step off a report's reviewers.
export const LEAVE = [
  ["wrong_area", "Not my area"],
  ["already_covered", "Someone else is on it"],
  ["unavailable", "No bandwidth"],
];

// The PostHog call for a verdict that takes a report away.
export function sendVerdict(id, v) {
  if (v.kind === "dismiss") return ph("inbox-reports-set-state", { id, state: v.state, dismissal_reason: v.reason });
  if (v.kind === "snooze") return ph("inbox-reports-set-state", { id, state: "potential" });
  return ph("inbox-reports-leave-reviewers", { id, removal_reason: v.reason });
}

export async function runJob(job) {
  const r = job.report;
  let at = "";
  const step = (text) => { at = text; patchJob(r.id, { step: text }); };
  try {
    if (job.kind === "start") await startReport(r, step);
    else if (JOB_REMOVES.has(job.kind)) await sendVerdict(r.id, job);
    else {
      await ph("inbox-reports-claim", job.kind === "release" ? { id: r.id, release: true } : { id: r.id });
      const others = (shared("ph-inbox.mine") ?? []).filter((id) => id !== r.id);
      setShared("ph-inbox.mine", job.kind === "claim" ? [...others, r.id] : others);
    }
  } catch (e) {
    const error = `${at ? `${at.replace(/…$/, "")}: ` : ""}${e?.message ?? e}`;
    patchJob(r.id, { error });
    notify({ title: JOB_FAILED[job.kind], body: `${r.title}: ${error}`, level: "error" });
    return false;
  }
  dropJob(r.id);
  return true;
}
