// Reads pull requests from `gh` and the merge queue from the `trunk` CLI.

import { exec, home, spaces } from "herdr";

// The repo whose merge queue is Trunk's.
export const TRUNK_REPO = "PostHog/posthog";
// Only PRs in this GitHub org show, in every tab.
export const ORG = "PostHog";

// Where people usually keep the checkout, under their home folder. Open spaces are tried first.
const CHECKOUT_GUESSES = ["Documents/posthog/posthog", "posthog", "code/posthog", "dev/posthog", "src/posthog", "projects/posthog", "repos/posthog", "git/posthog", "github/posthog", "workspace/posthog"];
const RECHECK_MS = 5 * 60000;

// Trunk can't be used here: no checkout, no CLI, or no login. Not worth retrying soon.
export class TrunkUnavailable extends Error {}

async function topLevel(dir) {
  try {
    const remote = await exec("git", ["-C", dir, "remote", "get-url", "origin"]);
    if (remote.code !== 0 || !/[:/]PostHog\/posthog(\.git)?\s*$/i.test(remote.stdout)) return null;
    const top = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    return top.code === 0 ? top.stdout.trim() : null;
  } catch (_e) {
    return null;
  }
}

// The PostHog/posthog checkout `trunk merge` runs in: Trunk finds the repo and queue from its git remote.
let checkout = { dir: undefined, at: 0 };
export async function posthogCheckout() {
  if (checkout.dir || (checkout.dir === null && Date.now() - checkout.at < RECHECK_MS)) return checkout.dir;
  const local = spaces().filter((s) => !s.machine && s.folder).map((s) => s.folder);
  const dirs = [...new Set([...local, ...CHECKOUT_GUESSES.map((d) => `${home()}/${d}`)])];
  let found = null;
  for (const d of dirs) if ((found = await topLevel(d))) break;
  checkout = { dir: found, at: Date.now() };
  return found;
}

const PR_FIELDS = `
  number title url isDraft createdAt updatedAt additions deletions
  repository { nameWithOwner }
  author { login }
  headRefName baseRefName
  reviewDecision mergeable mergeStateStatus
  reviewThreads(first: 100) { nodes { isResolved } }
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  commits(last: 1) { nodes { commit {
    status { contexts { context state description targetUrl } }
    statusCheckRollup { state contexts(first: 1) {
    totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }`;

const SEARCH = `query($q: String!) { search(query: $q, type: ISSUE, first: 60) { nodes { ... on PullRequest { ${PR_FIELDS} } } } }`;

// GitHub answers a slow search with a 502 or 504 now and then; asking again usually works.
const TRANSIENT = /HTTP 5\d\d|timeout|timed out|EOF|connection reset|something went wrong/i;

async function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await exec("gh", args);
    if (r.code === 0) {
      const body = JSON.parse(r.stdout);
      if (!body.errors?.length) return body.data;
      error = new Error(body.errors[0].message);
    } else {
      error = new Error(r.stderr.split("\n").filter((l) => l && !l.startsWith("*")).pop() || `gh exited ${r.code}`);
    }
    if (!TRANSIENT.test(error.message)) break;
  }
  throw error;
}

