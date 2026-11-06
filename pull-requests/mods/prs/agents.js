import { notify } from "herdr";
import { store, updateStore, prKey, newId } from "./store.js";
import { config, loadConfig } from "./config.js";
import { runnerMachine, runsDir, checkoutFor, launchClaudeOnPr, startHeadless, readRuns, readRunFile } from "./runner.js";

const LENSES = {
  correctness: "Logic errors: wrong conditions, off-by-one errors, unhandled cases, broken invariants, incorrect API use, and behavior that contradicts the PR description.",
  security: "Security problems: injection, missing authorization or tenant scoping, secrets in code or logs, unsafe deserialization, SSRF, and trust placed in user input.",
  reliability: "Reliability problems: unbounded work, missing timeouts or retries, race conditions, resource leaks, N+1 queries, and failure modes that take down more than they should.",
  tests: "Test gaps: changed behavior without a test, tests that can't fail, assertions that miss the point, and flaky patterns such as sleeps or order dependence.",
};

function lensPrompt(pr, lens, dir) {
  return `Review pull request ${pr.repo}#${pr.number} through one lens: ${lens}.
Look for: ${LENSES[lens]}

The PR diff is in ${dir}/diff.patch and its title and description are in ${dir}/pr.json. The current directory is the PR head on a detached HEAD, so you can read every touched file and its surroundings.

Rules:
- Read only. Make no edits, commits or pushes.
- Report only what a careful reviewer would block on or ask about. No style nits unless they hide a bug.
- Every finding must point at code this diff changes, at a real path and line in the PR head.

Write each finding as one JSON object on its own line, with nothing else on that line:
{"lens": "${lens}", "path": "src/file.ts", "line": 42, "title": "Short title", "body": "What is wrong, why it matters, and what to do.", "severity": "blocker|warning|nit", "confidence": 0.8}

Write no findings if you found none.`;
}

function judgePrompt(pr, dir) {
  return `You judge a code review of pull request ${pr.repo}#${pr.number}. Several reviewers each looked through one lens and wrote findings to ${dir}/lens_findings.jsonl, one JSON object per line. The PR diff is in ${dir}/diff.patch, and the current directory is the PR head.

Rules:
- Read only. Make no edits, commits or pushes.
- Check every finding against the code and drop it if the code doesn't support it.
- Merge duplicates into one finding, keeping the clearest title and body.
- Keep at most 15 findings, most important first.

Write each surviving finding as one JSON object on its own line, with nothing else on that line, in the same shape plus a one-line "reason" saying why it holds up:
{"lens": "correctness", "path": "src/file.ts", "line": 42, "title": "Short title", "body": "What is wrong and what to do.", "severity": "blocker|warning|nit", "confidence": 0.9, "reason": "Why this holds up."}`;
}

export function fixPrompt(pr, extra = "") {
  return `Get my pull request ${pr.url} (${pr.repo}#${pr.number}, branch ${pr.headRef}) mergeable. You're in a worktree with that branch checked out.

Keep going until all three hold:
1. Every review thread is resolved. Human feedback comes first. Bot comments are advisory: check each claim against the code, then fix it or reply with the reason it doesn't apply, and resolve the thread either way.
2. CI is green on the head commit. Read the current failing logs with gh, fix real failures, and prove any claim that a failure isn't caused by this PR (for example, it fails on the base branch too).
3. The branch merges cleanly into ${pr.baseRef}: no conflicts and not behind. Merge the base in; don't rebase.
${extra ? `\nFocus first on this:\n${extra}\n` : ""}
Rules:
- Never pass --no-verify or bypass hooks, never force-push, and never skip, disable or loosen a test to make it pass.
- Use conventional commit messages. Don't amend or rebase commits already on the remote.
- Never merge, enqueue or approve the PR.
- Show me what you plan to push before you push, and ask before replying on GitHub.`;
}

export function findingsFixPrompt(pr, findings) {
  const list = findings.map((finding, index) => `${index + 1}. [${finding.severity ?? "finding"}] ${finding.title}${finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""}\n   ${finding.body}`).join("\n");
  return fixPrompt(pr, `These code review findings. Check each against the code; fix the valid ones and tell me why the others don't apply:\n${list}`);
}

export function reviewPromptForOthers(pr) {
  return `Review the pull request ${pr.url} (${pr.repo}#${pr.number} by @${pr.author}). You're in a worktree with its branch checked out. Read the description and diff with gh pr view and gh pr diff, read the touched code around the changes, and tell me what a careful reviewer would block on or ask about: correctness, security, reliability, and missing tests. Don't post anything to GitHub.`;
}

export async function startFixSession(pr, prompt, label = "fix") {
  await loadConfig();
  const machine = await launchClaudeOnPr(pr, prompt, `${label} #${pr.number}`);
  return updateStore((state) => {
    const id = newId();
    state.runs[id] = { id, kind: label, interactive: true, machine, repo: pr.repo, number: pr.number, title: pr.title, startedAt: new Date().toISOString(), status: "interactive", tabName: `${label} #${pr.number}` };
  });
}

