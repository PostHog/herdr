const STACK_DEPTH_CHECK = "stack-depth / Stack depth";
const BUCKET_RANK = { failed: 0, running: 1, cancelled: 2, passed: 3 };
const BUCKET_WORD = { failed: "failed", running: "running", cancelled: "cancelled", passed: "passed" };
const OPINIONS = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function tallyChecks(checks) {
  const tally = { failed: 0, running: 0, passed: 0, cancelled: 0, total: 0 };
  for (const check of checks) {
    tally[check.bucket] = (tally[check.bucket] ?? 0) + 1;
    tally.total++;
  }
  return tally;
}

export function tallySummary(counts) {
  return { failed: counts?.failed ?? 0, running: counts?.inProgress ?? 0, passed: counts?.passed ?? 0, cancelled: counts?.cancelled ?? 0, total: (counts?.total ?? 0) + (counts?.cancelled ?? 0) };
}

export function worstBucket(tally) {
  if (tally.failed) return "failed";
  if (tally.running) return "running";
  if (tally.passed) return "passed";
  return null;
}

export function tallyLabel(tally) {
  if (tally.failed) return `${tally.failed} failed`;
  if (tally.running) return `${tally.running} running`;
  return String(tally.total);
}

export function tallyText(tally) {
  return ["failed", "running", "cancelled", "passed"].filter((bucket) => tally[bucket]).map((bucket) => `${tally[bucket]} ${BUCKET_WORD[bucket]}`).join(" · ");
}

