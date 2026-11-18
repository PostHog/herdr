import { exec, shared, setShared } from "herdr";
import { isBot } from "./bots.js";

const CHECK_COUNTS = `commits(last: 1) { nodes { commit { oid status { contexts { context state description targetUrl } } statusCheckRollup { state contexts(first: 1) {
  totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }`;

const PR_FIELDS = `fragment PrFields on PullRequest {
  id number url title isDraft state createdAt updatedAt
  author { login __typename } authorAssociation
  headRefName baseRefName isCrossRepository repository { nameWithOwner }
  mergeable mergeStateStatus reviewDecision additions deletions changedFiles
  autoMergeRequest { enabledAt } mergeQueueEntry { state position }
  stack { size } stackEntry { position }
  labels(first: 30) { nodes { name } }
  latestOpinionatedReviews(first: 20) { nodes { state author { login __typename } } }
  reviewThreads(first: 30) { nodes { isResolved isOutdated comments(first: 1) { nodes { author { login __typename } } } } }
  ${CHECK_COUNTS}
}`;

const MY_PRS_QUERY = `query($q: String!, $after: String) { viewer { login }
  search(query: $q, type: ISSUE, first: 20, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ...PrFields } } } } ${PR_FIELDS}`;

const REVIEW_FIELDS = `fragment ReviewFields on PullRequest {
  id number url title isDraft createdAt updatedAt additions deletions changedFiles
  author { login __typename } authorAssociation headRefName baseRefName isCrossRepository repository { nameWithOwner }
  mergeable mergeStateStatus reviewDecision autoMergeRequest { enabledAt } mergeQueueEntry { state position }
  stack { size } stackEntry { position }
  labels(first: 30) { nodes { name } }
  viewerLatestReview { state }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], first: 1) { nodes { ... on ReviewRequestedEvent { createdAt } } }
  reviewThreads(first: 30) { nodes { isResolved comments(first: 1) { nodes { author { login __typename } } } } }
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
    reviews(last: 30) { nodes { id author { login __typename } state body submittedAt url } }
    reviewThreads(first: 100) { nodes { id isResolved isOutdated path line
      comments(first: 20) { nodes { id author { login __typename } body createdAt url pullRequestReview { id } } } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) } } } } } } }
  } } }`;

const TRANSIENT = /HTTP 5\d\d|timeout|timed out|EOF|connection reset|something went wrong/i;
const RATE_LIMITED = /rate limit|abuse detection/i;
const FIRST_PAUSE_MS = 60000;
const LONGEST_PAUSE_MS = 15 * 60000;
const RATE_LIMIT_KEY = "prs.rateLimit";

export class RateLimited extends Error {}

const clock = (at) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

export function rateLimitPause() {
  const pause = shared(RATE_LIMIT_KEY);
  if (!pause || Date.now() >= pause.until) return null;
  return { ...pause, message: `GitHub rate limit hit. Refreshing again at ${clock(pause.until)}.` };
}

async function hourlyReset() {
  const result = await exec("gh", ["api", "rate_limit", "--jq", ".resources.graphql"]);
  try {
    const graphqlLimit = JSON.parse(result.stdout);
    return graphqlLimit.remaining === 0 ? graphqlLimit.reset * 1000 : null;
  } catch {
    return null;
  }
}

async function recordRateLimit() {
  if (rateLimitPause()) return;
  const strikes = (shared(RATE_LIMIT_KEY)?.strikes ?? 0) + 1;
  const pause = { until: Date.now() + Math.min(FIRST_PAUSE_MS * 2 ** (strikes - 1), LONGEST_PAUSE_MS), strikes };
  setShared(RATE_LIMIT_KEY, pause);
  const reset = await hourlyReset();
  if (reset && reset > pause.until && shared(RATE_LIMIT_KEY)?.until === pause.until) setShared(RATE_LIMIT_KEY, { ...pause, until: reset });
}

function clearRateLimit(sentAt) {
  const pause = shared(RATE_LIMIT_KEY);
  if (pause?.strikes && sentAt >= pause.until) setShared(RATE_LIMIT_KEY, null);
}

export async function graphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  let error = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pause = rateLimitPause();
    if (pause) throw new RateLimited(pause.message);
    const sentAt = Date.now();
    const result = await exec("gh", args);
    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {}
    if (parsed?.data && !parsed.errors?.length) {
      clearRateLimit(sentAt);
      return parsed.data;
    }
    error = new Error(parsed?.errors?.[0]?.message ?? (result.stderr.split("\n").filter((line) => line && !line.startsWith("*")).pop() || `gh exited ${result.code}`));
    if (RATE_LIMITED.test(error.message)) {
      await recordRateLimit();
      throw new RateLimited(rateLimitPause()?.message ?? error.message);
    }
    if (!TRANSIENT.test(error.message)) break;
  }
  throw error;
}

