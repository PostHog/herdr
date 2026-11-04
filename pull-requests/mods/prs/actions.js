import { exec, notify } from "herdr";
import { gh, fetchDetail, graphql, RESOLVE_THREAD } from "./github.js";
import { updateStore, prKey } from "./store.js";

export const usesTrunk = (pr) => pr.queue?.provider === "trunk";

export function mergePr(pr) {
  if (usesTrunk(pr)) return gh(["pr", "comment", String(pr.number), "-R", pr.repo, "-b", "/trunk merge"]);
  return gh(["pr", "merge", String(pr.number), "-R", pr.repo, "--squash"]);
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
  return gh(["pr", "review", String(pr.number), "-R", pr.repo, "--approve"]);
}

export function commentOnPr(pr, body) {
  return gh(["pr", "comment", String(pr.number), "-R", pr.repo, "-b", body]);
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
