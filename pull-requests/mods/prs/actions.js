import { exec, notify } from "herdr";
import { gh, fetchDetail, graphql, RESOLVE_THREAD } from "./github.js";
import { updateStore, prKey } from "./store.js";
import { enqueue, trunkRepo, TrunkUnavailable } from "./trunk.js";

export const isTrunkPr = (pr) => Boolean(trunkRepo()) && pr.repo === trunkRepo();
export const usesTrunk = (pr) => pr.queue?.provider === "trunk";
export const mergesThroughQueue = (pr) => isTrunkPr(pr) || usesTrunk(pr) || pr.queue?.provider === "github";

const commentTrunkMerge = (pr) => gh(["pr", "comment", String(pr.number), "-R", pr.repo, "-b", "/trunk merge"]);

export async function mergePr(pr) {
  if (isTrunkPr(pr)) {
    try {
      return await enqueue(pr.number);
    } catch (error) {
      if (!(error instanceof TrunkUnavailable)) throw error;
    }
    return commentTrunkMerge(pr);
  }
  if (usesTrunk(pr)) return commentTrunkMerge(pr);
  if (!pr.headSha) return { ok: false, message: "The PR's head commit isn't known yet; refresh and try again." };
  return gh(["pr", "merge", String(pr.number), "-R", pr.repo, "--squash", "--match-head-commit", pr.headSha]);
}

export function markReady(pr) {
  return gh(["pr", "ready", String(pr.number), "-R", pr.repo]);
}

export function updateBranch(pr) {
  return gh(["pr", "update-branch", String(pr.number), "-R", pr.repo]);
}

export async function rerunFailed(pr, detail) {
  const checks = (detail ?? (await fetchDetail(pr))).checks.filter((check) => check.bucket === "failed");
  const runIds = [...new Set(checks.map((check) => /\/actions\/runs\/(\d+)/.exec(check.url ?? "")?.[1]).filter(Boolean))];
  if (!runIds.length) return { ok: false, message: "No failed GitHub Actions runs to rerun." };
  const results = await Promise.all(runIds.map((id) => gh(["run", "rerun", id, "--failed", "-R", pr.repo])));
  const failed = results.filter((result) => !result.ok);
  return failed.length ? { ok: false, message: failed[0].message } : { ok: true, message: `Reran failed jobs in ${runIds.length} workflow run(s).` };
}

export function approvePr(pr) {
  if (!pr.headSha) return { ok: false, message: "The PR's head commit isn't known yet; refresh and try again." };
  return gh(["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/reviews`, "-f", "event=APPROVE", "-f", `commit_id=${pr.headSha}`, "--jq", '"Approved " + .commit_id[0:7] + "."']);
}

const findingHeading = (finding) => `**${finding.title}**${finding.severity ? ` (${finding.severity})` : ""}`;

function reviewBody(findings, unplaced) {
  const lines = [`**Agent review:** ${findings.length} finding${findings.length === 1 ? "" : "s"}.`];
  if (unplaced.length) lines.push("", ...unplaced.map((finding) => `- ${findingHeading(finding)}${finding.path ? ` — \`${finding.path}${finding.line ? `:${finding.line}` : ""}\`` : ""}\n  ${finding.body.replace(/\n/g, "\n  ")}`));
  return lines.join("\n");
}

function reviewArgs(pr, headSha, body, inline) {
  const args = ["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/reviews`, "-f", "event=COMMENT", "-f", `body=${body}`];
  if (headSha) args.push("-f", `commit_id=${headSha}`);
  for (const finding of inline) {
    args.push("-f", `comments[][path]=${finding.path}`, "-F", `comments[][line]=${finding.line}`, "-f", "comments[][side]=RIGHT", "-f", `comments[][body]=${findingHeading(finding)}\n\n${finding.body}`);
  }
  return [...args, "--jq", '"Posted a review with " + (.id | tostring) + "."'];
}

export async function postFindingsReview(pr, findings, headSha) {
  const inline = headSha ? findings.filter((finding) => finding.path && finding.line) : [];
  if (inline.length) {
    const placed = await gh(reviewArgs(pr, headSha, reviewBody(findings, findings.filter((finding) => !inline.includes(finding))), inline));
    if (placed.ok || !/HTTP 422/.test(placed.stderr ?? "")) return placed;
  }
  return gh(reviewArgs(pr, headSha, reviewBody(findings, findings), []));
}

export async function resolveThread(threadId) {
  await graphql(RESOLVE_THREAD, { threadId });
  return { ok: true, message: "Thread resolved." };
}

export async function openUrl(url) {
  await exec("open", [url]);
  return { ok: true, quiet: true };
}

export async function copyText(text, what = "Copied") {
  const result = await exec("osascript", ["-e", `set the clipboard to ${JSON.stringify(text)}`]);
  return { ok: result.code === 0, message: result.code === 0 ? what : result.stderr.trim() };
}

export const markdownLink = (pr) => `[${pr.title} (${pr.repo}#${pr.number})](${pr.url})`;

export function toggleWatch(pr) {
  const key = prKey(pr.repo, pr.number);
  return updateStore((state) => {
    state.watched = state.watched.includes(key) ? state.watched.filter((item) => item !== key) : [...state.watched, key];
  });
}

export function toggleHidden(pr) {
  const key = prKey(pr.repo, pr.number);
  return updateStore((state) => {
    const hidden = state.hiddenReviews.find((item) => item.key === key);
    state.hiddenReviews = hidden ? state.hiddenReviews.filter((item) => item.key !== key) : [...state.hiddenReviews, { key, at: new Date().toISOString() }];
  });
}

export async function report(title, work) {
  try {
    const result = await work();
    if (result && !result.quiet) notify({ title, body: result.message, level: result.ok ? "success" : "error", timeout: result.ok ? 5000 : 12000 });
    return result;
  } catch (error) {
    notify({ title, body: String(error?.message ?? error), level: "error", timeout: 12000 });
    return { ok: false, message: String(error?.message ?? error) };
  }
}
