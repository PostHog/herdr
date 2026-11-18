// Fetches the PRs Dopamine Squirrel shows, with the gh CLI, across every repo the gh login can see.
import { shared, setShared, exec } from "herdr";
import { squirrelSettings } from "./settings.js";
import { cloudTaskPrs } from "./cloud.js";
import { AI_TRIAGE } from "./triage-ai.js";

const mergedDays = () => squirrelSettings().mergedDays;
const mergedSince = () => new Date(Date.now() - mergedDays() * 864e5).toISOString().slice(0, 10);

// My teams' names and my teammates' logins, in the orgs the PRs come from, refreshed daily.
let teamCache = null;
async function myTeams(me, orgs) {
  const key = [...orgs].sort().join(",");
  if (teamCache?.key === key && Date.now() - teamCache.at < 864e5) return teamCache;
  const d = await ghGraphql(`query { viewer { organizations(first: 20) { nodes { login teams(first: 20, userLogins: ["${me}"]) { nodes { name members(first: 100) { nodes { login } } } } } } } }`).catch(() => null);
  if (!d) return teamCache ?? { names: new Set(), mates: new Set() };
  const teams = d.viewer.organizations.nodes.filter((o) => orgs.has(o.login)).flatMap((o) => o.teams.nodes);
  teamCache = { key, at: Date.now(), names: new Set(teams.map((t) => t.name)),
    mates: new Set(teams.flatMap((t) => t.members.nodes.map((m) => m.login)).filter((l) => l !== me)) };
  return teamCache;
}

// PRs waiting on my review (directly or through a team), fetched every 5 minutes into
// shared "squirrel.github" for the GitHub view in squirrel-panel and the count badge here.
export const GH_EVERY_MS = 5 * 60 * 1000;
const PR_FIELDS = `number title url isDraft createdAt updatedAt additions deletions reviewDecision
      repository { nameWithOwner } author { login }
      commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state } } } }
      reviews(last: 50) { nodes { author { __typename login } state submittedAt bodyText url } }
      comments(last: 30) { nodes { author { __typename login } createdAt bodyText url } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } ... on Team { name } } } } }
      reviewThreads(first: 100) { nodes { isResolved } }
      reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }`;
// Three small queries instead of one big one: the combined query took ~10s, GitHub's GraphQL limit, and failed with 502s.
// What My PRs reads for each PR: the shared fields, Trunk's sticky comment and unresolved threads.
const MINE_FIELDS = () => `${PR_FIELDS} trunk: comments(first: 10) { nodes { author { login } body updatedAt } }
      threads: reviewThreads(first: 50) { nodes { isResolved path comments(first: 1) { nodes { author { __typename login } createdAt bodyText url } } } }`;
const SKIPPED_FIELDS = `number title url createdAt mergedAt additions deletions repository { nameWithOwner } author { login } mergedBy { login }
      reviews(last: 20) { nodes { author { __typename login } state submittedAt bodyText url } }
      comments(last: 15) { nodes { author { login } createdAt bodyText url } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { name } } } } }`;
const GH_QUERIES = {
  reviews: () => `query { viewer { login } list: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 100) {
    issueCount nodes { ... on PullRequest { ${PR_FIELDS} } } } }`,
  // GitHub drops my request (and my team's) as soon as I review at all. A PR that asked me or my team stays
  // on my list until I approve it; fetchGh picks those out of the PRs I've reviewed.
  reviewed: () => `query { viewer { login } list: search(query: "is:pr is:open archived:false reviewed-by:@me -author:@me", type: ISSUE, first: 40) {
    issueCount nodes { ... on PullRequest { ${PR_FIELDS} } } } }`,
  mine: () => `query { viewer { login } list: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 100) {
    issueCount nodes { ... on PullRequest { ${MINE_FIELDS()} } } } }`,
  merged: () => `query { viewer { login } list: search(query: "is:pr is:merged author:@me merged:>=${new Date(Date.now() - mergedDays() * 864e5).toISOString().slice(0, 10)}", type: ISSUE, first: 30) {
    issueCount nodes { ... on PullRequest { number title url createdAt mergedAt additions deletions repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`,
  // Merged while still waiting on me or one of my teams: GitHub drops a request once I (or, for a team, a
  // teammate) review, so these landed without any of us. Teammate-reviewed ones are added in fetchGh.
  // 25 a page: these fields make a big page time out.
  skipped: (after) => `query { viewer { login } list: search(query: "is:pr is:merged -author:@me review-requested:@me merged:>=${mergedSince()}", type: ISSUE, first: 25${after ? `, after: "${after}"` : ""}) {
    issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${SKIPPED_FIELDS} } } } }`,
};

