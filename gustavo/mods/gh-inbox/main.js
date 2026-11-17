// Your pull requests, the Trunk merge queue and your review requests, as tabs
// you can drag into any order. Data comes from the `gh` and `trunk` CLIs.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, exec, props, openOverlay, nextCommand, notify, shared, setShared, spaces, layout, terminals, appHome, home, readTextFile, writeTextFile } from "herdr";
import { TRUNK_REPO, TrunkUnavailable, login, searchPrs, stacks, queue, queueItem, testRun, enqueue, dequeue, ghEnqueue, ghDequeue } from "./data.js";

// The account new Claude sessions start as, from the tasks mod's switcher: plain `claude` for main,
// else its launcher (~/.claude-accounts/claude-as <account>).
function claudeArgv() {
  const name = shared("tasks.account");
  const known = (shared("tasks.accounts") ?? []).some((a) => a.name === name);
  return name && name !== "main" && known ? [`${home()}/.claude-accounts/claude-as`, name] : ["claude"];
}

// The system browser, through macOS `open`: "Open on GitHub" did nothing with cx.open_url, and
// a failure here says why instead of doing nothing.
function openInBrowser(url) {
  exec("open", [url]).then(
    (r) => { if (r.code !== 0) notify({ title: "Couldn't open the link", body: r.stderr?.trim() || url, level: "error", timeout: 5000 }); },
    (e) => notify({ title: "Couldn't open the link", body: String(e?.message ?? e), level: "error", timeout: 5000 }));
}

const ICON = (name) => `mods/gh-inbox/icons/${name}.svg`;
// The layout block this panel sits in: minimizing shrinks it to the tab strip.
const BLOCK = "pull-requests";
// What the panel last read (your PRs, the Trunk queue), shared so the Merge view (this mod's "merge"
// part, in the main area) shows the same without asking GitHub and Trunk again. Its `actions`
// count adds to the Inbox badge in the tasks mod's view switch (the Merge part sits beside its inbox).
const MERGE_STATE = "gh-inbox.merge";
// Back to Work from the Merge view, as the tasks mod's view switch does it.
function toWork() {
  run("layout.select", { stack: "main-stack", child: "main" });
}
const STRIP_PX = 28; // minimized: the section header alone, as tall as the other sections' (tasks mod)
const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null));

// Same words as the tasks mod's resolvePrompt (mods can't import each other): it commits,
// but stops before anything leaves the machine.
const resolvePrompt = (url) => `Resolve the unresolved review comments on ${url}.
List its unresolved review threads (gh api graphql, reviewThreads where isResolved is false). Find the checkout or worktree for the PR's branch, or make a worktree.
For each thread: read it with the code around it, then make the change it asks for, or decide it shouldn't change and say why. Commit the fixes.
Before pushing or replying on GitHub, show me each thread with what you changed or the reply you'd post, and wait for my go-ahead.`;

// The tab a PR's comments session runs in, named as the tasks mod names it: "#123 comments",
// "charts#123 comments" outside posthog.
const commentsTab = (pr) => `${pr.repo === TRUNK_REPO ? "" : pr.repo.split("/")[1]}#${pr.number} comments`;

// The open comments session for a PR, if one is running: found by the command it started with
// (its first message names the PR), as the tasks panel finds it; a task renames its main tab.
function findCommentsTab(pr) {
  const marker = `review comments on ${pr.url}`;
  const term = terminals().find((x) => x.state === "live" && (x.argv ?? []).some((a) => String(a).startsWith("Resolve the unresolved") && String(a).includes(marker)));
  const labels = term?.labels ?? {};
  const space = spaces().find((s) => s.id === labels["herdr.space"] || s.id.endsWith(`/${labels["herdr.space"]}`));
  const tab = space?.tabs.find((t) => t.id === labels["herdr.tab"] || t.id.endsWith(`/${labels["herdr.tab"]}`));
  return space && tab ? { space: space.id, tab: tab.id } : null;
}

