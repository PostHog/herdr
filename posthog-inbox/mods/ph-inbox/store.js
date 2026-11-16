// Task records, shared by every copy of the mod (the sidebar, panes, dialogs):
// { id, title, source: "report" | "scratch", report_id, report_url, claim_id,
//   repo, repo_path, branch, base, worktree, cloud: { task_id, run_id, task_url },
//   pr_url, pr_attached, state: "active" | "archived", created_at, archived_at }
// Only what can't be read back live is stored: status comes from Herdr, git and gh.

import { shared, setShared, spaces, panes, run } from "herdr";

const KEY = "ph-inbox.tasks";
const KEPT_ARCHIVED = 20;

export const tasks = () => shared(KEY) ?? [];
export const activeTasks = () => tasks().filter((t) => t.state !== "archived");
export const archivedTasks = () => tasks().filter((t) => t.state === "archived");
export const taskById = (id) => tasks().find((t) => t.id === id) ?? null;
export const taskOfReport = (reportId) => activeTasks().find((t) => t.report_id === reportId) ?? null;
export const newId = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

// Adds a task, or replaces the one with its id in place.
export function saveTask(task) {
  const all = tasks();
  const next = all.some((t) => t.id === task.id) ? all.map((t) => (t.id === task.id ? task : t)) : [task, ...all];
  const archived = next.filter((t) => t.state === "archived").sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0)).slice(0, KEPT_ARCHIVED);
  setShared(KEY, [...next.filter((t) => t.state !== "archived"), ...archived]);
}

export const patchTask = (id, patch) => {
  const task = taskById(id);
  if (task) saveTask({ ...task, ...patch });
};

// The space showing a task's worktree: one with a terminal inside it, else one made there.
export function spaceOf(task) {
  if (!task?.worktree) return null;
  const inside = (path) => path === task.worktree || path?.startsWith(`${task.worktree}/`);
  const sp = spaces();
  const pane = panes().find((p) => inside(p.cwd));
  if (pane) return sp.find((s) => (s.tabs ?? []).some((t) => t.id === pane.tab)) ?? null;
  return sp.find((s) => inside(s.folder)) ?? null;
}

// Shows a task's space, on the tab its terminal is in (the space may have been
// left on another tab, such as a report). False when it has no space.
export function goToTask(task) {
  const space = spaceOf(task);
  if (!space) return false;
  const inside = (path) => path === task.worktree || path?.startsWith(`${task.worktree}/`);
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  const pane = panes().find((p) => tabs.has(p.tab) && inside(p.cwd));
  run("space.select", { id: space.id });
  if (pane) run("tab.select", { id: pane.tab });
  return true;
}