// GitHub's 502/504s and cut-off replies are transient: try up to three times with a short pause.
async function ghGraphql(query) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await exec("/bin/sleep", [String(2 * attempt)]).catch(() => null);
    const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code === 0) {
      try { return JSON.parse(r.stdout).data; } catch { last = "GitHub sent back a cut-off reply"; continue; }
    }
    last = r.stderr.split("\n").filter((l) => l && !l.startsWith("*")).pop() || `gh exited ${r.code}`;
    if (!/50[234]|timeout|timed out|EOF|connection/i.test(last)) break;
  }
  throw new Error(last);
}

// Drops <!-- … --> blocks. An unclosed one drops the rest, so no partial marker is left behind.
// Repeats until nothing changes, since removing one block can join two halves into a new marker.
function withoutComments(body) {
  for (;;) {
    let out = "", i = 0;
    for (;;) {
      const start = body.indexOf("<!--", i);
      if (start < 0) { out += body.slice(i); break; }
      out += body.slice(i, start);
      const end = body.indexOf("-->", start + 4);
      if (end < 0) break;
      i = end + 3;
    }
    if (out === body) return out;
    body = out;
  }
}

// Trunk's merge-queue bot keeps one comment per PR up to date; its first line is the queue state.
function trunkState(n) {
  const c = (n.trunk?.nodes ?? []).find((x) => x.author?.login === "trunk-io");
  if (!c) return null;
  const text = withoutComments(c.body).trim();
  const first = text.split("\n")[0].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  const state = /managed by Trunk/.test(first) ? "none"
    : /Merged successfully/i.test(first) ? "merged"
    : /Running tests/i.test(first) ? "testing"
    : /Waiting to start tests/i.test(first) ? "queued"
    : /Submitted to Merge/i.test(first) ? "waiting"
    : /fail|removed|cancel|kicked/i.test(first) ? "failed" : "other";
  return {
    state, at: c.updatedAt,
    url: /https:\/\/app\.trunk\.io\/[^\s)]+/.exec(text)?.[0] ?? null,
    by: /Submitted to Merge by ([^.(]+?)\s*(\(@[\w-]+\))?\./.exec(first)?.[1]?.trim() ?? null,
    text: first.replace(/^[^\p{L}]+/u, "").slice(0, 200),
  };
}