// A Claude session for a PR's open threads: in the task the PR belongs to (the tasks mod's
// shared "tasks.prs"), else a new task named after it, which the tasks mod attaches the PR to.
function resolveComments(pr) {
  const tasks = shared("tasks.prs") ?? {};
  const space = Object.keys(tasks).find((id) => tasks[id]?.[pr.key]);
  const name = commentsTab(pr);
  const task = resolvePrompt(pr.url);
  if (space) {
    run("tab.new", { space, name, argv: claudeArgv(), task });
    return;
  }
  const taskName = `${pr.title.slice(0, 40)} (#${pr.number})`;
  setShared("tasks.attach", [...(shared("tasks.attach") ?? []), { name: taskName, key: pr.key, url: pr.url, at: Date.now() }]);
  // space.new's name is the space's; the tab needs its own, so the session can be found again.
  run("space.new", { name: taskName, tab: name, argv: claudeArgv(), task });
}
const GH_EVERY = 60000;
const TRUNK_EVERY = 45000;
// `trunk merge status` lists at most this many items per state.
const LISTING_CAP = 10;
const capped = (n) => (n >= LISTING_CAP ? `${n}+` : String(n));

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]).catch((e) => ({ failed: String(e?.message ?? e) }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

const TABS = {
  mine: { label: "Mine", icon: "pr" },
  queue: { label: "Queue", icon: "queue" },
  review: { label: "Review", icon: "eye" },
};

function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Theme colors for each kind of state, so the panel follows the theme.
function palette(t) {
  return { ok: t.ansi2, bad: t.ansi1, warn: t.ansi3, run: t.working ?? t.ansi4, merged: t.ansi5, dim: t.dim, muted: t.muted, accent: t.accent };
}

// Visual review runs with changes waiting for a person to approve.
const visualAsks = (pr) => (pr.visual ?? []).filter((v) => v.kind === "approve");

function visualStep(pr, p) {
  const asks = visualAsks(pr);
  if (!asks.length) return null;
  const v = asks[0];
  return { icon: "eye", color: p.warn, label: `Visuals: ${v.summary}`, url: v.url };
}

export default class GhInbox extends View {
  init(_props, cx) {
    this.part = props()?.part ?? "panel";
    if (this.part === "merge") return this.initMerge(cx);
    const allowed = props()?.tabs;
    this.tabIds = Array.isArray(allowed) && allowed.length ? allowed.filter((id) => TABS[id]) : Object.keys(TABS);
    const saved = JSON.parse(localStorage.getItem("order") ?? "[]");
    this.order = [...saved.filter((id) => this.tabIds.includes(id)), ...this.tabIds.filter((id) => !saved.includes(id))];
    this.tab = this.order.includes(localStorage.getItem("tab")) ? localStorage.getItem("tab") : this.order[0];
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? '["review:teams","queue:merged"]'));
    this.known = new Set(JSON.parse(localStorage.getItem("known") ?? "[]"));
    this.notifies = props()?.notify ?? !allowed;

    this.me = null;
    this.mine = null;
    this.reviews = null;
    this.queue = null;
    this.items = new Map();
    this.mineQueue = null;
    this.runs = new Map();
    this.errors = {};
    this.fails = { gh: 0, trunk: 0 };
    this.busy = { gh: false, trunk: false };
    this.seen = null;
    this.width = 268;
    this.collapsed = localStorage.getItem("collapsed") === "1";

    cx.timer.every(GH_EVERY, (cx) => this.refreshGh(cx));
    cx.timer.every(TRUNK_EVERY, (cx) => this.refreshTrunk(cx));
    this.refreshGh(cx);
    this.refreshTrunk(cx);

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "confirmed" && this.pending) await this.act(cx);
        else if (c === "refresh") this.refreshAll(cx);
        else if (c === "toggle") this.setCollapsed(!this.collapsed, cx);
        else if (c.startsWith("show-") && this.order.includes(c.slice(5))) this.select(c.slice(5), cx);
        cx.notify();
      }
    });
  }

  refreshAll(cx) {
    this.refreshGh(cx);
    this.refreshTrunk(cx);
  }

  refreshGh(cx) {
    if (this.busy.gh) return;
    this.busy.gh = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.me ??= await login();
        const [mine, reviews] = await Promise.all([searchPrs("author:@me"), searchPrs("review-requested:@me -author:@me")]);
        // GitHub search now and then answers with nothing and no error. An empty list
        // replaces a full one only when the next refresh agrees.
        this.mine = this.settle("mine", mine);
        this.reviews = this.settle("reviews", reviews);
        for (const p of mine) if (p.repo === TRUNK_REPO) this.known.add(p.number);
        localStorage.setItem("known", JSON.stringify([...this.known].slice(-200)));
        delete this.errors.gh;
        this.fails.gh = 0;
        if (!this.mineQueue) this.refreshTrunk(cx);
        this.announce();
      } catch (e) {
        this.errors.gh = String(e?.message ?? e);
        this.fails.gh++;
      }
      this.busy.gh = false;
      if (!this.errors.gh) this.updated = Date.now();
      this.publish();
      cx.notify();
    });
  }

  settle(kind, list) {
    this.emptyOnce ??= {};
    const had = this[kind]?.length > 0;
    if (list.length || !had || this.emptyOnce[kind]) {
      this.emptyOnce[kind] = false;
      return list;
    }
    this.emptyOnce[kind] = true;
    return this[kind];
  }

  refreshTrunk(cx) {
    if (this.busy.trunk) return;
    this.busy.trunk = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.queue = await queue();
        delete this.errors.trunk;
        this.fails.trunk = 0;
        this.trunkOff = null;
        // The listing is capped per state, so each of your open PRs is asked about directly.
        // Everyone's testing items too while the Queue tab shows, for their progress.
        const open = (this.mine ?? []).filter((m) => m.repo === TRUNK_REPO);
        const numbers = [...new Set([
          ...open.map((m) => m.number),
          ...this.queue.items.filter((i) => this.known.has(i.number) && i.state !== "Merged").map((i) => i.number),
          ...(this.tab === "queue" ? this.queue.items.filter((i) => i.state === "Testing").map((i) => i.number) : []),
        ])];
        const details = await pool(numbers, 4, (n) => queueItem(n));
        // A lookup that failed keeps the PR's last known state instead of dropping it from the queue.
        this.items = new Map(numbers.map((n, k) => [n, details[k]?.failed ? this.items.get(n) ?? null : details[k]]));
        if (this.mine) {
          const mq = new Map();
          // A cancelled submission is history: the PR is just open again.
          for (const m of open) {
            const k = numbers.indexOf(m.number);
            if (details[k]?.failed && this.mineQueue?.has(m.number)) {
              mq.set(m.number, this.mineQueue.get(m.number));
              continue;
            }
            const d = this.items.get(m.number);
            if (d?.state && d.state !== "Cancelled") mq.set(m.number, { number: m.number, state: d.state, title: m.title });
          }
          for (const i of this.queue.items) if (this.known.has(i.number) && !mq.has(i.number) && !open.some((m) => m.number === i.number)) mq.set(i.number, i);
          this.mineQueue = mq;
        }
        const tests = [...new Set([...this.items.values()].map((d) => d?.testPr).filter(Boolean))];
        const runs = await Promise.all(tests.map((n) => testRun(n).catch(() => null)));
        this.runs = new Map(tests.map((n, k) => [n, runs[k]]));
        this.announce();
      } catch (e) {
        if (e instanceof TrunkUnavailable) {
          // No Trunk here: the queue tab says why, and nothing else mentions it.
          this.trunkOff = e.message;
          this.mineQueue = new Map();
        } else {
          this.errors.trunk = String(e?.message ?? e);
          this.fails.trunk++;
        }
      }
      this.busy.trunk = false;
      this.publish();
      cx.notify();
    });
  }

  // The queue entry a PR rides on: its own, or the layer above it that was enqueued for the stack.
  queueFor(pr, group) {
    if (pr.ghEntry) return { gh: true, number: pr.number, title: pr.title, state: pr.ghEntry.state, position: pr.ghEntry.position, via: null };
    if (pr.repo !== TRUNK_REPO || !this.mineQueue) return null;
    const find = (n) => this.mineQueue.get(n);
    const own = find(pr.number);
    if (own) return { ...own, via: null };
    if (!group) return null;
    const idx = group.members.findIndex((m) => m.pr.key === pr.key);
    for (const m of group.members.slice(idx + 1)) {
      const hit = find(m.pr.number);
      if (hit) return { ...hit, via: m.pr.number };
    }
    return null;
  }

  // Why a PR can't merge yet, most blocking first.
  blocker(pr, p) {
    if (pr.draft) return { icon: "pr-draft", color: p.dim, label: "Draft" };
    if (pr.conflicts) return { icon: "conflict", color: p.bad, label: "Conflicts" };
    const vr = visualStep(pr, p);
    if (vr) return vr;
    if (pr.checks.fail) return { icon: "fail", color: p.bad, label: `${plural(pr.checks.fail, "check")} failing` };
    if (pr.decision === "CHANGES_REQUESTED") return { icon: "changes", color: p.bad, label: "Changes requested" };
    if (pr.checks.running) return { icon: "spinner", spin: true, color: p.run, label: `CI ${pr.checks.pass}/${pr.checks.total}` };
    if (pr.decision === "REVIEW_REQUIRED") return { icon: "waiting", color: p.warn, label: "Needs review" };
    return null;
  }

  // What happens next for a PR: queue progress first, then what blocks it.
  step(pr, q, p) {
    if (q?.gh) {
      switch (q.state) {
        case "AWAITING_CHECKS": return { icon: "testing", color: p.run, label: "Testing in the queue" };
        case "MERGEABLE": return { icon: "rocket", color: p.ok, label: "Merging" };
        case "UNMERGEABLE": return { icon: "fail", color: p.bad, label: "Queue failing" };
        case "LOCKED": return { icon: "paused", color: p.warn, label: "Queue locked" };
        default: return { icon: "hourglass", color: p.accent, label: q.position ? `${ordinal(q.position)} in line` : "In line" };
      }
    }
    if (q) {
      const d = this.items.get(q.number);
      const via = q.via ? ` via #${q.via}` : "";
      switch (q.state) {
        case "Merged":
          return { icon: "merged", color: p.merged, label: "Merged" };
        case "Failed":
        case "Pending Failure":
          return { icon: "fail", color: p.bad, label: `Queue ${q.state === "Failed" ? "failed" : "failing"}${via}` };
        case "Cancelled":
          return { icon: "ban", color: p.dim, label: "Removed from queue" };
        case "Tests Passed":
          return { icon: "rocket", color: p.ok, label: "Merging" };
        case "Testing": {
          const r = d?.testPr ? this.runs.get(d.testPr) : null;
          const pct = r?.checks.total ? Math.round(((r.checks.pass + r.checks.fail) / r.checks.total) * 100) : null;
          return { icon: "testing", color: r?.checks.fail ? p.bad : p.run, label: `Testing${pct === null ? "" : ` ${pct}%`}${via}`, progress: r };
        }
        case "Pending": {
          const waiting = this.queue.items.filter((i) => i.state === "Pending");
          const pos = waiting.findIndex((i) => i.number === q.number) + 1;
          return { icon: "hourglass", color: p.accent, label: `${pos > 0 ? `${ordinal(pos)} in line` : `In line, ${LISTING_CAP}+ ahead`}${via}` };
        }
        case "Not Ready": {
          const b = pr ? this.blocker(pr, p) : null;
          return { icon: "paused", color: p.warn, label: `Queued, waiting${b ? `: ${b.label.toLowerCase()}` : ""}${via}` };
        }
      }
    }
    if (!pr) return { icon: "pr", color: p.muted, label: q?.state ?? "" };
    return this.blocker(pr, p) ?? this.ready(pr, p);
  }

  // Nothing blocks the merge, but open review threads are worth a look first.
  ready(pr, p) {
    if (pr.unresolved) return { icon: "comment", color: p.warn, label: `Ready, ${plural(pr.unresolved, "unresolved comment")}`, ready: true };
    return { icon: "check", color: p.ok, label: "Ready to merge", ready: true };
  }

  // Posts a notification when one of your PRs changes in a way you'd act on.
  announce() {
    if (!this.notifies || !this.mine) return;
    const now = new Map();
    for (const pr of this.mine) {
      const q = pr.repo === TRUNK_REPO ? this.mineQueue?.get(pr.number) : null;
      now.set(pr.key, { pr, ci: pr.checks.fail ? "fail" : pr.checks.running ? "run" : "ok", decision: pr.decision, queue: q?.state ?? null, visual: visualAsks(pr).length > 0 });
    }
    for (const i of this.mineQueue?.values() ?? []) {
      const key = `${TRUNK_REPO}#${i.number}`;
      if (!now.has(key)) now.set(key, { pr: { key, number: i.number, title: i.title, url: `https://github.com/${TRUNK_REPO}/pull/${i.number}` }, queue: i.state });
    }
    const direct = new Set((this.reviews ?? []).filter((r) => r.requested.includes(this.me)).map((r) => r.key));
    if (this.seen) {
      const say = (pr, title, level) => notify({ title, body: `#${pr.number} ${pr.title}`, level, timeout: 8000 });
      for (const [key, s] of now) {
        const was = this.seen.mine.get(key);
        if (!was) continue;
        if (s.queue !== was.queue && s.queue === "Merged") say(s.pr, "Merged", "success");
        else if (s.queue !== was.queue && (s.queue === "Failed" || s.queue === "Cancelled")) say(s.pr, s.queue === "Failed" ? "Merge queue failed" : "Removed from the merge queue", "error");
        if (s.visual && was.visual === false) say(s.pr, "Visual changes to approve", "warning");
        if (s.ci === "fail" && was.ci && was.ci !== "fail" && !s.visual) say(s.pr, "Checks failing", "error");
        if (s.decision !== was.decision && s.decision === "APPROVED") say(s.pr, "Approved", "success");
        if (s.decision !== was.decision && s.decision === "CHANGES_REQUESTED") say(s.pr, "Changes requested", "warning");
      }
      for (const r of this.reviews ?? []) if (direct.has(r.key) && !this.seen.direct.has(r.key)) say(r, `Review requested by ${r.author}`, "info");
    }
    this.seen = { mine: now, direct };
  }

  // Your PR goes through a merge queue: Trunk's for posthog, GitHub's where its base branch has one.
  queueable(pr) {
    return pr.repo === TRUNK_REPO ? !this.trunkOff : Boolean(pr.ghQueue);
  }

  ask(action, pr, layers = 1) {
    this.pending = { action, number: pr.number, pr };
    const enqueueing = action === "enqueue";
    if (pr.repo && pr.repo !== TRUNK_REPO) {
      openOverlay({
        mod: "confirm",
        kind: "dialog",
        width: 400,
        height: 190,
        props: {
          title: enqueueing ? `Add #${pr.number} to the merge queue?` : `Remove #${pr.number} from the merge queue?`,
          detail: enqueueing ? `Adds "${pr.title}" to ${pr.repo}'s GitHub merge queue.` : `Takes "${pr.title}" out of ${pr.repo}'s merge queue. It stays open.`,
          command: { name: "gh-inbox.confirmed" },
        },
      });
      return;
    }
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      width: 400,
      height: 190,
      props: {
        title: enqueueing ? (layers > 1 ? `Merge the stack of ${layers} through Trunk?` : `Merge #${pr.number} through Trunk?`) : `Remove #${pr.number} from the queue?`,
        detail: enqueueing
          ? layers > 1
            ? `Enqueues the top layer, #${pr.number}. Trunk tests all ${layers} layers together and merges them at once.`
            : `Adds "${pr.title}" to the merge queue. In a stack, every layer below it goes in with it.`
          : `Takes "${pr.title}" out of the merge queue. It stays open.`,
        command: { name: "gh-inbox.confirmed" },
      },
    });
  }

  async act(cx) {
    const { action, number, pr } = this.pending;
    this.pending = null;
    if (pr?.repo && pr.repo !== TRUNK_REPO) return this.actGithub(action, pr, cx);
    try {
      const r = action === "enqueue" ? await enqueue(number) : await dequeue(number);
      const last = r.out.trim().split("\n").filter(Boolean).pop() ?? "";
      if (/already exists/i.test(r.out)) {
        notify({ title: `#${number} is already submitted`, body: "Trunk already has it. The panel now shows its queue state.", level: "info", timeout: 8000 });
        this.refreshAfter(cx);
        return;
      }
      notify({ title: r.code === 0 ? (action === "enqueue" ? `#${number} submitted to Trunk` : `#${number} removed from the queue`) : `Trunk refused #${number}`, body: last, level: r.code === 0 ? "success" : "error", timeout: 8000 });
    } catch (e) {
      notify({ title: `Trunk failed for #${number}`, body: String(e?.message ?? e), level: "error" });
    }
    this.refreshAfter(cx);
  }

  async actGithub(action, pr, cx) {
    const name = `${pr.repo.split("/")[1]}#${pr.number}`;
    try {
      if (action === "enqueue") {
        const entry = await ghEnqueue(pr.id);
        notify({ title: `${name} added to the merge queue`, body: entry?.position ? `${ordinal(entry.position)} in line.` : pr.title, level: "success", timeout: 8000 });
      } else {
        await ghDequeue(pr.id);
        notify({ title: `${name} removed from the merge queue`, body: pr.title, level: "success", timeout: 8000 });
      }
    } catch (e) {
      notify({ title: `GitHub refused ${name}`, body: String(e?.message ?? e), level: "error" });
    }
    this.refreshAfter(cx);
  }

  // The panel does the reading; the Merge view asks it to, through its command.
  refreshAfter(cx) {
    if (this.part === "merge") run("gh-inbox.refresh");
    else this.refreshAll(cx);
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  // Minimized, only the tab strip shows and the rest of the sidebar gets the room. Opening
  // again gives the block back the size it had.
  setCollapsed(on, cx) {
    if (on === this.collapsed) return;
    this.collapsed = on;
    localStorage.setItem("collapsed", on ? "1" : "0");
    if (on) {
      const size = findNode(layout(), BLOCK)?.size;
      if (size && !(size.px && size.px <= STRIP_PX)) localStorage.setItem("size", JSON.stringify(size));
      run("layout.resize", { id: BLOCK, px: STRIP_PX });
    } else {
      run("layout.resize", { id: BLOCK, ...JSON.parse(localStorage.getItem("size") ?? '{"weight":1.6}') });
    }
    cx.notify();
  }

  select(id, cx) {
    if (this.collapsed) this.setCollapsed(false, cx);
    const was = this.tab;
    this.tab = id;
    localStorage.setItem("tab", id);
    if (id === "queue" && was !== "queue") this.refreshTrunk(cx);
    cx.notify();
  }

  // Dropping a dragged tab on another puts it in that tab's place.
  drop(onto, cx) {
    const from = this.dragging;
    this.dragging = null;
    if (!from || from === onto) return;
    const order = this.order.filter((id) => id !== from);
    order.splice(this.order.indexOf(onto), 0, from);
    this.order = order;
    localStorage.setItem("order", JSON.stringify(order));
    cx.notify();
  }

  counts() {
    const qMine = [...(this.mineQueue?.values() ?? [])].filter((i) => i.state !== "Merged").length;
    const direct = (this.reviews ?? []).filter((r) => r.requested.includes(this.me)).length;
    return { mine: this.mine?.length, queue: qMine || null, review: direct || this.reviews?.length };
  }

  // ---- drawing ----

  icon(t, name, color, size = 14, spin = false) {
    const el = svg(ICON(name)).size(size).flex_none().text_color(color);
    return spin ? el.spin(900) : el;
  }

  chip(t, s, size = 11) {
    return h_flex().gap(4).items_center().flex_none().text_size(size).text_color(s.color)
      .child(this.icon(t, s.icon, s.color, size + 1, s.spin))
      .child(div().whitespace_nowrap().child(s.label));
  }

  // ---- this panel among the sidebar's sections ----
  // Sections move by dragging their header onto another's (the tasks mod has the same, through the
  // shared "sidebar.drag"); here the header is the tab strip, held by its empty part.

  sectionDrag() {
    const d = shared("sidebar.drag");
    return d && Date.now() - d.at < 30000 ? d : null;
  }

  async dropSection(from, to, cx) {
    setShared("sidebar.drag", null);
    try {
      const path = `${appHome()}/layouts/${shared("layout")}.json`;
      const before = await readTextFile(path);
      const tree = JSON.parse(before);
      const column = findNode(tree, "sidebar-lists");
      const ids = column.children.map((c) => c.id);
      const i = ids.indexOf(from), j = ids.indexOf(to);
      if (i < 0 || j < 0 || i === j) return;
      const [moved] = column.children.splice(i, 1);
      column.children.splice(j, 0, moved);
      await writeTextFile(path, JSON.stringify(tree, null, 2) + "\n", before);
    } catch (e) {
      notify({ title: "Couldn't move the section", body: String(e?.message ?? e), level: "error" });
    }
    cx.notify();
  }

  // The section's header, the same as the sidebar's other sections (tasks mod sectionHeader):
  // chevron, title, then actions on the right. The whole row minimizes and opens the section,
  // and dragged, moves it.
  header(t) {
    const drag = this.sectionDrag();
    const takes = Boolean(drag) && drag.block !== BLOCK;
    return h_flex().id("ghi-head").h(28).px(12).flex_none().gap(6).items_center().cursor_pointer()
      .text_color(t.muted).hover((x) => x.text_color(t.foreground))
      .border_1().border_color(takes ? t.accent : "#00000000").when(takes, (el) => el.border_dashed().rounded(6))
      .when(drag?.block === BLOCK, (el) => el.opacity(0.5))
      .on_mouse_down("left", (e) => { this.secPress = { x: e.position.x, y: e.position.y }; })
      .on_mouse_up("left", (_e, cx) => { if (takes) { cx.stop_propagation(); this.dropSection(drag.block, BLOCK, cx); } })
      .on_click((_e, cx) => {
        if (this.secDragged) { this.secDragged = false; return; } // the press was a drag
        this.setCollapsed(!this.collapsed, cx);
      })
      .child(svg(ICON(this.collapsed ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(11.5).font_medium().child("Pull requests"))
      .when(this.collapsed && this.counts()[this.tab] != null, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${TABS[this.tab].label} ${this.counts()[this.tab]}`)))
      .child(div().flex_1())
      .child(h_flex().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation()).child(this.refreshButton(t)));
  }

  // Mine, Queue, Review: under the header while the section is open. Dragged, they reorder.
  tabStrip(t, cx) {
    const counts = this.counts();
    return h_flex().id("ghi-strip").pb(4).mb(2).flex_none().items_center().gap(2).border_b_1().border_color(t.border)
      .children(this.order.map((id) => {
        const on = id === this.tab;
        const n = counts[id];
        return h_flex().id(`ghi-tab-${id}`).h(24).px(7).gap(5).items_center().rounded(6).cursor_pointer()
          .text_size(11.5).font_medium()
          .text_color(on ? t.foreground : t.dim)
          .when(on, (el) => el.bg(t.raised))
          .when(Boolean(this.dragging) && this.dragging !== id, (el) => el.border_1().border_color(t.border).border_dashed())
          .hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", () => { this.dragging = id; })
          .on_mouse_up("left", (_e, cx) => this.drop(id, cx))
          .on_click((_e, cx) => this.select(id, cx))
          .tooltip("Drag to reorder")
          .child(TABS[id].label)
          .when(n != null, (el) => el.child(div().text_size(10.5).text_color(on ? t.muted : t.dim).child(String(n))));
      }));
  }

  // Turns yellow while the last refresh failed and the list shows older data.
  refreshButton(t) {
    const busy = this.busy.gh || this.busy.trunk;
    const stale = Object.keys(this.errors).filter((k) => this.errors[k]);
    const color = stale.length ? palette(t).warn : t.dim;
    const when = this.updated ? `Updated ${ago(Date.now() - this.updated)} ago.` : "";
    const why = stale.map((k) => `Last ${k} refresh failed: ${this.errors[k]}`).join("\n");
    return div().id("ghi-refresh").text_color(color).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .tooltip([why, when, "Click to refresh."].filter(Boolean).join("\n"))
      .on_click((_e, cx) => this.refreshAll(cx))
      .child(this.icon(t, busy ? "spinner" : "refresh", color, 13, busy));
  }

  sectionHeader(t, id, label, count, cx, extra = null) {
    const open = !this.folded.has(id);
    return h_flex().id(`ghi-sec-${id}`).px(8).h(28).mt(4).flex_none().items_center().gap(6).rounded(6).cursor_pointer()
      .text_size(11).font_medium().text_color(t.dim).hover((s) => s.text_color(t.muted))
      .on_click((_e, cx) => this.fold(id, cx))
      .child(this.icon(t, open ? "chevron-down" : "chevron-right", t.dim, 11))
      .child(div().child(label))
      .child(div().text_color(t.dim).child(String(count)))
      .child(div().flex_1())
      .when(Boolean(extra), (el) => el.child(extra));
  }

  progressBar(t, p, run) {
    const total = run.checks.total || 1;
    const width = Math.max(60, this.width - 92);
    const done = Math.round(((run.checks.pass + run.checks.fail) / total) * width);
    return v_flex().gap(3).mt(2)
      .child(h_flex().w(width).h(4).rounded(2).bg(t.raised).overflow_hidden()
        .child(div().w(done).h(4).bg(run.checks.fail ? p.bad : p.run)))
      .child(div().text_size(10.5).text_color(t.dim).child(
        `${run.checks.pass + run.checks.fail}/${run.checks.total} checks${run.checks.fail ? `, ${run.checks.fail} failing` : ""} · ${ago(Date.now() - run.started)}`));
  }

  // A PR row: what's next, then CI, reviews and comments at a glance. A click opens the PR;
  // buttons show only when something waits on you.
  prRow(t, pr, cx, { group = null, depth = 0, review = false } = {}) {
    const p = palette(t);
    const q = review ? null : this.queueFor(pr, group);
    let s = review ? this.reviewStep(pr, p) : this.step(pr, q, p);
    const below = !review && !q && s.ready ? this.blockedBelow(pr, group, p) : null;
    if (below) s = { icon: "stack", color: p.warn, label: `Waiting on #${below.number} below`, below };
    const c = pr.checks;
    const ci = c.fail ? { icon: "fail", color: p.bad, label: `${c.fail}` } : c.running ? { icon: "spinner", spin: true, color: p.run, label: `${c.pass}/${c.total}` } : c.total ? { icon: "check", color: p.ok, label: "" } : null;
    const meta = [];
    if (review) meta.push(div().text_color(t.dim).child(`${pr.author} · ${ago(Date.now() - pr.created)}`));
    else meta.push(this.chip(t, s));
    if (ci && (review || (!s.ready && !["spinner", "fail", "check"].includes(s.icon)))) meta.push(c.fail ? this.link(t, `ghi-ci-${pr.key}`, this.chip(t, ci), `${pr.url}/checks`, "Open the failing checks") : this.chip(t, ci));
    if (pr.approvedBy.length && !s.ready) meta.push(this.chip(t, { icon: "approved", color: p.ok, label: String(pr.approvedBy.length) }));
    // A ready row already counts them in its step.
    if (pr.unresolved && !s.ready) meta.push(this.chip(t, { icon: "comment", color: p.warn, label: String(pr.unresolved) }));

    const actions = this.actions(t, pr, q, s, review, group);
    const lead = this.icon(t, pr.draft ? "pr-draft" : q?.state === "Merged" ? "merged" : "pr", pr.draft ? p.dim : review ? t.muted : s.color, 15);
    return [h_flex().id(`ghi-pr-${pr.key}`).px(8).py(5).gap(8).items_start().rounded(8).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_hover((on, cx) => this.hover(pr.key, on, cx))
      .on_click((_e, cx) => openInBrowser(pr.url))
      .when(depth > 0, (el) => el.pl(8 + 14 * Math.min(depth, 3)))
      .child(div().mt(1).child(lead))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(5).items_center().min_w(0)
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${pr.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(pr.draft ? t.muted : t.foreground).child(pr.title))
          .when(this.hovered === pr.key, (el) => el.child(this.linkIcons(t, pr.key, pr.url))))
        .child(h_flex().gap(8).items_center().min_w(0).overflow_hidden().text_size(11).children(meta))
        .when(Boolean(s.progress), (el) => el.child(this.progressBar(t, p, s.progress)))
        .when(actions.length > 0, (el) => el.child(h_flex().mt(3).gap(5).flex_wrap().children(actions))))];
  }

  // Only what waits on you: approving visual changes, and merging what's ready.
  actions(t, pr, q, s, review, group) {
    const out = visualAsks(pr).map((v) =>
      this.button(t, `ghi-vrb-${pr.key}-${v.type}`, "eye", `Approve ${v.type}${v.partial ? " (partial)" : ""}`, (_e, cx) => openInBrowser(v.url), true));
    if (!review && pr.unresolved && q?.state !== "Merged") {
      const open = findCommentsTab(pr);
      out.push(open
        ? this.button(t, `ghi-resolve-${pr.key}`, "external", "Go to comments session", () => { run("space.select", { id: open.space }); run("tab.select", { id: open.tab }); })
        : this.button(t, `ghi-resolve-${pr.key}`, "comment", `Resolve ${plural(pr.unresolved, "comment")}`, () => resolveComments(pr)));
    }
    if (review || !this.queueable(pr)) return out;
    // A Trunk stack merges from its header, so its layers offer no merge of their own. GitHub's
    // queue only takes PRs on its branch, so a layer on another PR's branch isn't queueable.
    const stacked = pr.repo === TRUNK_REPO && (group?.members.length ?? 0) > 1;
    if (!q && s.ready && !stacked) out.push(this.button(t, `ghi-enq-${pr.key}`, "merged", "Merge", () => this.ask("enqueue", pr), true));
    if (q && (q.state === "Failed" || q.state === "Cancelled") && !q.via) out.push(this.button(t, `ghi-enq-${pr.key}`, "merged", "Merge again", () => this.ask("enqueue", pr), true));
    return out;
  }

  // Makes a chip open a page, without opening the PR under it.
  link(t, id, el, url, tip) {
    return el.id(id).cursor_pointer().rounded(4).hover((st) => st.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); openInBrowser(url); });
  }

  // The nearest layer under this one in its stack that can't merge yet.
  blockedBelow(pr, group, p) {
    if (!group) return null;
    const idx = group.members.findIndex((m) => m.pr.key === pr.key);
    for (let i = idx - 1; i >= 0; i--) if (this.blocker(group.members[i].pr, p)) return group.members[i].pr;
    return null;
  }

  reviewStep(pr, p) {
    if (pr.draft) return { icon: "pr-draft", color: p.dim, label: "Draft" };
    const vr = visualStep(pr, p);
    if (vr) return vr;
    if (pr.checks.fail) return { icon: "fail", color: p.bad, label: "CI failing" };
    if (pr.checks.running) return { icon: "spinner", spin: true, color: p.run, label: "CI running" };
    return { icon: "pr", color: p.ok, label: "Ready for review" };
  }

  button(t, id, iconName, label, onClick, primary = false) {
    return h_flex().id(id).h(22).px(7).gap(5).items_center().rounded(6).border_1()
      .border_color(primary ? t.input : t.border).bg(primary ? t.raised : t.surface)
      .text_size(11).text_color(primary ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); })
      .child(this.icon(t, iconName, primary ? t.foreground : t.muted, 12))
      .child(label);
  }

  // One failed refresh is usually GitHub having a moment; three in a row is worth showing.
  failing(kind) {
    return Boolean(this.errors[kind]) && this.fails[kind] >= 3;
  }

  empty(t, text) {
    return div().px(10).py(8).text_size(12).text_color(t.dim).child(text);
  }

  errorLine(t, text) {
    return h_flex().px(10).py(4).gap(6).items_start().text_size(11).text_color(palette(t).bad)
      .child(div().mt(1).child(this.icon(t, "conflict", palette(t).bad, 12)))
      .child(div().flex_1().min_w(0).child(text));
  }

  mineView(t, cx) {
    if (this.errors.gh && !this.mine) return [this.errorLine(t, `gh: ${this.errors.gh}`)];
    if (!this.mine) return [this.empty(t, "Loading your pull requests...")];
    if (!this.mine.length) return [this.empty(t, "No open pull requests.")];
    const rows = [];
    const groups = stacks(this.mine);
    const p = palette(t);
    let repo = null;
    for (const g of [...groups].sort((a, b) => (a.members[0].pr.repo === TRUNK_REPO ? 0 : 1) - (b.members[0].pr.repo === TRUNK_REPO ? 0 : 1))) {
      const r = g.members[0].pr.repo;
      if (r !== repo && r !== TRUNK_REPO) rows.push(div().px(8).pt(8).pb(2).text_size(10.5).font_medium().text_color(t.dim).child(r));
      repo = r;
      if (g.members.length > 1) {
        const id = `stack:${g.id}`;
        const top = g.members.at(-1).pr;
        const q = this.queueFor(g.members[0].pr, g);
        const ready = g.members.filter((m) => !this.blocker(m.pr, p)).length;
        const all = ready === g.members.length;
        const unresolved = g.members.reduce((n, m) => n + m.pr.unresolved, 0);
        const summary = !all ? { icon: "stack", color: t.dim, label: `${ready}/${g.members.length} ready` }
          : unresolved ? { icon: "comment", color: p.warn, label: `All ready, ${plural(unresolved, "unresolved comment")}` }
          : { icon: "check", color: p.ok, label: "All ready" };
        const extra = q
          ? this.chip(t, { ...this.step(null, q, p), label: q.state }, 10.5)
          : h_flex().gap(6).items_center()
              .child(this.chip(t, summary, 10.5))
              .when(all && top.repo === TRUNK_REPO && !this.trunkOff, (el) => el.child(div().id(`ghi-merge-${id}`).px(5).h(18).flex().items_center().rounded(5).border_1().border_color(t.border)
                .text_size(10.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => { cx.stop_propagation(); this.ask("enqueue", top, g.members.length); })
                .child("Merge stack")));
        rows.push(h_flex().id(`ghi-${id}`).px(8).h(24).mt(4).gap(6).items_center().rounded(6).cursor_pointer()
          .text_size(10.5).font_medium().text_color(t.dim).hover((s) => s.text_color(t.muted))
          .on_click((_e, cx) => this.fold(id, cx))
          .child(this.icon(t, "stack", t.dim, 12))
          .child(div().flex_1().min_w(0).truncate().child(`Stack of ${g.members.length} · ${top.head}`))
          .when(Boolean(extra), (el) => el.child(extra))
          .child(this.icon(t, this.folded.has(id) ? "chevron-right" : "chevron-down", t.dim, 11)));
        if (this.folded.has(id)) continue;
        // Top of the stack first, the layer on the base branch last, as `gh stack view` shows it.
        const members = [...g.members].reverse();
        members.forEach((m, i) => rows.push(...this.prRow(t, m.pr, cx, { group: g, depth: 1 })));
      } else {
        rows.push(...this.prRow(t, g.members[0].pr, cx, { group: g }));
      }
    }
    if (this.failing("gh")) rows.unshift(this.errorLine(t, `gh: ${this.errors.gh}`));
    if (this.failing("trunk")) rows.unshift(this.errorLine(t, `trunk: ${this.errors.trunk}`));
    return rows;
  }

  queueView(t, cx) {
    const p = palette(t);
    if (this.trunkOff) return [this.empty(t, `The merge queue needs Trunk. ${this.trunkOff}`)];
    if (this.errors.trunk && !this.queue) return [this.errorLine(t, `trunk: ${this.errors.trunk}`)];
    if (!this.queue) return [this.empty(t, "Loading the merge queue...")];
    const items = this.queue.items;
    const rows = [];
    const by = (state) => items.filter((i) => i.state === state);
    const running = this.queue.running === "Running";
    rows.push(h_flex().px(8).pt(2).pb(4).gap(8).items_center().text_size(11).text_color(t.dim)
      .child(this.chip(t, { icon: running ? "rocket" : "paused", color: running ? p.ok : p.warn, label: `${this.queue.branch} · ${this.queue.running}` }))
      .child(div().flex_1())
      .child(div().child(`${capped(by("Testing").length)} testing · ${capped(by("Pending").length)} waiting`)));

    const mineByNumber = new Map((this.mine ?? []).filter((m) => m.repo === TRUNK_REPO).map((m) => [m.number, m]));
    const groups = stacks(this.mine ?? []);
    const yours = [...(this.mineQueue?.values() ?? [])];
    if (yours.length) {
      rows.push(this.sectionHeader(t, "queue:yours", "Yours", yours.length, cx));
      if (!this.folded.has("queue:yours")) {
        for (const i of yours) {
          const pr = mineByNumber.get(i.number);
          if (pr) rows.push(...this.prRow(t, pr, cx, { group: groups.find((g) => g.members.some((m) => m.pr.key === pr.key)) }));
          else rows.push(this.queueRow(t, i, p, true));
        }
      }
    }
    const sections = [
      ["Testing", "queue:testing", "Testing"],
      ["Tests Passed", "queue:passed", "Merging"],
      ["Pending", "queue:pending", "Waiting"],
      ["Not Ready", "queue:notready", "Not ready"],
      ["Pending Failure", "queue:pfail", "Failing"],
      ["Failed", "queue:failed", "Failed"],
      ["Merged", "queue:merged", "Recently merged"],
    ];
    for (const [state, id, label] of sections) {
      const list = by(state);
      if (!list.length) continue;
      rows.push(this.sectionHeader(t, id, label, state === "Merged" ? list.length : capped(list.length), cx));
      if (!this.folded.has(id)) list.forEach((i, k) => rows.push(this.queueRow(t, i, p, this.known.has(i.number), state === "Pending" ? k + 1 : null)));
    }
    if (!items.length) rows.push(this.empty(t, "The queue is empty."));
    if (this.failing("trunk")) rows.unshift(this.errorLine(t, `trunk: ${this.errors.trunk}`));
    return rows;
  }

  queueRow(t, i, p, yours, pos = null) {
    const s = this.step(null, { ...i, via: null }, p);
    const r = s.progress;
    const pct = r?.checks.total ? Math.round(((r.checks.pass + r.checks.fail) / r.checks.total) * 100) : null;
    const key = `q-${i.number}`;
    const url = `https://github.com/${TRUNK_REPO}/pull/${i.number}`;
    return h_flex().id(`ghi-q-${i.number}`).px(8).h(26).gap(8).items_center().rounded(6).cursor_pointer()
      .text_size(12).hover((st) => st.bg(t.hover))
      .on_hover((on, cx) => this.hover(key, on, cx))
      .on_click((_e, cx) => openInBrowser(`https://github.com/${TRUNK_REPO}/pull/${i.number}`))
      .tooltip(`${i.state}: #${i.number} ${i.title}`)
      .child(this.icon(t, s.icon, s.color, 13))
      .when(pos != null, (el) => el.child(div().w(16).flex_none().text_size(10.5).text_color(t.dim).child(String(pos))))
      .child(div().flex_none().text_size(11).text_color(yours ? p.accent : t.dim).child(`#${i.number}`))
      .child(div().flex_1().min_w(0).truncate().text_color(yours ? t.foreground : t.muted).when(yours, (el) => el.font_medium()).child(i.title))
      .when(pct != null && this.hovered !== key, (el) => el.child(div().flex_none().text_size(10.5).text_color(r.checks.fail ? p.bad : t.dim)
        .child(`${pct}% · ${ago(Date.now() - r.started)}`)))
      .when(this.hovered === key, (el) => el.child(this.linkIcons(t, key, url)));
  }

  hover(key, on, cx) {
    if (on) this.hovered = key;
    else if (this.hovered === key) this.hovered = null;
    cx.notify();
  }

  // Copy and open, shown on the hovered row.
  linkIcons(t, key, url) {
    const icon = (id, name, tip, onClick) => div().id(`ghi-${id}-${key}`).p(2).rounded(4).flex_none().cursor_pointer()
      .text_color(t.dim).hover((st) => st.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(ICON(name)).size(13));
    return h_flex().flex_none().gap(2).items_center()
      .child(icon("copy", "copy", "Copy link", (cx) => {
        cx.write_to_clipboard(url);
        notify({ title: "Link copied", body: url, level: "success", timeout: 2500 });
      }))
      .child(icon("open", "external", "Open on GitHub", (cx) => openInBrowser(url)));
  }

  reviewView(t, cx) {
    if (this.errors.gh && !this.reviews) return [this.errorLine(t, `gh: ${this.errors.gh}`)];
    if (!this.reviews) return [this.empty(t, "Loading review requests...")];
    if (!this.reviews.length) return [this.empty(t, "Nothing is waiting on your review.")];
    const direct = this.reviews.filter((r) => r.requested.includes(this.me));
    const teams = this.reviews.filter((r) => !r.requested.includes(this.me));
    const rows = [];
    for (const [id, label, list] of [["review:you", "Requested from you", direct], ["review:teams", "Your teams", teams]]) {
      if (!list.length) continue;
      rows.push(this.sectionHeader(t, id, label, list.length, cx));
      if (!this.folded.has(id)) for (const pr of list.sort((a, b) => b.updated - a.updated)) rows.push(...this.prRow(t, pr, cx, { review: true }));
    }
    return rows;
  }

  // The sidebar's rail: each tab as an icon and its count.
  rail(t, cx) {
    const counts = this.counts();
    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).items_center().pt(10).gap(8)
      .children(this.order.map((id) => v_flex().id(`ghi-rail-${id}`).items_center().gap(1).cursor_pointer()
        .text_color(id === this.tab ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.select(id, cx))
        .tooltip(TABS[id].label)
        .child(svg(ICON(TABS[id].icon)).size(15))
        .child(div().text_size(10).child(counts[id] != null ? String(counts[id]) : ""))));
  }

  // ---- the Merge view (part "merge", in the main area) ----

  // What the panel read, for the Merge view. Only the sidebar panel publishes it.
  publish() {
    if (this.part !== "panel" || !this.notifies) return;
    const lists = this.mine ? this.mergeLists(palette(theme())) : null;
    const state = {
      me: this.me,
      mine: this.mine,
      queue: this.queue,
      mineQueue: [...(this.mineQueue?.entries() ?? [])],
      items: [...this.items.entries()],
      runs: [...this.runs.entries()],
      trunkOff: this.trunkOff ?? null,
      errors: this.errors,
      updated: this.updated ?? null,
      actions: lists ? lists.ready.length + lists.failing.length : null,
      // Review requests, for the tasks mod's Inbox: asked of you, or of a team you're on.
      reviews: (this.reviews ?? []).map((p) => ({
        key: p.key, repo: p.repo, number: p.number, title: p.title, url: p.url, author: p.author, draft: p.draft,
        updated: p.updated, additions: p.additions, deletions: p.deletions,
        direct: p.requested.includes(this.me), teams: p.requested.filter((r) => r.startsWith("@")),
      })),
    };
    if (JSON.stringify(state) !== JSON.stringify(shared(MERGE_STATE) ?? null)) setShared(MERGE_STATE, state);
  }

  initMerge(cx) {
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.width = 520;
    this.hovered = null;
    this.hydrate();
    cx.spawn(async (cx) => {
      for (;;) {
        // The panel takes every other command; this view only carries out its own confirmations.
        const c = await nextCommand();
        if (c === "confirmed" && this.pending) await this.act(cx);
        cx.notify();
      }
    });
  }

  hydrate() {
    const s = shared(MERGE_STATE);
    this.loaded = Boolean(s);
    this.me = s?.me ?? null;
    this.mine = s?.mine ?? null;
    this.queue = s?.queue ?? null;
    this.mineQueue = new Map(s?.mineQueue ?? []);
    this.items = new Map(s?.items ?? []);
    this.runs = new Map(s?.runs ?? []);
    this.trunkOff = s?.trunkOff ?? null;
    this.errors = s?.errors ?? {};
    this.updated = s?.updated ?? null;
  }

  // Your PRs by what they need for the merge: ready but not queued yet (yours to do), in a queue
  // that failed them (yours too), riding a queue, and merged by Trunk lately.
  mergeLists(p) {
    const mine = this.mine ?? [];
    const ready = [];
    const failing = [];
    const queued = [];
    const merged = [];
    for (const g of stacks(mine)) {
      const top = g.members.at(-1).pr;
      // A Trunk stack goes in whole, from its top layer, once every layer is ready.
      if (top.repo === TRUNK_REPO && g.members.length > 1) {
        const all = g.members.every((m) => !this.blocker(m.pr, p));
        if (all && !g.members.some((m) => this.queueFor(m.pr, g))) ready.push({ pr: top, group: g, layers: g.members.length, queueable: this.queueable(top) });
        continue;
      }
      for (const m of g.members) {
        if (this.queueFor(m.pr, g) || !this.step(m.pr, null, p).ready || this.blockedBelow(m.pr, g, p)) continue;
        // A layer on another PR's branch merges into that branch, not the base: it waits for the one below.
        if (m.depth > 0) continue;
        ready.push({ pr: m.pr, group: g, layers: 1, queueable: this.queueable(m.pr) });
      }
    }
    // Queueable first: those are a click away.
    ready.sort((a, b) => Number(b.queueable) - Number(a.queueable) || b.pr.updated - a.pr.updated);
    for (const i of this.mineQueue.values()) {
      const pr = mine.find((m) => m.repo === TRUNK_REPO && m.number === i.number) ?? null;
      const g = pr ? stacks(mine).find((x) => x.members.some((m) => m.pr.key === pr.key)) : null;
      const item = { pr, item: i, q: { ...i, via: null }, layers: g?.members.length ?? 1 };
      if (i.state === "Merged") merged.push(item);
      else if (i.state === "Failed" || i.state === "Pending Failure") failing.push(item);
      else queued.push(item);
    }
    for (const pr of mine) {
      if (!pr.ghEntry) continue;
      const item = { pr, item: null, q: this.queueFor(pr, null), layers: 1 };
      (pr.ghEntry.state === "UNMERGEABLE" ? failing : queued).push(item);
    }
    return { ready, failing, queued, merged };
  }

  // The task a PR is attached to, from the tasks mod.
  taskOf(pr) {
    const tasks = shared("tasks.prs") ?? {};
    const id = Object.keys(tasks).find((k) => tasks[k]?.[pr.key]);
    return id ? spaces().find((s) => s.id === id) ?? null : null;
  }

  mergeCard(t, p, { pr, item, q, layers = 1, queueable = false }, kind) {
    const number = pr?.number ?? item.number;
    const repo = pr?.repo ?? TRUNK_REPO;
    const url = pr?.url ?? `https://github.com/${TRUNK_REPO}/pull/${number}`;
    const title = pr?.title ?? item?.title ?? "";
    const s = q ? this.step(pr, q, p) : this.step(pr, null, p);
    const task = pr ? this.taskOf(pr) : null;
    const id = `mg-${repo}-${number}`;
    const target = pr ?? { number, title, repo };
    const buttons = [];
    if (kind === "ready" && queueable) buttons.push(this.button(t, `${id}-enq`, "merged", layers > 1 ? `Add the stack of ${layers} to the queue` : "Add to the queue", () => this.ask("enqueue", pr, layers), true));
    if (kind === "ready" && !queueable) buttons.push(this.button(t, `${id}-gh`, "external", repo === TRUNK_REPO ? "Open on GitHub" : "Merge on GitHub", () => openInBrowser(url), true));
    if (kind === "failing" && repo === TRUNK_REPO && !this.trunkOff) buttons.push(this.button(t, `${id}-again`, "merged", "Merge again", () => this.ask("enqueue", target), true));
    if (kind === "failing" || kind === "queued") {
      if (repo !== TRUNK_REPO ? Boolean(pr?.id) : !this.trunkOff) buttons.push(this.button(t, `${id}-deq`, "ban", "Remove from the queue", () => this.ask("dequeue", target)));
    }
    if (pr?.unresolved && kind !== "merged") {
      const open = findCommentsTab(pr);
      buttons.push(open
        ? this.button(t, `${id}-resolve`, "external", "Go to comments session", () => { toWork(); run("space.select", { id: open.space }); run("tab.select", { id: open.tab }); })
        : this.button(t, `${id}-resolve`, "comment", `Resolve ${plural(pr.unresolved, "comment")}`, () => { toWork(); resolveComments(pr); }));
    }
    // Trunk tests on a PR of its own, so a PR's checks say why only for GitHub's queue.
    if (kind === "failing" && pr && repo !== TRUNK_REPO) buttons.push(this.button(t, `${id}-checks`, "fail", "Checks", () => openInBrowser(`${url}/checks`)));
    if (task) buttons.push(this.button(t, `${id}-task`, "external", "Go to task", () => { toWork(); run("space.select", { id: task.id }); }));
    if (!(kind === "ready" && !queueable)) buttons.push(this.button(t, `${id}-open`, "external", "Open on GitHub", () => openInBrowser(url)));

    const meta = [];
    if (pr) meta.push(div().text_color(t.dim).child(`${pr.head} → ${pr.base}`));
    if (layers > 1) meta.push(this.chip(t, { icon: "stack", color: t.dim, label: `Stack of ${layers}` }));
    if (pr?.approvedBy.length) meta.push(this.chip(t, { icon: "approved", color: p.ok, label: pr.approvedBy.join(", ") }));
    if (kind === "ready" && !queueable) meta.push(div().text_color(repo === TRUNK_REPO ? p.warn : t.dim).child(repo === TRUNK_REPO ? "Trunk unavailable, see above" : "No merge queue"));
    if (task) meta.push(div().text_color(t.muted).child(`Task: ${task.name}`));
    const repoLabel = repo === TRUNK_REPO ? "" : repo.split("/")[1];
    return v_flex().id(id).p(12).gap(7).rounded(10).border_1().border_color(kind === "failing" ? p.bad : t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(this.icon(t, s.icon, s.color, 15, s.spin))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(`${repoLabel}#${number}`))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(t.foreground).child(title))
        .child(div().flex_none().text_size(11.5).text_color(s.color).child(s.label)))
      .when(meta.length > 0, (el) => el.child(h_flex().gap(12).items_center().min_w(0).overflow_hidden().text_size(11).children(meta)))
      .when(Boolean(s.progress), (el) => el.child(this.progressBar(t, p, s.progress)))
      .child(h_flex().gap(6).flex_wrap().children(buttons));
  }

  mergePage(t, cx) {
    this.hydrate();
    const p = palette(t);
    const page = (children) => v_flex().id("merge").size_full().bg(t.canvas).overflow_y_scrollbar().px(24).py(20).gap(16)
      .on_size_change((size, cx) => {
        const w = Math.min(560, Math.max(200, size.width - 120));
        if (Math.abs(w - this.width) >= 1) { this.width = w; cx.notify(); }
      })
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child("Merge"))
        .child(div().text_size(12).text_color(t.dim).child("Your PRs in a merge queue, and the ones ready to go in"))
        .child(div().flex_1())
        .when(Boolean(this.updated), (el) => el.child(div().text_size(11).text_color(t.dim).child(Date.now() - this.updated < 60000 ? "Updated just now" : `Updated ${ago(Date.now() - this.updated)} ago`)))
        .child(div().id("mg-refresh").text_color(t.dim).cursor_pointer().hover((x) => x.text_color(t.foreground)).tooltip("Refresh")
          .on_click(() => run("gh-inbox.refresh")).child(this.icon(t, "refresh", t.dim, 14))))
      .children(children);
    if (!this.loaded || !this.mine) {
      const err = this.errors.gh;
      return page([div().pt(40).w_full().flex().justify_center().text_size(13).text_color(err ? p.bad : t.dim)
        .child(err ? `gh: ${err}` : "Loading your pull requests… (the Pull requests panel reads them)")]);
    }
    const { ready, failing, queued, merged } = this.mergeLists(p);
    const section = (label, sub, items, color, kind) => v_flex().gap(8)
      .child(h_flex().gap(8).items_center().pt(6)
        .child(div().text_size(12).font_semibold().text_color(color).child(label))
        .child(div().text_size(11.5).text_color(t.dim).child(String(items.length)))
        .when(Boolean(sub), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(sub))))
      .children(items.map((x) => this.mergeCard(t, p, x, kind)));
    const notes = [];
    if (this.trunkOff) notes.push(this.errorLine(t, `Trunk: ${this.trunkOff}`));
    else if (this.errors.trunk) notes.push(this.errorLine(t, `trunk: ${this.errors.trunk}`));
    if (this.errors.gh) notes.push(this.errorLine(t, `gh: ${this.errors.gh} (showing what was read before)`));
    const trunkLine = this.queue
      ? `Trunk (${this.queue.branch}): ${this.queue.running} · ${capped(this.queue.items.filter((i) => i.state === "Testing").length)} testing · ${capped(this.queue.items.filter((i) => i.state === "Pending").length)} waiting`
      : null;
    const out = [...notes];
    if (!ready.length && !failing.length && !queued.length && !merged.length) out.push(div().pt(40).w_full().flex().justify_center().text_size(13).text_color(t.dim).child("Nothing ready to merge and nothing in a queue."));
    if (ready.length) out.push(section("Ready, not in a queue yet", "yours to add", ready, p.ok, "ready"));
    if (failing.length) out.push(section("The queue failed these", "fix, then merge again", failing, p.bad, "failing"));
    if (queued.length) out.push(section("In the queue", trunkLine, queued, p.accent, "queued"));
    if (merged.length) out.push(section("Merged lately", null, merged, p.merged, "merged"));
    return page(out);
  }

  render(cx) {
    const t = theme();
    if (this.part === "merge") return this.mergePage(t, cx);
    const root = (el) => el.id("ghi-root").on_size_change((size, cx) => {
      if (Math.abs(size.width - this.width) < 1) return;
      this.width = size.width;
      cx.notify();
    })
      .on_mouse_move((e, cx) => {
        const p = this.secPress;
        if (!p || this.sectionDrag() || Math.hypot(e.position.x - p.x, e.position.y - p.y) < 5) return;
        this.secDragged = true;
        setShared("sidebar.drag", { block: BLOCK, at: Date.now() });
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { this.secPress = null; if (this.sectionDrag()) setShared("sidebar.drag", null); cx.notify(); });
    if (this.width < 160) return root(this.rail(t, cx));
    const body = this.tab === "queue" ? this.queueView(t, cx) : this.tab === "review" ? this.reviewView(t, cx) : this.mineView(t, cx);
    // Minimized from before the header got shorter: fit the block to it.
    const px = findNode(layout(), BLOCK)?.size?.px;
    if (this.collapsed && px && px !== STRIP_PX) run("layout.resize", { id: BLOCK, px: STRIP_PX });
    return root(v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_mouse_up("left", () => { this.dragging = null; })
      .child(this.header(t))
      // Open, the tabs and the list sit in a card, like the sidebar's other open sections (tasks mod sectionCard).
      .when(!this.collapsed, (el) => el.child(v_flex().flex_1().min_h(0).mx(8).mb(6).p(4).rounded(9).border_1().border_color(t.border).bg(t.surface)
        .child(this.tabStrip(t, cx))
        .child(v_flex().id("ghi-list").flex_1().min_h(0).overflow_y_scrollbar().children(body)))));
  }
}
