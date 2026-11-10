import { exec } from "herdr";

const CHECK_COUNTS = `commits(last: 1) { nodes { commit { oid status { contexts { context state description targetUrl } } statusCheckRollup { state contexts(first: 1) {
  totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }`;

const PR_FIELDS = `fragment PrFields on PullRequest {
  id number url title isDraft state createdAt updatedAt
  author { login __typename } authorAssociation
  headRefName baseRefName repository { nameWithOwner }
  mergeable mergeStateStatus reviewDecision additions deletions changedFiles
  autoMergeRequest { enabledAt } mergeQueueEntry { state position }
  stack { size } stackEntry { position }
  labels(first: 30) { nodes { name } }
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  reviewThreads(first: 60) { nodes { isResolved isOutdated comments(first: 1) { nodes { author { login __typename } } } } }
  trunkComments: comments(last: 15) { nodes { author { login } body } }
  ${CHECK_COUNTS}
}`;

const MY_PRS_QUERY = `query($q: String!, $after: String) { viewer { login }
  search(query: $q, type: ISSUE, first: 20, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ...PrFields } } } } ${PR_FIELDS}`;

const REVIEW_FIELDS = `fragment ReviewFields on PullRequest {
  id number url title isDraft createdAt updatedAt additions deletions changedFiles
  author { login __typename } authorAssociation headRefName baseRefName repository { nameWithOwner }
  mergeable mergeStateStatus reviewDecision autoMergeRequest { enabledAt } mergeQueueEntry { state position }
  stack { size } stackEntry { position }
  labels(first: 30) { nodes { name } }
  viewerLatestReview { state }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], first: 1) { nodes { ... on ReviewRequestedEvent { createdAt } } }
  reviewThreads(first: 40) { nodes { isResolved comments(first: 1) { nodes { author { login __typename } } } } }
  ${CHECK_COUNTS}
}`;

const REVIEWS_QUERY = `query($q: String!, $after: String) { viewer { login }
  search(query: $q, type: ISSUE, first: 20, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ...ReviewFields } } } } ${REVIEW_FIELDS}`;

const TEAMS_QUERY = `query($org: String!, $login: String!) { organization(login: $org) {
  teams(first: 100, userLogins: [$login]) { nodes { combinedSlug } } } }`;

