import { notify } from "herdr";
import { store, updateStore, prKey } from "./store.js";
import { readyToMerge } from "./github.js";
import { gh } from "./github.js";
import { mergePr } from "./actions.js";
import { startReview, startFixSession, fixPrompt } from "./agents.js";

export const TRIGGERS = [
  { id: "pr_opened", label: "PR opened" },
  { id: "pr_ready_for_review", label: "Marked ready for review" },
  { id: "pr_converted_to_draft", label: "Converted to draft" },
  { id: "pushed", label: "New commits pushed" },
  { id: "checks_passed", label: "Checks passed" },
  { id: "checks_failed", label: "Checks failed" },
  { id: "approved", label: "Approved" },
  { id: "changes_requested", label: "Changes requested" },
  { id: "became_conflicting", label: "Has conflicts" },
  { id: "became_behind", label: "Fell behind base" },
  { id: "became_ready", label: "Ready to merge" },
  { id: "labeled", label: "Label added" },
  { id: "review_requested", label: "My review requested" },
];

export const ACTION_KINDS = [
  { id: "add_labels", label: "Add labels", input: "Labels, comma-separated" },
  { id: "remove_labels", label: "Remove labels", input: "Labels, comma-separated" },
  { id: "comment", label: "Comment", input: "Comment text ({{pr.number}}, {{pr.title}}, {{pr.author}})" },
  { id: "request_reviewers", label: "Request reviewers", input: "Logins or org/team, comma-separated" },
  { id: "notify", label: "Notify me", input: "Message" },
  { id: "merge", label: "Merge or send to the merge queue" },
  { id: "agent_review", label: "Run an agent review (read-only)" },
  { id: "fix_session", label: "Open a Claude fix session" },
];

const MAX_RUNS_PER_PR_PER_HOUR = 5;

const summary = (pr) => ({
  isDraft: pr.isDraft,
  headSha: pr.headSha,
  labels: pr.labels,
  conflicting: pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY",
  behind: pr.mergeState === "BEHIND",
  decision: pr.reviewDecision,
  checks: pr.checks.inProgress > 0 ? "running" : pr.checks.failed > 0 && pr.mergeState !== "UNSTABLE" ? "failed" : pr.checks.total > 0 ? "passed" : "none",
  ready: readyToMerge(pr),
});

function eventsFor(before, after) {
  if (!before) return [{ kind: "pr_opened" }];
  const events = [];
  if (before.isDraft && !after.isDraft) events.push({ kind: "pr_ready_for_review" });
  if (!before.isDraft && after.isDraft) events.push({ kind: "pr_converted_to_draft" });
  if (before.headSha && after.headSha && before.headSha !== after.headSha) events.push({ kind: "pushed" });
  if (after.checks !== before.checks && after.checks === "passed") events.push({ kind: "checks_passed" });
  if (after.checks !== before.checks && after.checks === "failed") events.push({ kind: "checks_failed" });
  if (after.decision !== before.decision && after.decision === "APPROVED") events.push({ kind: "approved" });
  if (after.decision !== before.decision && after.decision === "CHANGES_REQUESTED") events.push({ kind: "changes_requested" });
  if (after.conflicting && !before.conflicting) events.push({ kind: "became_conflicting" });
  if (after.behind && !before.behind) events.push({ kind: "became_behind" });
  if (after.ready && !before.ready) events.push({ kind: "became_ready" });
  for (const label of after.labels) if (!before.labels.includes(label)) events.push({ kind: "labeled", label });
  return events;
}

const list = (text) => String(text ?? "").split(",").map((item) => item.trim()).filter(Boolean);

function matches(workflow, pr, viewer) {
  const c = workflow.conditions ?? {};
  if (c.repos?.length && !c.repos.includes(pr.repo)) return false;
  if (c.mineOnly && pr.author !== viewer) return false;
  if (c.draft === "yes" && !pr.isDraft) return false;
  if (c.draft === "no" && pr.isDraft) return false;
  if (c.base && pr.baseRef !== c.base) return false;
  const labels = pr.labels.map((label) => label.toLowerCase());
  const any = list(c.labelsAny).map((label) => label.toLowerCase());
  const none = list(c.labelsNone).map((label) => label.toLowerCase());
  if (any.length && !any.some((label) => labels.includes(label))) return false;
  if (none.some((label) => labels.includes(label))) return false;
  if (c.titleContains && !pr.title.toLowerCase().includes(c.titleContains.toLowerCase())) return false;
  return true;
}