export function parseCheckName(name) {
  const split = name.indexOf(" / ");
  const workflow = split === -1 ? null : name.slice(0, split);
  const job = split === -1 ? name : name.slice(split + 3);
  const shard = job.match(/^(.*\S)\s*\((\d+)\s*\/\s*(\d+)\)$/);
  const base = shard ? shard[1] : job;
  const parts = base.match(/^([^(,]+?)\s*[(,]\s*(.*)$/);
  return {
    workflow,
    base,
    title: parts ? parts[1] : base,
    params: parts ? parts[2].replace(/[()]/g, "").split(/\s*,\s*/).filter(Boolean).join(" · ") : "",
    shard: shard ? { index: Number(shard[2]), total: Number(shard[3]) } : null,
  };
}

function rowFrom(key, parsed, members) {
  const shards = [...members].sort((a, b) => (a.shard?.index ?? 0) - (b.shard?.index ?? 0));
  const bucket = shards.map((member) => member.check.bucket).sort((a, b) => BUCKET_RANK[a] - BUCKET_RANK[b])[0];
  const hits = shards.filter((member) => member.check.bucket === bucket).length;
  const sharded = shards.some((member) => member.shard);
  const pick = shards.find((member) => member.check.bucket === "failed") ?? shards.find((member) => member.check.bucket === "running") ?? shards[0];
  return {
    key,
    workflow: parsed.workflow,
    title: parsed.title,
    params: parsed.params,
    name: sharded ? parsed.base : shards[0].check.name,
    sharded,
    shards: shards.map((member) => ({ index: member.shard?.index ?? null, bucket: member.check.bucket, url: member.check.url, name: member.check.name })),
    bucket,
    status: sharded && hits < shards.length ? `${hits}/${shards.length} ${BUCKET_WORD[bucket]}` : BUCKET_WORD[bucket],
    url: pick.check.url ?? null,
    required: shards.some((member) => member.check.required),
  };
}

export function groupChecks(checks, otherName = "Other checks") {
  const rows = new Map();
  checks.forEach((check, index) => {
    const parsed = parseCheckName(check.name);
    const key = parsed.shard ? `${parsed.workflow ?? ""}\u0000${parsed.base}` : `${check.name}\u0000${index}`;
    if (!rows.has(key)) rows.set(key, { parsed, members: [] });
    rows.get(key).members.push({ check, shard: parsed.shard });
  });
  const groups = new Map();
  for (const [key, { parsed, members }] of rows) {
    const name = parsed.workflow ?? otherName;
    if (!groups.has(name)) groups.set(name, { name, rows: [], checks: [] });
    const group = groups.get(name);
    group.rows.push(rowFrom(key, parsed, members));
    group.checks.push(...members.map((member) => member.check));
  }
  return [...groups.values()]
    .map((group) => {
      const tally = tallyChecks(group.checks);
      const sortedRows = group.rows.sort((a, b) => BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] || a.title.localeCompare(b.title));
      return { name: group.name, rows: sortedRows, tally, settled: !tally.failed && !tally.running, rank: BUCKET_RANK[sortedRows[0]?.bucket] ?? 3 };
    })
    .sort((a, b) => a.rank - b.rank);
}

export function rowMatches(row, filter) {
  if (filter === "failed" || filter === "running") return row.shards.some((shard) => shard.bucket === filter);
  if (filter === "passed") return row.bucket === "passed";
  return true;
}

export function latestReviews(reviews, author) {
  const byLogin = new Map();
  for (const review of reviews) {
    const login = review.author?.login ?? "ghost";
    if (login === author || review.state === "PENDING") continue;
    const entry = byLogin.get(login) ?? { login, isBot: Boolean(review.isBot), state: "COMMENTED", at: null, url: null, commented: false };
    if (OPINIONS.includes(review.state) || entry.state === "COMMENTED") entry.state = review.state;
    if (!entry.at || Date.parse(review.submittedAt ?? 0) >= Date.parse(entry.at)) {
      entry.at = review.submittedAt;
      entry.url = review.url;
    }
    if ((review.body ?? "").trim()) entry.commented = true;
    byLogin.set(login, entry);
  }
  return [...byLogin.values()].sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
}

const QUEUE_PROVIDER = { trunk: "Trunk", github: "GitHub" };

function queueGate(queue) {
  if (!queue || queue.state === "not_submitted") return { state: "idle", sub: "Not queued" };
  const who = QUEUE_PROVIDER[queue.provider] ?? "Queue";
  const position = queue.position ? ` #${queue.position}` : "";
  switch (queue.state) {
    case "testing":
      return { state: "run", sub: `${who}, testing` };
    case "tests_passed":
      return { state: "ok", sub: `${who}, merging` };
    case "pending_failure":
      return { state: "bad", sub: `${who}, failing` };
    case "failed":
    case "unmergeable":
      return { state: "bad", sub: `${who}, failed` };
    case "cancelled":
      return { state: "warn", sub: "Removed" };
    case "merged":
      return { state: "merged", sub: "Merged" };
    case "not_ready":
      return { state: "warn", sub: `${who}, not ready` };
    default:
      return { state: queue.active ? "info" : "idle", sub: `${who}, ${queue.state.replace(/_/g, " ")}${position}` };
  }
}

function queueDoing(queue) {
  return { testing: "testing it", tests_passed: "merging it", pending_failure: "seeing failures on it", awaiting_checks: "waiting on its checks", mergeable: "about to merge it" }[queue.state] ?? "holding it in line";
}

export function readiness(pr, detail, { queueBased = false } = {}) {
  const ignoreStack = Boolean(pr.stackDepth);
  const checks = detail ? detail.checks.filter((check) => !(ignoreStack && check.name === STACK_DEPTH_CHECK)) : null;
  const tally = checks ? tallyChecks(checks) : tallySummary(pr.checks);
  const reviewers = detail ? latestReviews(detail.reviews, pr.author) : null;
  const approvals = reviewers ? reviewers.filter((reviewer) => reviewer.state === "APPROVED").length : pr.approvals ?? 0;
  const botApprovals = reviewers ? reviewers.filter((reviewer) => reviewer.state === "APPROVED" && reviewer.isBot).length : pr.botApprovals ?? 0;
  const approvalText = (count) => (botApprovals ? `${plural(count - botApprovals, "approval")} + ${botApprovals} bot` : plural(count, "approval"));
  const open = detail ? detail.threads.filter((thread) => !thread.isResolved && !thread.isOutdated) : null;
  const openThreads = open ? open.length : pr.threads?.total ?? 0;
  const botThreads = open ? open.filter((thread) => thread.isBot).length : pr.threads?.bot ?? 0;
  const humanThreads = openThreads - botThreads;
  const conflicting = pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY";
  const behind = pr.mergeState === "BEHIND";
  const decision = pr.reviewDecision;
  const failedRows = checks ? groupChecks(checks).flatMap((group) => group.rows).filter((row) => row.bucket === "failed") : [];

  const checksGate = tally.failed
    ? { state: "bad", sub: `${tally.failed} failed` }
    : tally.running
      ? { state: "run", sub: `${tally.running} running` }
      : tally.passed
        ? { state: "ok", sub: `${tally.passed} passed` }
        : { state: "idle", sub: "None" };
  const reviewGate =
    decision === "CHANGES_REQUESTED"
      ? { state: "bad", sub: "Changes requested" }
      : decision === "APPROVED"
        ? { state: "ok", sub: approvalText(Math.max(approvals, 1)) }
        : decision === "REVIEW_REQUIRED"
          ? { state: "warn", sub: approvals ? `${approvalText(approvals)}, needs more` : "Waiting" }
          : approvals
            ? { state: "ok", sub: approvalText(approvals) }
            : { state: "idle", sub: "Not required" };
  const threadsGate = humanThreads
    ? { state: "warn", sub: botThreads ? `${humanThreads} open, ${botThreads} bot` : `${humanThreads} open` }
    : botThreads
      ? { state: "warn", sub: `${botThreads} from bots`, bot: true }
      : { state: "ok", sub: "None open" };
  const conflictsGate = conflicting
    ? { state: "bad", sub: "Conflicting" }
    : behind
      ? { state: "warn", sub: "Behind base" }
      : pr.mergeable === "UNKNOWN"
        ? { state: "idle", sub: "Checking" }
        : { state: "ok", sub: "None" };
  const othersClear = [checksGate, reviewGate, threadsGate, conflictsGate].every((gate) => gate.state === "ok" || gate.state === "idle");
  const lastGate = queueBased
    ? { id: "queue", label: "Queue", ...queueGate(pr.queue) }
    : {
        id: "merge",
        label: "Merge",
        ...(pr.state === "MERGED"
          ? { state: "merged", sub: "Merged" }
          : pr.isDraft
            ? { state: "idle", sub: "Draft" }
            : !othersClear
              ? { state: "idle", sub: "Not yet" }
              : pr.mergeState === "BLOCKED"
                ? { state: "warn", sub: "Blocked" }
                : { state: "ok", sub: "Ready" }),
      };
  const gates = [
    { id: "checks", label: "Checks", ...checksGate },
    { id: "review", label: "Review", ...reviewGate },
    { id: "threads", label: "Threads", ...threadsGate },
    { id: "conflicts", label: "Conflicts", ...conflictsGate },
    lastGate,
  ];
  return { gates, tally, approvals, botApprovals, openThreads, reviewers, verdict: verdictFor({ pr, tally, approvals, openThreads, botThreads, conflicting, behind, decision, failedRows, queueBased, othersClear }) };
}

function verdictFor({ pr, tally, approvals, openThreads, botThreads, conflicting, behind, decision, failedRows, queueBased, othersClear }) {
  const mine = Boolean(pr.mine);
  const queue = pr.queue;
  const who = QUEUE_PROVIDER[queue?.provider] ?? "The queue";
  if (pr.state === "MERGED") return { title: "Merged", detail: "It's merged. Nothing needs you.", tone: "merged", primary: null };
  if (pr.state === "CLOSED") return { title: "Closed", detail: "It was closed without merging.", tone: "dim", primary: null };
  if (queue?.active) return { title: "In the merge queue", detail: `${who} is ${queueDoing(queue)}. Nothing needs you.`, tone: queue.state === "pending_failure" ? "bad" : "info", primary: null };
  if (queue?.state === "failed") return { title: "Queue failed", detail: mine ? `${who} couldn't merge it. Fix it, then send it again.` : `${who} couldn't merge it.`, tone: "bad", primary: mine ? (tally.failed || conflicting ? "fix" : "merge") : null };
  if (pr.isDraft) return { title: "Draft", detail: mine ? "Mark it ready for review when it's done." : "The author hasn't marked it ready.", tone: "dim", primary: mine ? "markReady" : null };
  if (conflicting) return { title: "Has conflicts", detail: mine ? "Merge the base branch in to unblock it." : "The author needs to merge the base branch in.", tone: "bad", primary: mine ? "fix" : null };
  if (tally.failed) {
    const where = failedRows.length ? `${failedRows[0].title}${failedRows.length > 1 ? ` and ${plural(failedRows.length - 1, "other")}` : ""}. ` : "";
    return { title: `${plural(tally.failed, "check")} failed`, detail: `${where}${mine ? "Fix or rerun to unblock." : "Waiting on the author."}`, tone: "bad", primary: mine ? "fix" : null };
  }
  if (pr.stackDepth) return { title: pr.stackDepth.checked ? "Stack too deep" : "Stack depth not checked", detail: "Land the PRs below it first.", tone: "warn", primary: null };
  if (decision === "CHANGES_REQUESTED") return { title: "Changes requested", detail: mine ? "A reviewer asked for changes." : "Waiting on the author.", tone: "bad", primary: mine ? "fix" : null };
  if (openThreads) return { title: botThreads === openThreads ? plural(openThreads, "open bot thread") : plural(openThreads, "open thread"), detail: mine ? "Reply to or resolve them before merging." : "The discussion is still open.", tone: "warn", primary: mine ? "fix" : null };
  if (queue?.state === "cancelled") return { title: "Removed from the queue", detail: mine ? "Send it again when it's ready." : "Nothing needs you.", tone: "warn", primary: mine && !tally.running ? "merge" : null };
  if (tally.running) {
    const reviewed = decision !== "REVIEW_REQUIRED";
    const detail = !reviewed ? "Waiting on CI and a review." : queueBased ? `${approvals ? "Approved and conflict-free" : "Conflict-free"}. Ready to queue.` : "Waiting on CI. Nothing needs you.";
    return { title: "Checks are running", detail, tone: "run", primary: mine && reviewed && queueBased ? "merge" : !mine && !reviewed ? "review" : null };
  }
  if (decision === "REVIEW_REQUIRED") return mine ? { title: "Waiting on review", detail: `Checks are green. ${approvals ? "It needs another approval." : "No approval yet."}`, tone: "warn", primary: null } : { title: "Needs a review", detail: `Checks are green. ${approvals ? "It needs another approval." : "No approval yet."}`, tone: "warn", primary: "review" };
  if (behind) return { title: "Behind the base branch", detail: mine ? "Update the branch before merging." : "The author needs to update the branch.", tone: "warn", primary: mine ? "updateBranch" : null };
  if (!queueBased && pr.mergeState === "BLOCKED" && othersClear) return { title: "Blocked by GitHub", detail: "Branch protection is holding it.", tone: "warn", primary: null };
  if (!mine) return { title: "Ready to merge", detail: "Waiting on the author. Nothing needs you.", tone: "ok", primary: null };
  return { title: queueBased ? "Ready to queue" : "Ready to merge", detail: `Checks are green${decision === "APPROVED" ? " and it's approved" : ""}.`, tone: "ok", primary: "merge" };
}

const MERGE_STATE_NOTES = {
  BLOCKED: "Branch protection is holding it: reviews or required checks.",
  BEHIND: "The base branch has moved on.",
  DIRTY: "Merging the base branch conflicts.",
  UNSTABLE: "Non-required checks are failing.",
  CLEAN: "GitHub would merge it now.",
  HAS_HOOKS: "GitHub would merge it now, after hooks.",
  UNKNOWN: "GitHub hasn't worked it out yet.",
  DRAFT: "Drafts can't merge.",
};

export function mergeStateNote(pr) {
  if (pr.mergeState === "BLOCKED" && pr.queue?.active) return "Blocked is normal while the queue holds the PR.";
  return MERGE_STATE_NOTES[pr.mergeState] ?? "";
}

export function fileTag(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/(^|\/)__snapshots__\//.test(path) || /\.snap$/.test(name) || /snapshot/i.test(name)) return "snapshot";
  if (/^test_|_test\.|\.test\.|\.spec\.|_spec\./.test(name) || /(^|\/)(tests?|__tests__)\//.test(path)) return "test";
  return null;
}

function fileEntry(file) {
  const cut = file.path.lastIndexOf("/") + 1;
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  return { path: file.path, dir: file.path.slice(0, cut), name: file.path.slice(cut), additions, deletions, size: additions + deletions, tag: fileTag(file.path) };
}

function sharedDirectory(entries) {
  const split = entries.map((entry) => entry.dir.split("/").filter(Boolean));
  const shared = [];
  for (let depth = 0; split.every((parts) => depth < parts.length && parts[depth] === split[0][depth]); depth++) shared.push(split[0][depth]);
  return shared.length ? `${shared.join("/")}/` : "";
}

export function changeShape(files, largestCount = 4) {
  const entries = files.map(fileEntry);
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const share = (size) => (total ? Math.round((size / total) * 100) : 0);
  const byTop = new Map();
  for (const entry of entries) {
    const top = entry.path.includes("/") ? entry.path.slice(0, entry.path.indexOf("/")) : "";
    byTop.set(top, [...(byTop.get(top) ?? []), entry]);
  }
  const [top, members] = [...byTop.entries()].sort((a, b) => b[1].reduce((sum, entry) => sum + entry.size, 0) - a[1].reduce((sum, entry) => sum + entry.size, 0))[0] ?? ["", []];
  const topShare = share(members.reduce((sum, entry) => sum + entry.size, 0));
  const tagged = (tag) => entries.filter((entry) => entry.tag === tag);
  const note = (tag, one, many) => {
    const hits = tagged(tag);
    if (!hits.length) return null;
    const part = share(hits.reduce((sum, entry) => sum + entry.size, 0));
    return `${hits.length} ${hits.length === 1 ? one : many}${part >= 10 ? `, ${part}% of the diff` : ""}`;
  };
  return {
    where: top && byTop.size > 1 && topShare >= 50 ? `${topShare}% in ${sharedDirectory(members)}` : null,
    notes: [note("test", "test file", "test files"), note("snapshot", "snapshot", "snapshots")].filter(Boolean),
    largest: entries.length > 1 ? [...entries].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path)).slice(0, largestCount) : entries,
    more: Math.max(0, entries.length - largestCount),
  };
}

const INLINE = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\((\S+?)\)/g;

export function parseInline(text) {
  const spans = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index) });
    if (match[2] !== undefined) spans.push({ text: match[2], code: true });
    else if (match[3] !== undefined || match[4] !== undefined) spans.push({ text: match[3] ?? match[4], bold: true });
    else spans.push({ text: match[5], link: match[6] });
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.filter((span) => span.text);
}

export function parseMarkdown(text) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "list", items: list.items.map((item) => ({ marker: item.marker, spans: parseInline(item.text) })) });
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (code) {
      if (/^\s*(```|~~~)/.test(line)) {
        blocks.push(code);
        code = null;
      } else code.lines.push(line);
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      code = { type: "code", lines: [] };
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      list ??= { items: [] };
      list.items.push({ marker: bullet ? null : `${ordered[1]}.`, text: (bullet ? bullet[1] : ordered[2]).trim() });
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1].text += ` ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (code) blocks.push(code);
  flush();
  return blocks;
}