const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    body
    files(first: 100) { nodes { path additions deletions } }
    reviews(last: 30) { nodes { id author { login } state body submittedAt url } }
    reviewThreads(first: 100) { nodes { id isResolved isOutdated path line
      comments(first: 20) { nodes { id author { login __typename } body createdAt url pullRequestReview { id } } } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) } } } } } } }
  } } }`;

const TRANSIENT = /HTTP 5\d\d|timeout|timed out|EOF|connection reset|something went wrong/i;

export async function graphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  let error = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await exec("gh", args);
    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {}
    if (parsed?.data && !parsed.errors?.length) return parsed.data;
    error = new Error(parsed?.errors?.[0]?.message ?? (result.stderr.split("\n").filter((line) => line && !line.startsWith("*")).pop() || `gh exited ${result.code}`));
    if (!TRANSIENT.test(error.message)) break;
  }
  throw error;
}

export async function gh(args) {
  const result = await exec("gh", args);
  const text = (result.stdout.trim() || result.stderr.trim()).split("\n").filter(Boolean).pop() ?? "";
  return { ok: result.code === 0, message: text || (result.code === 0 ? "Done." : `gh exited ${result.code}`) };
}

const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const FAILED = ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
const CANCELLED = ["CANCELLED", "STALE"];
const RUNNING = ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED", "EXPECTED"];

export function checkCounts(node) {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const contexts = rollup?.contexts;
  const counts = { total: 0, passed: 0, failed: 0, inProgress: 0, cancelled: 0, rollup: rollup?.state ?? null };
  for (const { state, count } of [...(contexts?.checkRunCountsByState ?? []), ...(contexts?.statusContextCountsByState ?? [])]) {
    if (!count) continue;
    if (PASSED.includes(state)) counts.passed += count;
    else if (FAILED.includes(state)) counts.failed += count;
    else if (RUNNING.includes(state)) counts.inProgress += count;
    else if (CANCELLED.includes(state)) {
      counts.cancelled += count;
      continue;
    } else continue;
    counts.total += count;
  }
  return counts;
}

function visualReview(node) {
  const out = [];
  for (const context of node.commits?.nodes?.[0]?.commit?.status?.contexts ?? []) {
    const match = context.context.match(/^PostHog Visual Review \/ (\w+)( \(partial\))?$/);
    if (!match) continue;
    const kind = { FAILURE: "approve", PENDING: "running", ERROR: "error" }[context.state];
    if (!kind) continue;
    const changed = (context.description ?? "").match(/Visual changes detected: (.+)$/)?.[1];
    out.push({ type: match[1], partial: Boolean(match[2]), kind, url: context.targetUrl, summary: changed ?? context.description ?? "" });
  }
  return out;
}

const TRUNK_LABELS = [
  ["trunk-merged", "merged"],
  ["trunk-failed", "failed"],
  ["trunk-pending-failure", "pending_failure"],
  ["trunk-cancelled", "cancelled"],
  ["trunk-canceled", "cancelled"],
  ["trunk-tests-passed", "tests_passed"],
  ["trunk-testing", "testing"],
  ["trunk-queued", "queued"],
  ["trunk-not-ready", "not_ready"],
];

const TRUNK_COMMENT_STATES = [
  [/\bmerged\b/i, "merged"],
  [/pending[\s_-]?failure/i, "pending_failure"],
  [/\b(failed|failure)\b/i, "failed"],
  [/\bcancell?ed\b/i, "cancelled"],
  [/\btests? passed\b/i, "tests_passed"],
  [/\btesting\b/i, "testing"],
  [/\bnot ready\b/i, "not_ready"],
  [/\b(queued|waiting|submitted)\b/i, "queued"],
];

const TRUNK_QUEUE_LINK = /https:\/\/app\.trunk\.io\/[^\s)"']*\/merge-queue\//;

function trunkFromComments(comments) {
  let state = null;
  for (const comment of comments ?? []) {
    if (comment?.author?.login !== "trunk-io") continue;
    const body = comment.body ?? "";
    if (body.includes("<!-- Trunk Test Analytics -->")) continue;
    const isMerge = body.includes("<!-- Trunk Merge -->") || body.includes("<!-- Start PR Submit Checkbox -->") || TRUNK_QUEUE_LINK.test(body);
    if (!isMerge) continue;
    const statusText = body
      .split("\n")
      .filter((line) => !/\bwill\b|to merge this pull request|check the box|<!--/i.test(line))
      .join("\n");
    const match = TRUNK_COMMENT_STATES.find(([pattern]) => pattern.test(statusText));
    if (match) state = match[1];
    else if (/\[x\]/i.test(body)) state = "queued";
    else if (/\[ \]/.test(body)) state = "not_submitted";
  }
  return state;
}

function trunkFromLabels(labels) {
  for (const [name, state] of TRUNK_LABELS) {
    if (labels.some((label) => label === name || label.startsWith(`${name} `))) return state;
  }
  if (labels.includes("trunk-merge-queue-submit") || labels.includes("trunk-merge")) return "queued";
  return null;
}

const ACTIVE_QUEUE = ["queued", "testing", "tests_passed", "pending_failure"];

function queueOf(node, labels) {
  if (node.mergeQueueEntry) return { provider: "github", state: node.mergeQueueEntry.state.toLowerCase(), position: node.mergeQueueEntry.position ?? null, active: true };
  const state = trunkFromComments(node.trunkComments?.nodes) ?? trunkFromLabels(labels);
  if (!state) return null;
  return { provider: "trunk", state, position: null, active: ACTIVE_QUEUE.includes(state) };
}

function threadCounts(node, viewer, author) {
  let human = 0;
  let bot = 0;
  for (const thread of node.reviewThreads?.nodes ?? []) {
    if (thread.isResolved || thread.isOutdated) continue;
    const first = thread.comments?.nodes?.[0]?.author;
    if (!first) continue;
    if (first.__typename === "Bot" || /\[bot\]$/i.test(first.login)) bot++;
    else if (first.login !== author) human++;
  }
  return { human, bot, total: human + bot };
}

export function statusPill(pr) {
  const c = pr.checks;
  if (pr.state === "MERGED") return { label: "Merged", tone: "merged" };
  if (pr.state === "CLOSED") return { label: "Closed", tone: "dim" };
  if (pr.queue?.active) return { label: `Queue: ${pr.queue.state.replace(/_/g, " ")}`, tone: "info" };
  if (pr.queue && ["failed", "cancelled"].includes(pr.queue.state)) return { label: `Queue: ${pr.queue.state}`, tone: "bad" };
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") return { label: "Conflicts", tone: "bad" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "bad" };
  if (c.failed > 0 && pr.mergeState !== "UNSTABLE") return { label: `${c.failed}/${c.total} failing`, tone: "bad" };
  if (c.inProgress > 0) return { label: `${c.inProgress}/${c.total} running`, tone: "run" };
  if (c.failed > 0) return { label: `${c.failed} non-required`, tone: "warn" };
  if (pr.mergeState === "BEHIND") return { label: "Behind", tone: "warn" };
  if (pr.mergeState === "BLOCKED") return pr.reviewDecision === "APPROVED" ? { label: "Protected", tone: "muted" } : { label: "Review", tone: "warn" };
  if (pr.mergeState === "UNKNOWN" && c.total === 0) return { label: "—", tone: "dim" };
  return { label: "Ready", tone: "ok" };
}

export function needsAttention(pr) {
  return pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY" || pr.reviewDecision === "CHANGES_REQUESTED" || (pr.checks.failed > 0 && pr.mergeState !== "UNSTABLE") || pr.mergeState === "BEHIND" || Boolean(pr.stackDepth);
}

export function needsReview(pr) {
  return !pr.isDraft && pr.reviewDecision === "REVIEW_REQUIRED";
}

export function readyToMerge(pr) {
  if (pr.isDraft || pr.queue?.active || pr.stackDepth) return false;
  if (pr.checks.inProgress > 0 || pr.reviewDecision === "REVIEW_REQUIRED") return false;
  if (pr.mergeable === "CONFLICTING" || pr.reviewDecision === "CHANGES_REQUESTED") return false;
  return ["CLEAN", "UNSTABLE", "HAS_HOOKS", "BLOCKED", "UNKNOWN"].includes(pr.mergeState) && !(pr.checks.failed > 0 && pr.mergeState !== "UNSTABLE");
}

function normalizePr(node, viewer) {
  const labels = (node.labels?.nodes ?? []).map((label) => label.name);
  const author = node.author?.login ?? "ghost";
  return {
    id: node.id,
    repo: node.repository.nameWithOwner,
    number: node.number,
    url: node.url,
    title: node.title,
    author,
    authorIsBot: node.author?.__typename === "Bot" || /\[bot\]$/i.test(author),
    isDraft: node.isDraft,
    state: node.state ?? "OPEN",
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    headRef: node.headRefName,
    baseRef: node.baseRefName,
    headSha: node.commits?.nodes?.[0]?.commit?.oid ?? null,
    mergeable: node.mergeable,
    mergeState: node.mergeStateStatus,
    reviewDecision: node.reviewDecision,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    labels,
    autoMerge: Boolean(node.autoMergeRequest),
    queue: queueOf(node, labels),
    checks: checkCounts(node),
    visual: visualReview(node),
    approvals: (node.latestOpinionatedReviews?.nodes ?? []).filter((review) => review.state === "APPROVED").length,
    threads: threadCounts(node, viewer, author),
    mine: author === viewer,
  };
}

function attachStacks(prs) {
  const byHead = new Map();
  for (const pr of prs) {
    const key = `${pr.repo}:${pr.headRef}`;
    if (!byHead.has(key)) byHead.set(key, pr);
  }
  for (const pr of prs) {
    const parent = byHead.get(`${pr.repo}:${pr.baseRef}`);
    pr.parent = parent && parent !== pr ? parent.number : null;
  }
  const byNumber = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
  for (const pr of prs) {
    let depth = 0;
    let cursor = pr;
    const seen = new Set();
    while (cursor.parent && !seen.has(cursor.number)) {
      seen.add(cursor.number);
      cursor = byNumber.get(`${cursor.repo}#${cursor.parent}`);
      if (!cursor) break;
      depth++;
    }
    pr.depth = depth;
    pr.stackRoot = cursor?.number ?? pr.number;
  }
  const sizes = new Map();
  for (const pr of prs) sizes.set(`${pr.repo}#${pr.stackRoot}`, (sizes.get(`${pr.repo}#${pr.stackRoot}`) ?? 0) + 1);
  for (const pr of prs) pr.stackSize = sizes.get(`${pr.repo}#${pr.stackRoot}`);
  return prs;
}