export async function startReview(pr) {
  await loadConfig();
  const id = newId();
  const machine = runnerMachine();
  const dir = `${await runsDir(machine)}/${id}`;
  const prompts = [...Object.keys(LENSES).map((lens) => lensPrompt(pr, lens, dir)), judgePrompt(pr, dir)];
  const models = config().models;
  const terminal = await startHeadless(id, [dir, pr.repo, String(pr.number), await checkoutFor(pr.repo, machine), models.review, models.judge, ...prompts], machine);
  await updateStore((state) => {
    state.runs[id] = { id, kind: "review", interactive: false, machine, repo: pr.repo, number: pr.number, title: pr.title, headSha: pr.headSha ?? null, startedAt: new Date().toISOString(), status: "running", terminal };
  });
  return id;
}

function parseFindings(text, run) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (!value.title && !value.body) continue;
      out.push({
        id: `${run.id}-${out.length + 1}`,
        runId: run.id,
        lens: value.lens ?? null,
        path: value.path ?? null,
        line: Number.isInteger(value.line) ? value.line : null,
        title: String(value.title ?? value.body).slice(0, 200),
        body: String(value.body ?? ""),
        severity: value.severity ?? null,
        confidence: typeof value.confidence === "number" ? value.confidence : null,
        reason: value.reason ?? null,
        state: "open",
        headSha: run.headSha ?? null,
      });
    } catch {}
  }
  return out;
}

const REVIEW_DEADLINE_MS = 2 * 3600000;
const MISSING_GRACE_MS = 10 * 60000;

function stalled(run, status) {
  const age = Date.now() - Date.parse(run.startedAt);
  if (status === "missing") return age > MISSING_GRACE_MS;
  return status === "running" && age > REVIEW_DEADLINE_MS;
}

export async function syncRuns() {
  const running = Object.values(store().runs).filter((run) => !run.interactive && run.status === "running");
  if (!running.length) return false;
  const statuses = {};
  for (const machine of [...new Set(running.map((run) => run.machine ?? null))]) {
    Object.assign(statuses, await readRuns(machine, running.filter((run) => (run.machine ?? null) === machine).map((run) => run.id)));
  }
  for (const run of running) {
    if (stalled(run, statuses[run.id]?.status)) statuses[run.id] = { status: "failed", summary: "The review stopped responding: its worker exited or the machine restarted." };
  }
  const finished = running.filter((run) => ["done", "failed"].includes(statuses[run.id]?.status)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (!finished.length) return false;
  const findingsByRun = {};
  for (const run of finished) {
    if (statuses[run.id].status === "done" && run.kind === "review") findingsByRun[run.id] = parseFindings(await readRunFile(run.machine ?? null, run.id, "findings.jsonl"), run);
  }
  await updateStore((state) => {
    state.findingsFrom ??= {};
    for (const run of finished) {
      const target = state.runs[run.id];
      if (!target) continue;
      target.status = statuses[run.id].status;
      target.summary = statuses[run.id].summary;
      target.finishedAt = new Date().toISOString();
      const findings = findingsByRun[run.id];
      if (!findings) continue;
      target.findingCount = findings.length;
      const key = prKey(run.repo, run.number);
      const current = state.findingsFrom[key];
      if (current && Date.parse(current.startedAt) > Date.parse(run.startedAt)) {
        target.summary = `${target.summary} Superseded by a newer review.`;
        continue;
      }
      const dismissed = new Set((state.findings[key] ?? []).filter((finding) => finding.state === "dismissed").map((finding) => `${finding.path}:${finding.title}`));
      const kept = (state.findings[key] ?? []).filter((finding) => finding.state !== "open");
      for (const finding of findings) if (dismissed.has(`${finding.path}:${finding.title}`)) finding.state = "dismissed";
      state.findings[key] = [...findings, ...kept.filter((finding) => finding.runId !== run.id)];
      state.findingsFrom[key] = { runId: run.id, startedAt: run.startedAt };
      target.findingCount = findings.filter((finding) => finding.state === "open").length;
    }
  });
  for (const run of finished) {
    const ok = statuses[run.id].status === "done";
    notify({ title: `Review of #${run.number} ${ok ? "finished" : "failed"}`, body: statuses[run.id].summary || run.title, level: ok ? "success" : "error", timeout: 10000 });
  }
  return true;
}

export function setFindingState(key, findingId, value) {
  return updateStore((state) => {
    for (const finding of state.findings[key] ?? []) if (finding.id === findingId) finding.state = value;
  });
}

export function findingsMarkdown(findings) {
  return [
    "**Code review findings**",
    "",
    ...findings.map((finding) => `- **${finding.title}**${finding.path ? ` — \`${finding.path}${finding.line ? `:${finding.line}` : ""}\`` : ""}${finding.severity ? ` (${finding.severity})` : ""}\n  ${finding.body.replace(/\n/g, "\n  ")}`),
  ].join("\n");
}
