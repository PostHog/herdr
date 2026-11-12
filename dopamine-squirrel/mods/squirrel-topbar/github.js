// Fetches the PRs Dopamine Squirrel shows, with the gh CLI, across every repo the gh login can see.
import { shared, setShared, exec } from "herdr";
import { squirrelSettings } from "./settings.js";

const mergedDays = () => squirrelSettings().mergedDays;

// PRs waiting on my review (directly or through a team), fetched every 5 minutes into
// shared "squirrel.github" for the GitHub view in squirrel-panel and the count badge here.
export const GH_EVERY_MS = 5 * 60 * 1000;
const PR_FIELDS = `number title url isDraft createdAt updatedAt additions deletions reviewDecision
      repository { nameWithOwner } author { login }
      commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
      reviews(last: 50) { nodes { author { __typename login } state submittedAt bodyText url } }
      comments(last: 30) { nodes { author { __typename login } createdAt bodyText url } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } ... on Team { name } } } } }
      reviewThreads(first: 100) { nodes { isResolved } }
      reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }`;
// Three small queries instead of one big one: the combined query took ~10s, GitHub's GraphQL limit, and failed with 502s.
const GH_QUERIES = {
  reviews: () => `query { viewer { login } list: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 100) {
    issueCount nodes { ... on PullRequest { ${PR_FIELDS} } } } }`,
  mine: () => `query { viewer { login } list: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 100) {
    issueCount nodes { ... on PullRequest { ${PR_FIELDS} trunk: comments(first: 10) { nodes { author { login } body updatedAt } } } } } }`,
  merged: () => `query { viewer { login } list: search(query: "is:pr is:merged author:@me merged:>=${new Date(Date.now() - mergedDays() * 864e5).toISOString().slice(0, 10)}", type: ISSUE, first: 30) {
    issueCount nodes { ... on PullRequest { number title url createdAt mergedAt additions deletions repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`,
};

// GitHub's 502/504s are transient: try up to three times with a short pause.
async function ghGraphql(query) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await exec("/bin/sleep", [String(2 * attempt)]).catch(() => null);
    const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code === 0) return JSON.parse(r.stdout).data;
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
    headAt: head?.committedDate ?? n.createdAt, requestedAt,
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
    myReview: !myLast ? null : head && Date.parse(head.committedDate) > Date.parse(myLast.submittedAt) ? "stale" : myLast.state,
    approvals: [...latestBy.values()].filter((s) => s === "APPROVED").length,
    openThreads: (n.reviewThreads?.nodes ?? []).filter((x) => !x.isResolved).length,
    trunk: trunkState(n),
  };
}

export async function fetchGh() {
  const prev = shared("squirrel.github") ?? {};
  setShared("squirrel.github", { ...prev, loading: true });
  const [notesResult, ...results] = await Promise.allSettled([
    exec("gh", ["api", "notifications?participating=true&per_page=100"], { timeout: 60000 }),
    ...Object.values(GH_QUERIES).map((q) => ghGraphql(q())),
  ]);
  const [reviews, mine, merged] = results;
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
  take(mine, "mine", (d) => d.list.nodes.filter((n) => n?.number).map((n) => toPr(n, d.viewer.login, notes)));
  take(merged, "merged", (d) => d.list.nodes.filter((n) => n?.number)
    .map((n) => ({ number: n.number, title: n.title, url: n.url, repo: n.repository.nameWithOwner, created: n.createdAt, mergedAt: n.mergedAt,
      additions: n.additions, deletions: n.deletions, ci: n.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null }))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)));
  next.mergedDays = mergedDays();
  const capped = (reviews.status === "fulfilled" && reviews.value.list.issueCount > 100) || (mine.status === "fulfilled" && mine.value.list.issueCount > 100);
  if (!failed.length) next.at = Date.now();
  next.error = failed.length ? `GitHub failed (${failed.join("; ")}), showing older data` : capped ? "more than 100 PRs, list is cut off" : null;
  // Triage marks outlive a PR dropping off the list (a team re-request brings it back), so prune by age only.
  const triaged = shared("squirrel.triaged") ?? {}, cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  const kept = Object.fromEntries(Object.entries(triaged).filter(([, at]) => (at?.at ?? at) > cutoff));
  if (Object.keys(kept).length !== Object.keys(triaged).length) setShared("squirrel.triaged", kept);
  setShared("squirrel.github", next);
}