export async function gh(args) {
  const result = await exec("gh", args);
  const text = (result.stdout.trim() || result.stderr.trim()).split("\n").filter(Boolean).pop() ?? "";
  return { ok: result.code === 0, message: text || (result.code === 0 ? "Done." : `gh exited ${result.code}`), stderr: result.stderr };
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

const TRUNK_QUEUE_STATE = { Testing: "testing", "Tests Passed": "tests_passed", Pending: "pending", "Not Ready": "not_ready", "Pending Failure": "pending_failure", Failed: "failed", Cancelled: "cancelled", Merged: "merged" };
const TRUNK_QUEUE_ACTIVE = ["pending", "testing", "tests_passed", "pending_failure"];

export function trunkQueue(entry) {
  const state = entry ? TRUNK_QUEUE_STATE[entry.state] : null;
  if (!state) return null;
  return { provider: "trunk", state, position: null, active: TRUNK_QUEUE_ACTIVE.includes(state) };
}

function trunkEntry(pr, trunk) {
  if (!trunk || pr.repo !== trunk.repo) return null;
  return trunk.items?.[pr.number] ?? trunk.listing?.items?.find((item) => item.number === pr.number) ?? null;
}

export function applyTrunk(prs, trunk) {
  for (const pr of prs) {
    if (pr.queue?.provider === "github") continue;
    pr.queue = trunkQueue(trunkEntry(pr, trunk));
  }
  return prs;
}

function queueOf(node) {
  if (!node.mergeQueueEntry) return null;
  return { provider: "github", state: node.mergeQueueEntry.state.toLowerCase(), position: node.mergeQueueEntry.position ?? null, active: true };
}

function threadCounts(node, viewer, author) {
  let human = 0;
  let bot = 0;
  for (const thread of node.reviewThreads?.nodes ?? []) {
    if (thread.isResolved || thread.isOutdated) continue;
    const first = thread.comments?.nodes?.[0]?.author;
    if (!first) continue;
    if (isBot(first)) bot++;
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
    authorIsBot: isBot(node.author),
    isDraft: node.isDraft,
    state: node.state ?? "OPEN",
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    headRef: node.headRefName,
    headInRepo: node.isCrossRepository === false,
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
    queue: queueOf(node),
    checks: checkCounts(node),
    visual: visualReview(node),
    approvals: (node.latestOpinionatedReviews?.nodes ?? []).filter((review) => review.state === "APPROVED").length,
    botApprovals: (node.latestOpinionatedReviews?.nodes ?? []).filter((review) => review.state === "APPROVED" && isBot(review.author)).length,
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

export async function fetchMyPrs(repos, watched, trunkRepo = null, trunk = null) {
  const { viewer, nodes } = await searchAll(MY_PRS_QUERY, `is:pr is:open author:@me archived:false ${repoQualifier(repos)}`, 2);
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
  applyTrunk(prs, trunk);
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

export async function fetchReviews(repos, trunk = null) {
  const { viewer, nodes } = await searchAll(REVIEWS_QUERY, `is:pr is:open review-requested:@me archived:false ${repoQualifier(repos)}`, 2);
  const orgs = [...new Set(nodes.map((node) => node.repository.nameWithOwner.split("/")[0]))];
  const teams = await viewerTeams(orgs, viewer);
  const now = Date.now();
  return nodes.map((node) => {
    const [pr] = applyTrunk([normalizePr(node, viewer)], trunk);
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
    reviews: (detail?.reviews?.nodes ?? []).map((review) => ({ ...review, isBot: isBot(review.author) })),
    threads: (detail?.reviewThreads?.nodes ?? []).map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      reviewId: thread.comments?.nodes?.[0]?.pullRequestReview?.id ?? null,
      isBot: isBot(thread.comments?.nodes?.[0]?.author),
      comments: (thread.comments?.nodes ?? []).map((comment) => ({ id: comment.id, author: comment.author?.login ?? "ghost", isBot: isBot(comment.author), body: comment.body, createdAt: comment.createdAt, url: comment.url })),
    })),
    checks: checks.map((check) => ({ ...check, bucket: bucket(check.state) })).sort((a, b) => ["failed", "running", "passed"].indexOf(a.bucket) - ["failed", "running", "passed"].indexOf(b.bucket) || a.name.localeCompare(b.name)),
  };
}

export const RESOLVE_THREAD = `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }`;
export const REPLY_THREAD = `mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }`;