export async function login() {
  const r = await exec("gh", ["api", "user", "--jq", ".login"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

// Check counts by bucket. Skipped checks never ran, so they count toward nothing.
function checks(rollup) {
  const c = { state: rollup?.state ?? null, pass: 0, fail: 0, running: 0, cancelled: 0, total: 0 };
  const ctx = rollup?.contexts;
  for (const { state, count } of [...(ctx?.checkRunCountsByState ?? []), ...(ctx?.statusContextCountsByState ?? [])]) {
    if (!count) continue;
    if (state === "SUCCESS" || state === "NEUTRAL") c.pass += count;
    else if (["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"].includes(state)) c.fail += count;
    // A newer push or a concurrency group cancels runs; they rarely mean the code is broken.
    else if (state === "CANCELLED" || state === "STALE") { c.cancelled += count; continue; }
    else if (["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "EXPECTED", "REQUESTED"].includes(state)) c.running += count;
    else continue;
    c.total += count;
  }
  return c;
}

// PostHog's visual review posts one commit status per run type, linking to the run page
// where a person approves the changed snapshots.
function visual(contexts) {
  const out = [];
  for (const c of contexts ?? []) {
    const m = c.context.match(/^PostHog Visual Review \/ (\w+)( \(partial\))?$/);
    if (!m) continue;
    let kind;
    if (c.state === "FAILURE") kind = "approve";
    else if (c.state === "PENDING") kind = "running";
    else if (c.state === "ERROR") kind = "error";
    else continue;
    const changed = (c.description ?? "").match(/Visual changes detected: (.+)$/)?.[1];
    out.push({ type: m[1], partial: Boolean(m[2]), kind, url: c.targetUrl, summary: changed ?? c.description ?? "" });
  }
  return out;
}

function shape(n) {
  const reviews = n.latestOpinionatedReviews?.nodes ?? [];
  return {
    key: `${n.repository.nameWithOwner}#${n.number}`,
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    draft: n.isDraft,
    author: n.author?.login ?? "ghost",
    created: Date.parse(n.createdAt),
    updated: Date.parse(n.updatedAt),
    additions: n.additions,
    deletions: n.deletions,
    head: n.headRefName,
    base: n.baseRefName,
    decision: n.reviewDecision,
    conflicts: n.mergeable === "CONFLICTING",
    mergeState: n.mergeStateStatus,
    unresolved: (n.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
    approvedBy: reviews.filter((r) => r.state === "APPROVED").map((r) => r.author?.login),
    changesBy: reviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author?.login),
    requested: (n.reviewRequests?.nodes ?? []).map((r) => r.requestedReviewer?.login ?? (r.requestedReviewer?.slug ? `@${r.requestedReviewer.slug}` : null)).filter(Boolean),
    checks: checks(n.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    visual: visual(n.commits?.nodes?.[0]?.commit?.status?.contexts),
  };
}

export async function searchPrs(q) {
  const data = await graphql(SEARCH, { q: `${q} org:${ORG} is:pr is:open archived:false` });
  const prs = data.search.nodes.filter((n) => n?.number).map(shape);
  await markStackDepth(prs).catch(() => {});
  return prs;
}

const STACK_CHECK = "stack-depth / Stack depth";

// PostHog/posthog fails this check when a stack has too many open layers, which is about
// the stack's shape rather than the code. When it is a PR's only failing check, take it out
// of the check counts and set `pr.stack` so the panel can say what is actually wrong.
// The rollup only carries counts, so this asks for the check by name, for those PRs only.
async function markStackDepth(prs) {
  const lone = prs.filter((p) => p.repo === TRUNK_REPO && p.checks.fail === 1);
  if (!lone.length) return;
  const [owner, name] = TRUNK_REPO.split("/");
  const fields = lone.map((p, i) => `p${i}: pullRequest(number: ${p.number}) { commits(last: 1) { nodes { commit {
    checkSuites(first: 100) { nodes { checkRuns(first: 1, filterBy: { checkName: "${STACK_CHECK}", checkType: LATEST, conclusions: [FAILURE] }) {
    nodes { url annotations(first: 5) { nodes { title message } } } } } } } } } }`).join("\n");
  const data = await graphql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${fields} } }`, { o: owner, n: name });
  lone.forEach((pr, i) => {
    const suites = data.repository[`p${i}`]?.commits.nodes[0]?.commit.checkSuites.nodes ?? [];
    const run = suites.flatMap((s) => s.checkRuns.nodes)[0];
    if (!run) return;
    // The script's own annotation has a title; the runner adds an untitled exit-code one.
    const note = run.annotations.nodes.find((a) => a.title);
    pr.checks.fail = 0;
    pr.checks.total--;
    pr.stack = { checked: note?.title !== "Stack depth not checked", detail: note?.message ?? "", url: run.url };
  });
}

// Chains PRs whose base is another PR's head into stacks, bottom first.
export function stacks(prs) {
  const byHead = new Map(prs.map((p) => [`${p.repo}:${p.head}`, p]));
  const parent = new Map();
  for (const p of prs) {
    const below = byHead.get(`${p.repo}:${p.base}`);
    if (below && below !== p) parent.set(p.key, below);
  }
  const children = new Map();
  for (const [k, below] of parent) children.set(below.key, [...(children.get(below.key) ?? []), prs.find((p) => p.key === k)]);
  const groups = [];
  for (const root of prs.filter((p) => !parent.has(p.key))) {
    const members = [];
    const walk = (p, depth) => {
      members.push({ pr: p, depth });
      for (const c of (children.get(p.key) ?? []).sort((a, b) => a.number - b.number)) walk(c, depth + 1);
    };
    walk(root, 0);
    groups.push({ id: root.key, members, updated: Math.max(...members.map((m) => m.pr.updated)) });
  }
  return groups.sort((a, b) => b.updated - a.updated);
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const STATES = "Not Ready|Pending Failure|Tests Passed|Pending|Testing|Failed|Cancelled|Merged";

// `trunk` on PATH, else the one the checkout's flox environment provides.
let trunkBin = null;
async function trunk(args) {
  const dir = await posthogCheckout();
  if (!dir) throw new TrunkUnavailable("No PostHog/posthog checkout found. Open a space in it.");
  let flox = [];
  try {
    const r = await exec("/bin/sh", ["-c", 'ls -d "$1"/.flox/run/*/bin/trunk 2>/dev/null', "sh", dir]);
    flox = r.stdout.split("\n").filter(Boolean);
  } catch (_e) {
    // No flox environment: only PATH is left.
  }
  for (const bin of trunkBin ? [trunkBin] : ["trunk", ...flox]) {
    let r;
    try {
      r = await exec(bin, args, { cwd: dir });
    } catch (_e) {
      continue;
    }
    trunkBin = bin;
    const out = strip(r.stdout + r.stderr);
    if (/not logged in|trunk login|unauthenticated/i.test(out)) throw new TrunkUnavailable("Not logged in to Trunk. Run `trunk login`.");
    return { ...r, out };
  }
  throw new TrunkUnavailable("Trunk CLI not found. Install it or use the repo's flox environment.");
}

// The whole queue, in Trunk's order: recently merged, then testing, pending and not ready.
export async function queue() {
  const r = await trunk(["merge", "status", "--no-progress"]);
  const head = r.out.match(/Trunk Merge Status \[(.+?)\] \[(.+?)\]/);
  if (!head) throw new Error(r.out.trim().split("\n").pop() || "trunk merge status failed");
  const items = [];
  const re = new RegExp(`(${STATES})\\s+#(\\d+)\\s+(.+?)\\s*$`);
  for (const line of r.out.split("\n")) {
    const m = line.match(re);
    if (m) items.push({ state: m[1], number: Number(m[2]), title: m[3] });
  }
  return { branch: head[1], running: head[2], items };
}

// One item's history: when it reached its state and the PR Trunk tests it on.
export async function queueItem(number) {
  const r = await trunk(["merge", "status", String(number), "--no-progress"]);
  if (/not found/i.test(r.out)) return null;
  const flat = r.out.replace(/\s+/g, " ");
  const year = new Date().getFullYear();
  const steps = [...flat.matchAll(new RegExp(`(\\d\\d)-(\\d\\d) (\\d\\d):(\\d\\d):(\\d\\d)\\S* (?:\\S )?(${STATES})`, "g"))].map((m) => ({
    state: m[6],
    // `trunk merge status` prints UTC.
    at: Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])),
  }));
  // Anything else without history is a failed call, not an answer: the caller keeps what it knew.
  if (!steps.length) throw new Error(r.out.trim().split("\n").pop() || `trunk exited ${r.code}`);
  const testPrs = [...flat.matchAll(/on \[PR (\d+)\]/g)].map((m) => Number(m[1]));
  const last = steps.at(-1);
  return { state: last?.state ?? null, since: last?.at ?? null, testPr: last?.state === "Testing" ? testPrs.at(-1) ?? null : null, steps };
}

// How far Trunk's test run got, from the checks on the PR it tests on.
export async function testRun(number) {
  const [owner, name] = TRUNK_REPO.split("/");
  const data = await graphql(
    `query($o: String!, $n: String!, $pr: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $pr) { createdAt
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) { totalCount
      checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } } } } }`,
    { o: owner, n: name, pr: number },
  );
  const pr = data.repository.pullRequest;
  return { started: Date.parse(pr.createdAt), checks: checks(pr.commits.nodes[0]?.commit?.statusCheckRollup) };
}

export async function enqueue(number) {
  return trunk(["merge", String(number), "--no-progress"]);
}

export async function dequeue(number) {
  return trunk(["merge", "cancel", String(number), "--no-progress"]);
}
