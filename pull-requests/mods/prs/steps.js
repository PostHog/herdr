import { LISTING_CAP } from "./trunk.js";
import { readyToMerge } from "./github.js";

const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const visualAsks = (pr) => (pr.visual ?? []).filter((item) => item.kind === "approve");

export function blocker(pr) {
  if (pr.isDraft) return { icon: "pr-draft", tone: "dim", label: "Draft" };
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") return { icon: "conflict", tone: "bad", label: "Conflicts" };
  const ask = visualAsks(pr)[0];
  if (ask) return { icon: "eye", tone: "warn", label: `Visuals: ${ask.summary}`, url: ask.url };
  if (pr.checks.failed) return { icon: "fail", tone: "bad", label: `${plural(pr.checks.failed, "check")} failing` };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { icon: "changes", tone: "bad", label: "Changes requested" };
  if (pr.checks.inProgress) return { icon: "spinner", spin: true, tone: "run", label: `CI ${pr.checks.passed}/${pr.checks.total}` };
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { icon: "waiting", tone: "warn", label: "Needs review" };
  return null;
}

export function fixable(pr) {
  return pr.mine && (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY" || pr.checks.failed > 0 || pr.reviewDecision === "CHANGES_REQUESTED" || pr.threads.total > 0);
}

export function queueFor(pr, group, trunk) {
  if (!trunk?.items || pr.repo !== trunk.repo) return null;
  const own = trunk.items[pr.number];
  if (own) return { ...own, via: null };
  if (!group) return null;
  const index = group.members.findIndex((member) => member.pr === pr);
  for (const member of group.members.slice(index + 1)) {
    const hit = trunk.items[member.pr.number];
    if (hit) return { ...hit, via: member.pr.number };
  }
  return null;
}

export function step(pr, entry, trunk) {
  if (entry) {
    const via = entry.via ? ` via #${entry.via}` : "";
    switch (entry.state) {
      case "Merged":
        return { icon: "merged", tone: "merged", label: "Merged" };
      case "Failed":
      case "Pending Failure":
        return { icon: "fail", tone: "bad", label: `Queue ${entry.state === "Failed" ? "failed" : "failing"}${via}`, requeue: entry.state === "Failed" && !entry.via };
      case "Cancelled":
        return { icon: "ban", tone: "dim", label: "Removed from queue", requeue: !entry.via };
      case "Tests Passed":
        return { icon: "rocket", tone: "ok", label: "Merging" };
      case "Testing": {
        const run = entry.testPr ? trunk.runs?.[entry.testPr] : null;
        const done = run ? run.checks.passed + run.checks.failed : 0;
        const pct = run?.checks.total ? Math.round((done / run.checks.total) * 100) : null;
        return { icon: "testing", tone: run?.checks.failed ? "bad" : "run", label: `Testing${pct === null ? "" : ` ${pct}%`}${via}`, progress: run, since: entry.since };
      }
      case "Pending": {
        const waiting = (trunk.listing?.items ?? []).filter((item) => item.state === "Pending");
        const position = waiting.findIndex((item) => item.number === (entry.via ?? entry.number)) + 1;
        return { icon: "hourglass", tone: "accent", label: `${position > 0 ? `${ordinal(position)} in line` : `In line, ${LISTING_CAP}+ ahead`}${via}` };
      }
      case "Not Ready": {
        const why = blocker(pr);
        return { icon: "paused", tone: "warn", label: `Queued, waiting${why ? `: ${why.label.toLowerCase()}` : ""}${via}` };
      }
    }
  }
  if (pr.state === "MERGED") return { icon: "merged", tone: "merged", label: "Merged" };
  if (pr.state === "CLOSED") return { icon: "ban", tone: "dim", label: "Closed" };
  const why = blocker(pr);
  if (why) return why;
  if (pr.queue?.active) return { icon: "queue", tone: "accent", label: "In merge queue" };
  if (pr.mergeState === "BEHIND") return { icon: "waiting", tone: "warn", label: "Behind base" };
  if (!readyToMerge(pr)) return { icon: "waiting", tone: "warn", label: "Not mergeable yet" };
  return { icon: "check", tone: "ok", label: "Ready to merge", ready: true };
}

export function stackGroups(prs, newestFirst = true) {
  const key = (pr) => `${pr.repo}#${pr.number}`;
  const byKey = new Map(prs.map((pr) => [key(pr), pr]));
  const children = new Map();
  const roots = [];
  for (const pr of prs) {
    const parentKey = pr.parent ? `${pr.repo}#${pr.parent}` : null;
    if (parentKey && byKey.has(parentKey)) children.set(parentKey, [...(children.get(parentKey) ?? []), pr]);
    else roots.push(pr);
  }
  const groups = roots.map((root) => {
    const members = [];
    const walk = (pr, depth) => {
      members.push({ pr, depth });
      for (const child of (children.get(key(pr)) ?? []).sort((a, b) => a.number - b.number)) walk(child, depth + 1);
    };
    walk(root, 0);
    return { id: key(root), repo: root.repo, members, updated: Math.max(...members.map((member) => Date.parse(member.pr.updatedAt))) };
  });
  return groups.sort((a, b) => (newestFirst ? b.updated - a.updated : a.updated - b.updated));
}

export function layerWaitingOn(group, pr, trunk) {
  const index = group.members.findIndex((member) => member.pr === pr);
  for (let below = index - 1; below >= 0; below--) {
    const layer = group.members[below].pr;
    if (!step(layer, queueFor(layer, group, trunk), trunk).ready) return layer.number;
  }
  return null;
}