export function orderWithStacks(prs, newestFirst) {
  const direction = newestFirst ? -1 : 1;
  const byCreated = (a, b) => direction * (Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const children = new Map();
  const visible = new Set(prs.map((pr) => `${pr.repo}#${pr.number}`));
  const roots = [];
  for (const pr of prs) {
    const parentKey = pr.parent ? `${pr.repo}#${pr.parent}` : null;
    if (parentKey && visible.has(parentKey)) {
      if (!children.has(parentKey)) children.set(parentKey, []);
      children.get(parentKey).push(pr);
    } else roots.push(pr);
  }
  const out = [];
  const visit = (pr, depth) => {
    out.push({ pr, depth });
    for (const child of (children.get(`${pr.repo}#${pr.number}`) ?? []).sort(byCreated)) visit(child, depth + 1);
  };
  for (const root of roots.sort(byCreated)) visit(root, 0);
  return out;
}

export const isOrgWide = (repo) => repo.endsWith("/*");
export const ownerOf = (repo) => repo.split("/")[0];

export function repoQualifier(repos) {
  const orgs = new Set(repos.filter(isOrgWide).map(ownerOf));
  const single = repos.filter((repo) => !isOrgWide(repo) && !orgs.has(ownerOf(repo)));
  return [...[...orgs].map((org) => `org:${org}`), ...single.map((repo) => `repo:${repo}`)].join(" ");
}

async function searchAll(query, q, maxPages) {
  let after = null;
  let viewer = null;
  const nodes = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(query, { q, after });
    viewer = data.viewer.login;
    nodes.push(...data.search.nodes.filter((node) => node?.number));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return { viewer, nodes };
}

const STACK_CHECK = "stack-depth / Stack depth";

async function markStackDepth(prs, trunkRepo) {
  const lone = prs.filter((pr) => pr.repo === trunkRepo && pr.checks.failed === 1);
  if (!lone.length) return;
  const [owner, name] = trunkRepo.split("/");
  const fields = lone.map((pr, index) => `p${index}: pullRequest(number: ${pr.number}) { commits(last: 1) { nodes { commit {
    checkSuites(first: 100) { nodes { checkRuns(first: 1, filterBy: { checkName: "${STACK_CHECK}", checkType: LATEST, conclusions: [FAILURE] }) {
    nodes { url annotations(first: 5) { nodes { title message } } } } } } } } } }`).join("\n");
  const data = await graphql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${fields} } }`, { o: owner, n: name });
  lone.forEach((pr, index) => {
    const suites = data.repository[`p${index}`]?.commits.nodes[0]?.commit.checkSuites.nodes ?? [];
    const run = suites.flatMap((suite) => suite.checkRuns.nodes)[0];
    if (!run) return;
    const note = run.annotations.nodes.find((annotation) => annotation.title);
    pr.checks.failed = 0;
    pr.checks.total--;
    pr.stackDepth = { checked: note?.title !== "Stack depth not checked", detail: note?.message ?? "", url: run.url };
  });
}

export async function fetchMyPrs(repos, watched, trunkRepo = null) {
  const { viewer, nodes } = await searchAll(MY_PRS_QUERY, `is:pr is:open author:@me archived:false ${repoQualifier(repos)}`, 3);
  const prs = nodes.map((node) => normalizePr(node, viewer));
  const known = new Set(prs.map((pr) => `${pr.repo}#${pr.number}`));
  const missing = watched.filter((key) => !known.has(key));
  if (missing.length) {
    const parts = missing.map((key, index) => {
      const [repo, number] = key.split("#");
      const [owner, name] = repo.split("/");
      return `w${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(number)}) { ...PrFields } }`;
    });
    const watchedData = await graphql(`query { ${parts.join("\n")} } ${PR_FIELDS}`);
    for (const entry of Object.values(watchedData)) if (entry?.pullRequest) prs.push(normalizePr(entry.pullRequest, viewer));
  }
  const watchedSet = new Set(watched);
  for (const pr of prs) pr.watching = watchedSet.has(`${pr.repo}#${pr.number}`);
  if (trunkRepo) await markStackDepth(prs, trunkRepo);
  return { viewer, prs: attachStacks(prs) };
}