function toPr(n, me, notes) {
  const reviewers = n.reviewRequests.nodes.map((x) => x.requestedReviewer).filter(Boolean);
  const reviews = n.reviews.nodes.filter((r) => r.author?.login && r.state !== "PENDING");
  const myLast = reviews.filter((r) => r.author.login === me).at(-1);
  const head = n.commits.nodes[0]?.commit;
  const latestBy = new Map(reviews.filter((r) => r.author.login !== n.author?.login).map((r) => [r.author.login, r.state]));
  const waiting = reviewers.map((x) => x.login ?? x.name);
  // When the still-open request (to me or one of my teams) was last made.
  const requests = n.timelineItems.nodes.filter((e) => waiting.includes(e.requestedReviewer?.login ?? e.requestedReviewer?.name));
  const requestedAt = requests.at(-1)?.createdAt ?? n.createdAt;
  // Activity from others: issue comments plus reviews with a body, newest last.
  const activity = [
    ...n.comments.nodes.map((c) => ({ bot: c.author?.__typename === "Bot", who: c.author?.login ?? "ghost", at: c.createdAt, text: c.bodyText, url: c.url })),
    ...reviews.filter((r) => r.bodyText).map((r) => ({ bot: r.author.__typename === "Bot", who: r.author.login, at: r.submittedAt, text: r.bodyText, url: r.url, state: r.state })),
  ].filter((a) => !a.bot && a.who !== me).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const since = myLast ? Date.parse(myLast.submittedAt) : Date.parse(requestedAt);
  const note = notes.get(`${n.repository.nameWithOwner}#${n.number}`);
  return {
    headAt: head?.committedDate ?? n.createdAt, headSha: head?.oid ?? null, requestedAt,
    // My PRs only (the query asks for threads there): comments still waiting on an answer or a resolve.
    threads: (n.threads?.nodes ?? []).filter((x) => !x.isResolved && x.comments.nodes[0]).map((x) => {
      const c = x.comments.nodes[0];
      return { who: c.author?.login ?? "ghost", at: c.createdAt, text: c.bodyText.replace(/\s+/g, " ").slice(0, 200), url: c.url, path: x.path };
    }),
    commentCount: activity.length,
    activity: activity.slice(-4).map((a) => ({ ...a, text: a.text.replace(/\s+/g, " ").slice(0, 200), mentionsMe: a.text.includes(`@${me}`) })),
    newActivity: activity.filter((a) => Date.parse(a.at) > since).length,
    mentioned: activity.some((a) => a.text.includes(`@${me}`)),
    notification: note ? { reason: note.reason, unread: note.unread } : null,
    number: n.number, title: n.title, url: n.url, draft: n.isDraft, repo: n.repository.nameWithOwner,
    author: n.author?.login ?? "ghost", created: n.createdAt, updated: n.updatedAt,
    additions: n.additions, deletions: n.deletions, review: n.reviewDecision,
    ci: head?.statusCheckRollup?.state ?? null,
    mine: reviewers.some((x) => x.login === me),
    waiting,
    // My review state: null = never reviewed; "stale" = new commits since my last review.
    // My approval still stands: a later plain comment doesn't lift it, a dismissal does.
    approvedByMe: reviews.filter((r) => r.author.login === me && r.state !== "COMMENTED").at(-1)?.state === "APPROVED",
    myReview: !myLast ? null : head && Date.parse(head.committedDate) > Date.parse(myLast.submittedAt) ? "stale" : myLast.state,
    approvals: [...latestBy.values()].filter((s) => s === "APPROVED").length,
    openThreads: (n.reviewThreads?.nodes ?? []).filter((x) => !x.isResolved).length,
    trunk: trunkState(n),
  };
}

function toSkipped(n, me) {
  const asks = n.timelineItems.nodes;
  return { number: n.number, title: n.title, url: n.url, repo: n.repository.nameWithOwner, author: n.author?.login ?? "ghost",
    created: n.createdAt, mergedAt: n.mergedAt, additions: n.additions, deletions: n.deletions,
    mergedBy: n.mergedBy?.login ?? null,
    askedMe: asks.filter((e) => e.requestedReviewer?.login === me).map((e) => ({ by: e.actor?.login ?? "ghost", at: e.createdAt })),
    askedTeams: asks.filter((e) => e.requestedReviewer?.name).map((e) => ({ team: e.requestedReviewer.name, by: e.actor?.login ?? "ghost", at: e.createdAt })),
    // Comments and review bodies that @-mention me: usually what I was asked.
    mentions: [...n.comments.nodes.map((c) => ({ who: c.author?.login ?? "ghost", at: c.createdAt, text: c.bodyText, url: c.url })),
      ...n.reviews.nodes.filter((r) => r.bodyText).map((r) => ({ who: r.author?.login ?? "ghost", at: r.submittedAt, text: r.bodyText, url: r.url }))]
      .filter((m) => m.text.includes(`@${me}`)).map((m) => ({ ...m, text: m.text.replace(/\s+/g, " ").slice(0, 200) })),
    reviews: n.reviews.nodes.filter((r) => r.author?.login && r.author.__typename !== "Bot" && r.author.login !== n.author?.login && r.state !== "PENDING").map((r) => ({ who: r.author.login, state: r.state, at: r.submittedAt })) };
}