const fill = (text, pr) => String(text ?? "").replaceAll("{{pr.number}}", String(pr.number)).replaceAll("{{pr.title}}", pr.title).replaceAll("{{pr.author}}", pr.author).replaceAll("{{pr.url}}", pr.url);

async function runAction(action, pr) {
  const target = [String(pr.number), "-R", pr.repo];
  switch (action.kind) {
    case "add_labels":
      return gh(["pr", "edit", ...target, "--add-label", list(action.value).join(",")]);
    case "remove_labels":
      return gh(["pr", "edit", ...target, "--remove-label", list(action.value).join(",")]);
    case "comment":
      return gh(["pr", "comment", ...target, "-b", fill(action.value, pr)]);
    case "request_reviewers":
      return gh(["pr", "edit", ...target, "--add-reviewer", list(action.value).join(",")]);
    case "notify":
      notify({ title: `#${pr.number} ${pr.title}`, body: fill(action.value, pr) || "Workflow matched.", level: "info", timeout: 10000 });
      return { ok: true, message: "Notified." };
    case "merge":
      return mergePr(pr);
    case "agent_review":
      await startReview(pr);
      return { ok: true, message: "Agent review started." };
    case "fix_session":
      await startFixSession(pr, fixPrompt(pr));
      return { ok: true, message: "Fix session opened." };
    default:
      return { ok: false, message: `Unknown action ${action.kind}` };
  }
}

export async function processSnapshot({ viewer, prs, reviews }) {
  const state = store();
  const seeded = Object.keys(state.lastPrs).length > 0;
  const nextSummaries = {};
  const fired = [];
  for (const pr of prs) {
    const key = prKey(pr.repo, pr.number);
    const after = summary(pr);
    nextSummaries[key] = after;
    if (seeded) for (const event of eventsFor(state.lastPrs[key], after)) fired.push({ pr, event });
  }
  const previousReviews = new Set(state.lastReviewKeys ?? []);
  const reviewKeys = (reviews ?? []).map((pr) => prKey(pr.repo, pr.number));
  if (seeded && reviews) for (const pr of reviews) if (!previousReviews.has(prKey(pr.repo, pr.number))) fired.push({ pr, event: { kind: "review_requested" } });

  const hourAgo = Date.now() - 3600000;
  const recent = (state.workflowLog ?? []).filter((entry) => Date.parse(entry.at) > hourAgo);
  const log = [];
  for (const { pr, event } of fired) {
    for (const workflow of state.workflows.filter((item) => item.enabled !== false && item.triggers?.includes(event.kind))) {
      if (!matches(workflow, pr, viewer)) continue;
      const key = prKey(pr.repo, pr.number);
      const used = recent.filter((entry) => entry.pr === key).length + log.filter((entry) => entry.pr === key).length;
      if (used >= MAX_RUNS_PER_PR_PER_HOUR) continue;
      const results = [];
      for (const action of workflow.actions ?? []) {
        try {
          const result = await runAction(action, pr);
          results.push(`${action.kind}: ${result.ok ? "ok" : result.message}`);
          if (!result.ok) break;
        } catch (error) {
          results.push(`${action.kind}: ${String(error?.message ?? error)}`);
          break;
        }
      }
      log.push({ at: new Date().toISOString(), workflow: workflow.id, name: workflow.name, pr: key, event: event.kind, results });
    }
  }
  await updateStore((next) => {
    next.lastPrs = nextSummaries;
    if (reviews) next.lastReviewKeys = reviewKeys;
    next.workflowLog = [...log, ...(next.workflowLog ?? [])].slice(0, 200);
  });
  return log;
}