const teamCache = new Map();

async function viewerTeams(orgs, login) {
  const teams = new Set();
  for (const org of orgs) {
    if (!teamCache.has(org)) {
      try {
        const data = await graphql(TEAMS_QUERY, { org, login });
        teamCache.set(org, (data.organization?.teams?.nodes ?? []).map((team) => team.combinedSlug));
      } catch {
        teamCache.set(org, []);
      }
    }
    for (const team of teamCache.get(org)) teams.add(team);
  }
  return teams;
}

const OUTSIDE = ["CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "NONE"];

function sizePoints(lines) {
  if (lines <= 100) return 8;
  if (lines <= 400) return 3;
  if (lines <= 800) return 0;
  return -6;
}

function waitPoints(hours) {
  if (hours < 4) return 0;
  if (hours < 12) return 4;
  if (hours < 48) return 10;
  if (hours < 120) return 14;
  if (hours < 336) return 16;
  return 6;
}

function waitLabel(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function reviewPriority(pr, now) {
  const terms = [];
  let gate = "actionable";
  let marker = null;
  const descendants = pr.stackSize > 1 && pr.stackPosition === 1 ? pr.stackSize - 1 : 0;
  if (pr.isDraft) {
    gate = "not_ready";
    marker = { label: "Draft", points: 0 };
  } else if (pr.mergeable === "CONFLICTING" || pr.reviewDecision === "CHANGES_REQUESTED" || (pr.checks.failed > 0 && pr.mergeState !== "UNSTABLE")) {
    gate = "waiting_on_author";
    marker = { label: pr.mergeable === "CONFLICTING" ? "Conflicts" : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Checks failing", points: 0 };
  } else if (descendants > 0 || pr.queued || (pr.autoMerge && pr.reviewDecision === "REVIEW_REQUIRED")) {
    gate = "blocking_others";
    if (descendants > 0) marker = { label: `Unblocks others ${descendants}`, points: Math.min(4 * descendants, 12) };
    else marker = { label: pr.queued ? "In merge queue" : "Auto-merge on", points: 0 };
  }
  if (marker?.points) terms.push(marker);
  const c = pr.checks;
  if (c.total > 0 && c.failed === 0 && c.inProgress === 0) terms.push({ label: "All checks green", points: 8 });
  if (c.inProgress > 0) terms.push({ label: "Checks running", points: -4 });
  if (pr.reviewDecision === "APPROVED") terms.push({ label: "Last approval", points: 10 });
  if (pr.via.direct) terms.push({ label: "Asked directly", points: 8 });
  if (pr.threads.human - pr.threads.mine > 0) terms.push({ label: "Author replying", points: -6 });
  if (pr.threads.bot > 0) terms.push({ label: "Bot comments open", points: -3 });
  if (pr.authorIsBot) terms.push({ label: "Bot author", points: -16 });
  else if (OUTSIDE.includes(pr.authorAssociation)) terms.push({ label: "External contributor", points: -8 });
  const lines = (pr.additions ?? 0) + (pr.deletions ?? 0);
  const quick = sizePoints(lines);
  terms.push({ label: quick > 0 ? `Quick (${lines} lines)` : `${lines} lines`, points: quick });
  if (pr.viewerLatestReview === "CHANGES_REQUESTED") terms.push({ label: "Re-review", points: 6 });
  if (pr.threads.mine > 0) terms.push({ label: `Your comments open ${pr.threads.mine}`, points: 5 });
  const hours = (now - Date.parse(pr.requestedAt ?? pr.createdAt)) / 3600000;
  terms.push({ label: `Waited ${waitLabel(hours)}`, points: waitPoints(hours) });
  const score = terms.reduce((sum, term) => sum + term.points, 0);
  const sorted = [...terms].sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const chip = marker ?? sorted.find((term) => term.points > 0) ?? sorted.find((term) => term.points < 0) ?? null;
  const rank = { blocking_others: 3, actionable: 2, waiting_on_author: 1, not_ready: 0 }[gate];
  return { gate, rank, score, chip, terms };
}

export function comparePriority(a, b) {
  return b.priority.rank - a.priority.rank || b.priority.score - a.priority.score || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number;
}

export async function fetchReviews(repos) {
  const { viewer, nodes } = await searchAll(REVIEWS_QUERY, `is:pr is:open review-requested:@me archived:false ${repoQualifier(repos)}`, 4);
  const orgs = [...new Set(nodes.map((node) => node.repository.nameWithOwner.split("/")[0]))];
  const teams = await viewerTeams(orgs, viewer);
  const now = Date.now();
  return nodes.map((node) => {
    const pr = normalizePr(node, viewer);
    const requested = (node.reviewRequests?.nodes ?? []).map((request) => request.requestedReviewer).filter(Boolean);
    const direct = requested.some((reviewer) => reviewer.__typename === "User" && reviewer.login?.toLowerCase() === viewer.toLowerCase());
    const viaTeams = requested.filter((reviewer) => reviewer.__typename === "Team" && teams.has(reviewer.combinedSlug)).map((reviewer) => reviewer.combinedSlug);
    let mine = 0;
    for (const thread of node.reviewThreads?.nodes ?? []) if (!thread.isResolved && thread.comments?.nodes?.[0]?.author?.login === viewer) mine++;
    Object.assign(pr, {
      authorAssociation: node.authorAssociation,
      viewerLatestReview: node.viewerLatestReview?.state ?? null,
      requestedAt: node.timelineItems?.nodes?.[0]?.createdAt ?? null,
      via: { direct, teams: viaTeams },
      stackSize: node.stack?.size ?? 1,
      stackPosition: node.stackEntry?.position ?? null,
      queued: Boolean(node.mergeQueueEntry) || Boolean(pr.queue?.active),
    });
    pr.threads.mine = mine;
    pr.priority = reviewPriority(pr, now);
    return pr;
  });
}

export async function fetchDetail(pr) {
  const [owner, name] = pr.repo.split("/");
  let after = null;
  let detail = null;
  const checks = [];
  for (let page = 0; page < 6; page++) {
    const data = await graphql(DETAIL_QUERY, { owner, name, number: pr.number, after });
    const node = data.repository.pullRequest;
    detail ??= node;
    const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    for (const check of contexts?.nodes ?? []) {
      if (check.__typename === "CheckRun") {
        checks.push({ name: check.name, state: check.status === "COMPLETED" ? check.conclusion ?? "COMPLETED" : check.status, url: check.detailsUrl, required: check.isRequired });
      } else {
        checks.push({ name: check.context, state: check.state, url: check.targetUrl, required: check.isRequired });
      }
    }
    if (!contexts?.pageInfo?.hasNextPage) break;
    after = contexts.pageInfo.endCursor;
  }
  const bucket = (state) => (PASSED.includes(state) ? "passed" : FAILED.includes(state) ? "failed" : CANCELLED.includes(state) ? "cancelled" : "running");
  return {
    body: detail?.body ?? "",
    files: detail?.files?.nodes ?? [],
    reviews: detail?.reviews?.nodes ?? [],
    threads: (detail?.reviewThreads?.nodes ?? []).map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      reviewId: thread.comments?.nodes?.[0]?.pullRequestReview?.id ?? null,
      comments: (thread.comments?.nodes ?? []).map((comment) => ({ id: comment.id, author: comment.author?.login ?? "ghost", isBot: comment.author?.__typename === "Bot", body: comment.body, createdAt: comment.createdAt, url: comment.url })),
    })),
    checks: checks.map((check) => ({ ...check, bucket: bucket(check.state) })).sort((a, b) => ["failed", "running", "passed"].indexOf(a.bucket) - ["failed", "running", "passed"].indexOf(b.bucket) || a.name.localeCompare(b.name)),
  };
}

export const RESOLVE_THREAD = `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }`;
export const REPLY_THREAD = `mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }`;