export async function fetchGh() {
  const prev = shared("squirrel.github") ?? {};
  setShared("squirrel.github", { ...prev, loading: true });
  const [notesResult, ...results] = await Promise.allSettled([
    exec("gh", ["api", "notifications?participating=true&per_page=100"], { timeout: 60000 }),
    ...Object.values(GH_QUERIES).map((q) => ghGraphql(q())),
  ]);
  const [reviews, reviewed, mine, merged, skipped] = results;
  // GitHub inbox threads I'm part of, keyed "owner/repo#number" (reason: mention, comment, review_requested…).
  const notes = new Map();
  if (notesResult.status === "fulfilled" && notesResult.value.code === 0) for (const t of JSON.parse(notesResult.value.stdout)) {
    const m = /\/pulls\/(\d+)$/.exec(t.subject?.url ?? "");
    if (m) notes.set(`${t.repository.full_name}#${m[1]}`, { reason: t.reason, unread: t.unread });
  }
  const next = { ...prev, loading: false };
  const failed = [];
  const take = (res, name, map) => {
    if (res.status !== "fulfilled") { failed.push(`${name}: ${String(res.reason?.message ?? res.reason)}`); return; }
    next[name] = map(res.value);
    next[`${name}At`] = Date.now();
  };
  take(reviews, "prs", (d) => d.list.nodes.filter((n) => n?.number).map((n) => toPr(n, d.viewer.login, notes)));
  if (reviewed.status === "fulfilled" && reviews.status === "fulfilled") {
    const d = reviewed.value, me = d.viewer.login, have = new Set(next.prs.map((p) => p.url));
    const teams = await myTeams(me, new Set(d.list.nodes.filter((n) => n?.number).map((n) => n.repository.nameWithOwner.split("/")[0])));
    for (const n of d.list.nodes.filter((n) => n?.number && !have.has(n.url))) {
      const asks = n.timelineItems.nodes.filter((e) => e.requestedReviewer?.login === me || teams.names.has(e.requestedReviewer?.name));
      if (!asks.length) continue;
      const p = toPr(n, me, notes);
      if (p.approvedByMe) continue;
      next.prs.push({ ...p, mine: asks.some((e) => e.requestedReviewer?.login === me), rereview: p.myReview === "stale", requestedAt: asks.at(-1).createdAt });
    }
  }
  take(mine, "mine", (d) => d.list.nodes.filter((n) => n?.number).map((n) => toPr(n, d.viewer.login, notes)));
  take(merged, "merged", (d) => d.list.nodes.filter((n) => n?.number)
    .map((n) => ({ number: n.number, title: n.title, url: n.url, repo: n.repository.nameWithOwner, created: n.createdAt, mergedAt: n.mergedAt,
      additions: n.additions, deletions: n.deletions, ci: n.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null }))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)));
  if (skipped.status === "fulfilled") {
    for (let page = skipped.value.list, n = 1; page.pageInfo.hasNextPage && n < 6; n++) {
      const more = await ghGraphql(GH_QUERIES.skipped(page.pageInfo.endCursor)).catch(() => null);
      if (!more) break;
      skipped.value.list.nodes.push(...more.list.nodes);
      page = more.list;
    }
  }
  take(skipped, "skipped", (d) => d.list.nodes.filter((n) => n?.number).map((n) => toSkipped(n, d.viewer.login))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)));
  // PRs that asked me or my team and merged after a teammate reviewed (which drops the team request), still without
  // my review. They're marked with who approved.
  if (skipped.status === "fulfilled") {
    const me = skipped.value.viewer.login;
    const teams = await myTeams(me, new Set([...(next.prs ?? []), ...next.skipped].map((p) => p.repo.split("/")[0])));
    const mates = [...teams.mates];
    // A light pass finds them; the full fields come after, a few at a time, since big pages time out.
    const light = mates.length ? await ghGraphql(`query { ${mates.map((m, i) => `m${i}: search(query: "is:pr is:merged -author:@me reviewed-by:${m} merged:>=${mergedSince()}", type: ISSUE, first: 100) { nodes { ... on PullRequest { url reviews(last: 30) { nodes { author { login } } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent { requestedReviewer { ... on User { login } ... on Team { name } } } } } } } }`).join("\n")} }`).catch(() => null) : null;
    const have = new Set(next.skipped.map((p) => p.url));
    const found = [...new Set(Object.values(light ?? {}).flatMap((x) => x?.nodes ?? []).filter((n) => n?.url && !have.has(n.url)
      && !n.reviews.nodes.some((r) => r.author?.login === me)
      && n.timelineItems.nodes.some((e) => e.requestedReviewer?.login === me || teams.names.has(e.requestedReviewer?.name))).map((n) => n.url))];
    for (let i = 0; i < found.length; i += 15) {
      const parts = found.slice(i, i + 15).map((url, j) => {
        const [, owner, name, number] = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url) ?? [];
        return owner ? `p${j}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { ${SKIPPED_FIELDS} } }` : "";
      }).filter(Boolean);
      const d = await ghGraphql(`query { ${parts.join("\n")} }`).catch(() => null);
      for (const x of Object.values(d ?? {})) if (x?.pullRequest?.number) next.skipped.push(toSkipped(x.pullRequest, me));
    }
    for (const p of next.skipped) p.coveredBy = [...new Set(p.reviews.filter((r) => r.state === "APPROVED" && teams.mates.has(r.who)).map((r) => r.who))];
    next.skipped.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  }
  // Team requests the AI tag said likely need me, that merged without my review: they join the same section.
  const tags = shared(AI_TRIAGE) ?? {}, since = Date.now() - mergedDays() * 864e5;
  const seen = new Set([...(next.prs ?? []), ...(next.skipped ?? [])].map((p) => p.url));
  const gone = Object.entries(tags).filter(([url, v]) => v.verdict === "needs" && !seen.has(url) && v.at > since).map(([url]) => url).slice(0, 30);
  if (gone.length && skipped.status === "fulfilled") {
    const parts = gone.map((url, i) => {
      const [, owner, name, number] = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url) ?? [];
      return owner ? `p${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { merged ${SKIPPED_FIELDS} } }` : "";
    }).filter(Boolean);
    const d = await ghGraphql(`query { viewer { login } ${parts.join("\n")} }`).catch(() => null);
    for (const key of Object.keys(d ?? {}).filter((k) => /^p\d+$/.test(k))) {
      const n = d[key]?.pullRequest;
      if (!n?.merged || Date.parse(n.mergedAt) < since || n.reviews.nodes.some((r) => r.author?.login === d.viewer.login)) continue;
      next.skipped.push({ ...toSkipped(n, d.viewer.login), aiReason: tags[n.url]?.reason });
    }
    next.skipped.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  }
  next.mergedDays = mergedDays();
  // PRs your PostHog cloud tasks opened (a bot authors them): add them to My PRs, tagged, and out of Reviews.
  const cloud = await cloudTaskPrs().catch(() => []);
  const cloudUrls = new Set(cloud.map((c) => c.url));
  const missing = cloud.filter((c) => !(next.mine ?? []).some((p) => p.url === c.url));
  if (missing.length) {
    const parts = missing.map((c, i) => {
      const [, owner, name, number] = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(c.url) ?? [];
      return owner ? `p${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { ${MINE_FIELDS()} } }` : "";
    }).filter(Boolean);
    const d = parts.length ? await ghGraphql(`query { viewer { login } ${parts.join("\n")} }`).catch(() => null) : null;
    for (const key of Object.keys(d ?? {}).filter((k) => /^p\d+$/.test(k))) {
      const n = d[key]?.pullRequest;
      if (n?.number) (next.mine ??= []).push(toPr(n, d.viewer.login, notes));
    }
  }
  for (const p of next.mine ?? []) {
    const c = cloud.find((x) => x.url === p.url);
    if (c) { p.cloud = true; p.taskUrl = c.taskUrl; }
  }
  if (cloudUrls.size) next.prs = (next.prs ?? []).filter((p) => !cloudUrls.has(p.url));
  const capped = (reviews.status === "fulfilled" && reviews.value.list.issueCount > 100) || (mine.status === "fulfilled" && mine.value.list.issueCount > 100);
  if (!failed.length) next.at = Date.now();
  next.error = failed.length ? `GitHub failed (${failed.join("; ")}), showing older data` : capped ? "more than 100 PRs, list is cut off" : null;
  // Triage marks outlive a PR dropping off the list (a team re-request brings it back), so prune by age only.
  const triaged = shared("squirrel.triaged") ?? {}, cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  const kept = Object.fromEntries(Object.entries(triaged).filter(([, at]) => (at?.at ?? at) > cutoff));
  if (Object.keys(kept).length !== Object.keys(triaged).length) setShared("squirrel.triaged", kept);
  setShared("squirrel.github", next);
}

