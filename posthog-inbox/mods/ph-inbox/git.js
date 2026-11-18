// Git and gh for tasks: worktrees under ~/.herdr/worktrees (where Herdr's own
// worktree mod puts them), their status, their pull request.

import { exec, home } from "herdr";

// Reads that neither take the index lock nor wake a folder watch.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

export async function git(cwd, args, timeout = 30000) {
  try {
    const r = await exec("git", args, { cwd, timeout });
    return { ok: r.code === 0, out: r.stdout.replace(/\n$/, ""), err: r.stderr.trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

export const slug = (text, max = 48) =>
  text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, max).replace(/[-.]+$/, "");

// A checkout's repo: its main folder, "owner/name" on GitHub, and the branch new work starts from.
export async function repoInfo(path) {
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const main = common.ok && common.out.endsWith("/.git") ? common.out.slice(0, -5) : top.out;
  const url = await git(main, ["remote", "get-url", "origin"]);
  const m = url.ok ? url.out.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/) : null;
  let base = null;
  const head = await git(main, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out) base = head.out;
  for (const b of base ? [] : ["origin/main", "origin/master"]) {
    if ((await git(main, ["rev-parse", "--verify", "-q", b])).ok) { base = b; break; }
  }
  return { main, name: main.split("/").pop(), slug: m ? m[1] : null, base };
}

const worktreeRoot = (repo) => `${home()}/.herdr/worktrees/${repo.name}`;
const isCheckout = async (path) => (await git(path, ["rev-parse", "--show-toplevel"])).out === path;

// A worktree on `branch` (made from the remote's default branch when new), or
// on a pull request's own branch. Returns { path, branch, base }.
export async function addWorktree(repo, branch, { pr = null, step = () => {} } = {}) {
  if (repo.base) {
    step("Fetching the latest base branch…");
    await git(repo.main, ["fetch", "origin", repo.base.replace(/^origin\//, "")], 300000);
  }
  const base = repo.base ?? "HEAD";
  if (pr) {
    const path = `${worktreeRoot(repo)}/pr-${pr.split("/").pop()}`;
    if (!(await isCheckout(path))) {
      step("Creating the worktree…");
      const add = await git(repo.main, ["worktree", "add", "--detach", path, base], 600000);
      if (!add.ok) throw new Error(add.err || "git worktree add failed");
    }
    step("Checking out the pull request…");
    const r = await exec("gh", ["pr", "checkout", pr], { cwd: path, timeout: 300000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "gh pr checkout failed");
    const now = await git(path, ["symbolic-ref", "-q", "--short", "HEAD"]);
    return { path, branch: now.out || branch, base };
  }
  const path = `${worktreeRoot(repo)}/${slug(branch, 80)}`;
  if (await isCheckout(path)) return { path, branch, base };
  step("Creating the worktree…");
  const exists = (await git(repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  // --no-track: the new branch must not push to the base branch.
  const args = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "--no-track", "-b", branch, path, base];
  const add = await git(repo.main, args, 600000);
  if (!add.ok) throw new Error(add.err || "git worktree add failed");
  return { path, branch, base };
}

export async function removeWorktree(repoPath, path, force) {
  const r = await git(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), path], 600000);
  if (!r.ok && !/is not a working tree|No such file or directory/i.test(r.err)) throw new Error(r.err || "git worktree remove failed");
}

// { missing } or { branch, dirty, commits (since base), unpushed }.
export async function worktreeStatus(path, base) {
  if (!(await git(path, ["rev-parse", "--show-toplevel"])).ok) return { missing: true };
  const [branch, changes, commits, upstream] = await Promise.all([
    git(path, [...READ, "symbolic-ref", "-q", "--short", "HEAD"]),
    git(path, [...READ, "status", "--porcelain"], 120000),
    base ? git(path, ["rev-list", "--count", `${base}..HEAD`]) : Promise.resolve({ ok: false }),
    git(path, ["rev-list", "--count", "@{upstream}..HEAD"]),
  ]);
  const made = commits.ok ? Number(commits.out) : 0;
  return {
    branch: branch.ok ? branch.out : "(detached)",
    dirty: changes.ok && changes.out ? changes.out.split("\n").length : 0,
    commits: made,
    unpushed: upstream.ok ? Number(upstream.out) : made,
  };
}

// The pull request of a worktree's branch, or of a URL. Null when there is none.
export async function pullRequest({ path = null, url = null }) {
  try {
    const args = ["pr", "view", ...(url ? [url] : []), "--json", "url,number,state,isDraft,reviewDecision,mergeable,statusCheckRollup"];
    const r = await exec("gh", args, { cwd: path ?? home(), timeout: 45000 });
    if (r.code !== 0) return null;
    const p = JSON.parse(r.stdout);
    const checks = p.statusCheckRollup ?? [];
    const bad = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
    return {
      url: p.url,
      number: p.number,
      state: p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.isDraft ? "draft" : "open",
      review: p.reviewDecision === "APPROVED" ? "approved" : p.reviewDecision === "CHANGES_REQUESTED" ? "changes" : null,
      conflict: p.mergeable === "CONFLICTING",
      failing: checks.filter((c) => bad.has(c.conclusion) || bad.has(c.state)).length,
      pending: checks.filter((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED").length,
      checks: checks.length,
    };
  } catch {
    return null;
  }
}

// Pushes the branch and opens a draft pull request. Returns its URL.
export async function createPullRequest(path, branch, title, body) {
  const push = await git(path, ["push", "-u", "origin", branch], 600000);
  if (!push.ok) throw new Error(push.err || "git push failed");
  const r = await exec("gh", ["pr", "create", "--draft", "--title", title, "--body", body], { cwd: path, timeout: 120000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "gh pr create failed");
  return r.stdout.trim().split("\n").pop();
}
