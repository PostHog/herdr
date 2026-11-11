import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, shared, setShared, run, spaces, machines, notify, layout, nextCommand, focused } from "herdr";
import { loadStore, store, updateStore, prKey, newId } from "./store.js";
import { fetchMyPrs, fetchReviews, fetchDetail, statusPill, needsAttention, needsReview, readyToMerge, orderWithStacks, comparePriority, isOrgWide, ownerOf } from "./github.js";
import { mergePr, markReady, updateBranch, rerunFailed, approvePr, commentOnPr, resolveThread, openUrl, copyText, markdownLink, toggleWatch, toggleHidden, report, usesTrunk, isTrunkPr } from "./actions.js";
import { startFixSession, startReview, syncRuns, fixPrompt, findingsFixPrompt, reviewPromptForOthers, setFindingState, findingsMarkdown } from "./agents.js";
import { processSnapshot, TRIGGERS, ACTION_KINDS } from "./automation.js";
import { loadConfig, config, updateConfig, configPath, machineLabel } from "./config.js";
import { forgetCheckouts, checkoutFor } from "./runner.js";
import { loadTrunk, dequeue, resetTrunk } from "./trunk.js";
import { sidebarHeader, sidebarMine, sidebarQueue, sidebarReviews, sidebarRail, statusLine, prIcon, progressLine, stackHeader } from "./sidebar.js";
import { visualAsks, stackGroups, withoutDraftStacks, step, queueFor } from "./steps.js";
import { openClaude, CLAUDE_ICON } from "./claude.js";
import { ago, button, iconButton, glyphButton, textIconButton, chip, badge, section, empty, field, menuItem, SPINNER, tone, TEXT } from "./ui.js";

const MINE_EVERY_MS = 90000;
const REVIEWS_EVERY_MS = 180000;
const RUNS_EVERY_MS = 20000;
const TRUNK_EVERY_MS = 45000;
const FAILURES_BEFORE_ERROR = 3;
const VIEW_STACK = "pr-center";
const PAGE_NODE = "prs-page";
const WORK_NODE = "work";
const QUICK_ACTIONS_WIDTH = 138;

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const hasPage = () => Boolean(findNode(layout(), VIEW_STACK));
const pageShown = () => findNode(layout(), VIEW_STACK)?.active === PAGE_NODE;
const showView = (child) => hasPage() && run("layout.select", { stack: VIEW_STACK, child });

const PAGE_DIALOG = { mod: "prs", kind: "dialog", width: 1180, height: 800, props: { page: true } };

function leavePage() {
  if (props()?.overlay) return closeOverlay(props().overlay);
  showView(WORK_NODE);
  const now = focused();
  if (now?.pane) run("pane.focus", { pane: now.pane });
  else if (now?.terminal) run("pane.focus", { terminal: now.terminal });
}

function toggleView() {
  if (!hasPage()) return;
  const last = shared("prs.toggleAt") ?? 0;
  if (Date.now() - last < 500) return;
  setShared("prs.toggleAt", Date.now());
  if (pageShown()) leavePage();
  else showView(PAGE_NODE);
}

const PAGES = [
  { id: "mine", label: "My PRs" },
  { id: "reviews", label: "Reviews" },
  { id: "queue", label: "Queue" },
  { id: "code", label: "Code review" },
  { id: "tasks", label: "Tasks" },
  { id: "workflows", label: "Workflows" },
  { id: "settings", label: "Settings" },
];

const MINE_CHIPS = [
  { id: "attention", label: "Needs attention", test: needsAttention },
  { id: "review", label: "Needs review", test: needsReview },
  { id: "ready", label: "Ready to merge", test: readyToMerge },
  { id: "watching", label: "Watching", test: (pr) => pr.watching },
];

const REVIEW_SORTS = {
  priority: { label: "✦ Priority", next: "newest", compare: comparePriority },
  newest: { label: "↓ Newest", next: "oldest", compare: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) },
  oldest: { label: "↑ Oldest", next: "priority", compare: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) },
};

const agentsWhere = () => machineLabel(config().runner?.machine || null);
const repos = () => (config().repos?.length ? config().repos : ["PostHog/posthog"]);
const refreshSoon = () => setShared("prs.refresh", Date.now());
function cleanBody(body) {
  let text = body ?? "";
  for (let start = text.indexOf("<!--"); start !== -1; start = text.indexOf("<!--")) {
    const end = text.indexOf("-->", start + 4);
    text = text.slice(0, start) + (end === -1 ? "" : text.slice(end + 3));
  }
  return text.trim();
}
const samePr = (a, b) => a.repo === b.repo && a.number === b.number;

function claudeOn(pr) {
  const mine = shared("prs.cache.mine");
  const trunk = shared("prs.cache.trunk");
  const group = stackGroups(mine?.prs ?? []).find((candidate) => candidate.members.some((member) => samePr(member.pr, pr)));
  const own = group?.members.find((member) => samePr(member.pr, pr))?.pr ?? pr;
  const status = own.mine ? step(own, queueFor(own, group, trunk), trunk).label : null;
  return openClaude(own, { me: mine?.viewer ?? null, review: Boolean(pr.via), status, stack: group ?? null });
}
const busyKey = (pr, what) => `${prKey(pr.repo, pr.number)}:${what}`;

function setBusy(key, on) {
  const busy = { ...(shared("prs.busy") ?? {}) };
  if (on) busy[key] = Date.now();
  else delete busy[key];
  setShared("prs.busy", busy);
}

const isBusy = (pr) => Object.keys(shared("prs.busy") ?? {}).some((key) => key.startsWith(`${prKey(pr.repo, pr.number)}:`));

async function act(pr, what, title, work, { refresh = true } = {}) {
  const key = busyKey(pr, what);
  setBusy(key, true);
  try {
    await report(title, work);
  } finally {
    setBusy(key, false);
    if (refresh) refreshSoon();
  }
}

export const NAMED = {
  details: (pr) => openOverlay({ mod: "prs", kind: "dialog", width: 880, height: 760, props: { mode: "sheet", pr } }),
  open: (pr) => openUrl(pr.url),
  claude: (pr) => claudeOn(pr),
  copyLink: (pr) => act(pr, "copy", "Copy link", () => copyText(markdownLink(pr), "Copied a Markdown link."), { refresh: false }),
  merge: (pr) => act(pr, "merge", isTrunkPr(pr) || usesTrunk(pr) ? `Send #${pr.number} to Trunk` : `Merge #${pr.number}`, () => mergePr(pr)),
  dequeue: (pr) => act(pr, "dequeue", `Remove #${pr.number} from the queue`, () => dequeue(pr.number)),
  openUrl: (pr) => openUrl(pr.url),
  markReady: (pr) => act(pr, "ready", `Mark #${pr.number} ready for review`, () => markReady(pr)),
  updateBranch: (pr) => act(pr, "update", `Update #${pr.number}`, () => updateBranch(pr)),
  rerunFailed: (pr) => act(pr, "rerun", `Rerun failed checks on #${pr.number}`, () => rerunFailed(pr)),
  fix: (pr) => act(pr, "fix", `Fix #${pr.number}`, async () => {
    const started = await startFixSession(pr, fixPrompt(pr));
    return started === false ? { ok: true, quiet: true } : { ok: true, message: `Opened a Claude session on ${agentsWhere()}.` };
  }),
  agentReview: (pr) => act(pr, "review", `Agent review of #${pr.number}`, async () => {
    await startReview(pr);
    return { ok: true, message: `Started on ${agentsWhere()}: four lenses, then a judge.` };
  }),
  reviewInClaude: (pr) => act(pr, "claude-review", `Review #${pr.number}`, async () => {
    const started = await startFixSession(pr, reviewPromptForOthers(pr), "review");
    return started === false ? { ok: true, quiet: true } : { ok: true, message: `Opened a Claude review session on ${agentsWhere()}.` };
  }),
  approve: (pr) => act(pr, "approve", `Approve #${pr.number}`, () => approvePr(pr)),
  watch: (pr) => act(pr, "watch", pr.watching ? "Stopped watching" : "Watching", async () => {
    await toggleWatch(pr);
    return { ok: true, quiet: true };
  }),
  hide: (pr) => act(pr, "hide", "Hide", async () => {
    await toggleHidden(pr);
    return { ok: true, quiet: true };
  }, { refresh: false }),
};

const CONFIRM = {
  merge: (pr) => ({ title: isTrunkPr(pr) || usesTrunk(pr) ? "Send to the Trunk merge queue?" : "Merge this PR?", detail: `${pr.repo}#${pr.number} "${pr.title}"${isTrunkPr(pr) || usesTrunk(pr) ? " is submitted to Trunk with trunk merge (or a /trunk merge comment when the Trunk CLI isn't available)." : ` is squash-merged at ${pr.headSha?.slice(0, 7) ?? "its current head"} (or queued, if the base branch uses GitHub's merge queue). It's refused if someone pushed since.`}`, label: isTrunkPr(pr) || usesTrunk(pr) ? "Send to queue" : "Merge" }),
  dequeue: (pr) => ({ title: "Remove from the merge queue?", detail: `${pr.repo}#${pr.number} "${pr.title}" leaves Trunk's queue (trunk merge cancel).`, label: "Remove" }),
  approve: (pr) => ({ title: "Approve this PR?", detail: `${pr.repo}#${pr.number} "${pr.title}" by @${pr.author}, at ${pr.headSha?.slice(0, 7) ?? "its current head"}.`, label: "Approve" }),
};

function choose(name, pr) {
  if (CONFIRM[name]) {
    openOverlay({ mod: "prs", kind: "dialog", width: 420, height: 190, props: { mode: "confirm", name, pr } });
    return;
  }
  NAMED[name](pr);
}

function menuEntries(pr, scope) {
  if (scope === "reviews") {
    return [
      ["details", "Details"],
      ["open", "Open on GitHub"],
      ["copyLink", "Copy as Markdown link"],
      ["claude", "Claude Code on this PR"],
      ["agentReview", "Agent review (headless)"],
      ["reviewInClaude", "Review in Claude"],
      ["approve", "Approve…"],
      ["hide", pr.hidden ? "Unhide" : "Hide"],
    ];
  }
  return [
    ["details", "Details"],
    ["open", "Open on GitHub"],
    ["copyLink", "Copy as Markdown link"],
    ["claude", "Claude Code on this PR"],
    ["fix", "Fix with Claude"],
    ["agentReview", "Agent review (headless)"],
    ...(pr.mine && pr.isDraft ? [["markReady", "Mark ready for review"]] : []),
    ...(pr.mine ? [["merge", isTrunkPr(pr) || usesTrunk(pr) ? "Send to merge queue…" : "Merge…"]] : []),
    ...(pr.mine && isTrunkPr(pr) ? [["dequeue", "Remove from merge queue…"]] : []),
    ["updateBranch", "Update branch"],
    ["rerunFailed", "Rerun failed checks"],
    ["watch", pr.watching ? "Stop watching" : "Watch"],
  ];
}

function openMenu(pr, scope) {
  const count = menuEntries(pr, scope).length;
  openOverlay({ mod: "prs", kind: "popup", width: 250, height: 40 + count * 28, props: { mode: "menu", pr, scope } });
}

function filterMatches(filter, pr) {
  const list = (text) => String(text ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (filter.repos?.length && !filter.repos.includes(pr.repo)) return false;
  const labels = pr.labels.map((label) => label.toLowerCase());
  const wanted = list(filter.labels);
  if (wanted.length && (filter.labelsMode === "all" ? !wanted.every((label) => labels.includes(label)) : !wanted.some((label) => labels.includes(label)))) return false;
  if (list(filter.excludeLabels).some((label) => labels.includes(label))) return false;
  if (filter.title && !pr.title.toLowerCase().includes(filter.title.toLowerCase())) return false;
  const authors = list(filter.authors);
  if (authors.length && !authors.includes(pr.author.toLowerCase())) return false;
  return true;
}

export default class Prs extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.mode ?? "panel";
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      await loadStore();
      cx.notify();
    });
    if (this.mode === "panel") this.initPanel(cx);
    if (this.mode === "sheet") this.initSheet(p, cx);
    if (this.mode === "filter") this.initFilterEditor(p, cx);
    if (this.mode === "workflow") this.initWorkflowEditor(p, cx);
    if (this.mode === "addPr") this.initAddPr(cx);
    if (["menu", "confirm"].includes(this.mode)) this.handle.focus();
  }

  initPanel(cx) {
    this.page = localStorage.getItem("page") ?? "mine";
    const requested = shared("prs.page.request");
    if (requested && Date.now() - requested.at < 15000) this.page = requested.page;
    if (!PAGES.some((page) => page.id === this.page)) this.page = "mine";
    this.sidebarTab = localStorage.getItem("sidebarTab") ?? "mine";
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? '["review:teams","queue:merged"]'));
    this.trunk = shared("prs.cache.trunk") ?? null;
    this.mineFailures = 0;
    this.reviewsFailures = 0;
    this.seen = null;
    this.seenConfig = shared("prs.config") ?? null;
    this.sortNewest = localStorage.getItem("sort") !== "oldest";
    this.reviewSort = REVIEW_SORTS[localStorage.getItem("reviewSort")] ? localStorage.getItem("reviewSort") : "priority";
    this.chips = new Set();
    this.hideDrafts = localStorage.getItem("hideDrafts") === "true";
    this.hovered = null;
    this.repoFilter = null;
    this.viaFilter = null;
    this.savedFilter = null;
    this.showHidden = false;
    this.mine = shared("prs.cache.mine") ?? null;
    this.reviews = shared("prs.cache.reviews") ?? null;
    this.width = 0;
    this.mineError = null;
    this.reviewsError = null;
    this.loadingMine = false;
    this.loadingReviews = false;
    this.search = InputState.new({ placeholder: "Search title, repo or #number…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.seenStore = shared("prs.store") ?? null;
    this.seenRefresh = shared("prs.refresh") ?? null;
    this.settingsForm = null;
    cx.spawn(async (cx) => {
      await loadConfig();
      this.initSettingsForm();
      cx.notify();
    });
    this.leader = !props()?.page;
    this.seenPageRequest = requested?.at ?? null;
    this.seenRefreshAll = shared("prs.refreshAll") ?? null;
    this.publishedStatus = null;
    if (this.leader) {
      this.loadMine(cx);
      this.loadReviews(cx);
      cx.timer.every(MINE_EVERY_MS, (cx) => this.loadMine(cx));
      cx.timer.every(REVIEWS_EVERY_MS, (cx) => this.loadReviews(cx));
      cx.timer.every(TRUNK_EVERY_MS, (cx) => this.loadTrunkData(cx));
      cx.timer.every(RUNS_EVERY_MS, (cx) => cx.spawn(async (cx) => {
        try {
          if (await syncRuns()) cx.notify();
        } catch {}
      }));
    }
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command !== "toggle") continue;
        toggleView();
        cx.notify();
      }
    });
    cx.timer.every(1500, (cx) => {
      if (this.leader) this.publishStatus();
      const refreshAll = shared("prs.refreshAll") ?? null;
      if (this.leader && refreshAll !== this.seenRefreshAll) {
        this.seenRefreshAll = refreshAll;
        this.loadMine(cx);
        this.loadReviews(cx);
      }
      const configVersion = shared("prs.config") ?? null;
      if (configVersion !== this.seenConfig) {
        this.seenConfig = configVersion;
        forgetCheckouts();
        resetTrunk();
        cx.spawn(async (cx) => {
          await loadConfig();
          this.initSettingsForm();
          this.refreshAll(cx);
        });
      }
      const storeVersion = shared("prs.store") ?? null;
      if (storeVersion !== this.seenStore) {
        this.seenStore = storeVersion;
        cx.spawn(async (cx) => {
          await loadStore();
          cx.notify();
        });
      }
      const refresh = shared("prs.refresh") ?? null;
      if (refresh !== this.seenRefresh) {
        this.seenRefresh = refresh;
        if (this.leader) this.loadMine(cx);
      }
    });
  }

  loadMine(cx) {
    if (this.loadingMine) return;
    this.loadingMine = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await Promise.all([loadStore(), loadConfig()]);
        this.mine = await fetchMyPrs(repos(), store().watched, config().trunk?.repo ?? null);
        this.mineFailures = 0;
        this.mineError = null;
        setShared("prs.cache.mine", this.mine);
        this.loadTrunkData(cx);
        await processSnapshot({ viewer: this.mine.viewer, prs: this.mine.prs, reviews: this.reviews });
      } catch (error) {
        this.mineFailures++;
        if (!this.mine || this.mineFailures >= FAILURES_BEFORE_ERROR) this.mineError = String(error?.message ?? error);
      }
      this.loadingMine = false;
      this.announce();
      cx.notify();
    });
  }

  loadTrunkData(cx) {
    if (this.loadingTrunk || !this.mine) return;
    this.loadingTrunk = true;
    cx.spawn(async (cx) => {
      try {
        const result = await loadTrunk(this.mine.prs);
        this.trunk = !result.listing && this.trunk?.listing && result.available ? { ...this.trunk, error: result.error } : result;
        setShared("prs.cache.trunk", this.trunk);
      } catch (error) {
        this.trunk = { ...(this.trunk ?? {}), error: String(error?.message ?? error) };
      }
      this.loadingTrunk = false;
      this.announce();
      cx.notify();
    });
  }

  announce() {
    if (!this.mine || config().notifications === false) return;
    const now = new Map();
    for (const pr of this.mine.prs) {
      const entry = isTrunkPr(pr) ? this.trunk?.items?.[pr.number] : null;
      now.set(prKey(pr.repo, pr.number), { pr, ci: pr.checks.failed ? "fail" : pr.checks.inProgress ? "run" : "ok", decision: pr.reviewDecision, queue: entry?.state ?? null, visual: visualAsks(pr).length > 0, stack: Boolean(pr.stackDepth) });
    }
    const viewer = this.mine.viewer;
    const direct = new Set((this.reviews ?? []).filter((pr) => pr.via?.direct).map((pr) => prKey(pr.repo, pr.number)));
    if (this.seen) {
      const action = hasPage() ? { action: { name: "layout.select", args: { stack: VIEW_STACK, child: PAGE_NODE } } } : {};
      const say = (pr, title, level) => notify({ title, body: `#${pr.number} ${pr.title}`, level, timeout: 8000, ...action });
      for (const [key, state] of now) {
        const was = this.seen.mine.get(key);
        if (!was) continue;
        if (state.queue !== was.queue && state.queue === "Merged") say(state.pr, "Merged", "success");
        else if (state.queue !== was.queue && (state.queue === "Failed" || state.queue === "Cancelled")) say(state.pr, state.queue === "Failed" ? "Merge queue failed" : "Removed from the merge queue", "error");
        if (state.visual && !was.visual) say(state.pr, "Visual changes to approve", "warning");
        if (state.ci === "fail" && was.ci !== "fail" && !state.visual) say(state.pr, "Checks failing", "error");
        if (state.stack && !was.stack) say(state.pr, "Stack too deep", "warning");
        if (state.decision !== was.decision && state.decision === "APPROVED") say(state.pr, "Approved", "success");
        if (state.decision !== was.decision && state.decision === "CHANGES_REQUESTED") say(state.pr, "Changes requested", "warning");
      }
      if (this.reviews) for (const pr of this.reviews) if (direct.has(prKey(pr.repo, pr.number)) && !this.seen.direct.has(prKey(pr.repo, pr.number))) say(pr, `Review requested by @${pr.author}`, "info");
    }
    this.seen = { mine: now, direct: this.reviews ? direct : this.seen?.direct ?? direct, viewer };
  }

  publishStatus() {
    const status = {
      loadingMine: Boolean(this.loadingMine),
      loadingReviews: Boolean(this.loadingReviews),
      loadingTrunk: Boolean(this.loadingTrunk),
      mineError: this.mineError ?? null,
      reviewsError: this.reviewsError ?? null,
      mineFailures: this.mineFailures ?? 0,
      reviewsFailures: this.reviewsFailures ?? 0,
    };
    const text = JSON.stringify(status);
    if (text === this.publishedStatus) return;
    this.publishedStatus = text;
    setShared("prs.status", status);
  }

  pullShared() {
    this.mine = shared("prs.cache.mine") ?? this.mine;
    this.reviews = shared("prs.cache.reviews") ?? this.reviews;
    this.trunk = shared("prs.cache.trunk") ?? this.trunk;
    Object.assign(this, shared("prs.status") ?? {});
    const request = shared("prs.page.request");
    if (request && request.at !== this.seenPageRequest) {
      this.seenPageRequest = request.at;
      this.page = request.page;
      localStorage.setItem("page", request.page);
    }
  }

  act(name, pr) {
    choose(name, pr);
  }

  menu(pr, scope) {
    openMenu(pr, scope === "reviews" ? "reviews" : "mine");
  }

  isBusy(pr) {
    return isBusy(pr);
  }

  hover(id, on, cx) {
    if (on) this.hovered = id;
    else if (this.hovered === id) this.hovered = null;
    cx.notify();
  }

  toggleDrafts(cx) {
    this.hideDrafts = !this.hideDrafts;
    localStorage.setItem("hideDrafts", String(this.hideDrafts));
    cx.notify();
  }

  withDraftsApplied(prs) {
    return this.hideDrafts ? withoutDraftStacks(prs) : prs;
  }

  hiddenDrafts() {
    const all = this.mine?.prs ?? [];
    return all.length - this.withDraftsApplied(all).length;
  }

  placeholder(t, error, text) {
    return empty(t, error ? error : text);
  }

  toggleFold(id, cx) {
    if (this.folded.has(id)) this.folded.delete(id);
    else this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  setSidebarTab(id, cx) {
    this.sidebarTab = id;
    localStorage.setItem("sidebarTab", id);
    cx.notify();
  }

  repoIndex(repo) {
    const exact = repos().indexOf(repo);
    if (exact !== -1) return exact;
    const org = repos().indexOf(`${ownerOf(repo)}/*`);
    return org === -1 ? 999 : org + 0.5;
  }

  knownRepos() {
    const seen = [...(this.mine?.prs ?? []), ...(this.reviews ?? [])].map((pr) => pr.repo);
    return [...new Set([...repos().filter((repo) => !isOrgWide(repo)), ...seen])].sort((a, b) => this.repoIndex(a) - this.repoIndex(b) || a.localeCompare(b));
  }

  get failures() {
    return Math.max(this.mineFailures ?? 0, this.reviewsFailures ?? 0);
  }

  loading() {
    return Boolean(this.loadingMine || this.loadingReviews || this.loadingTrunk);
  }

  openPage(page) {
    setShared("prs.page.request", { page: page ?? (this.sidebarTab === "queue" ? "queue" : this.sidebarTab), at: Date.now() });
    if (hasPage()) showView(PAGE_NODE);
    else openOverlay(PAGE_DIALOG);
  }

  refreshAll(cx) {
    if (!this.leader) {
      setShared("prs.refreshAll", Date.now());
      return;
    }
    this.loadMine(cx);
    this.loadReviews(cx);
  }

  loadReviews(cx) {
    if (this.loadingReviews) return;
    this.loadingReviews = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await loadConfig();
        this.reviews = await fetchReviews(repos());
        this.reviewsFailures = 0;
        this.reviewsError = null;
        setShared("prs.cache.reviews", this.reviews);
      } catch (error) {
        this.reviewsFailures++;
        if (!this.reviews || this.reviewsFailures >= FAILURES_BEFORE_ERROR) this.reviewsError = String(error?.message ?? error);
      }
      this.loadingReviews = false;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    switch (this.mode) {
      case "menu":
        return this.renderMenu(t);
      case "confirm":
        return this.renderConfirm(t);
      case "sheet":
        return this.renderSheet(t);
      case "filter":
        return this.renderFilterEditor(t);
      case "workflow":
        return this.renderWorkflowEditor(t);
      case "addPr":
        return this.renderAddPr(t);
      case "pick":
        return this.renderPick(t);
      default:
        return this.renderPanel(t);
    }
  }

  escapable(id, el) {
    return el.id(id).track_focus(this.handle).on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      closeOverlay(props().overlay);
      cx.stop_propagation();
    });
  }

  renderMenu(t) {
    const p = props();
    return this.escapable("prs-menu", v_flex())
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.5)
      .child(div().px(8).pt(3).pb(5).text_size(11).text_color(t.dim).truncate().child(`#${p.pr.number} ${p.pr.title}`))
      .children(menuEntries(p.pr, p.scope).map(([name, label]) => menuItem(t, `prs-menu-${name}`, label, () => {
        closeOverlay(p.overlay);
        choose(name, p.pr);
      })));
  }

  renderPick(t) {
    const p = props();
    return this.escapable("prs-pick", v_flex())
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.5)
      .children(p.options.map((option, index) => menuItem(t, `prs-pick-${index}`, option.label, () => {
        closeOverlay(p.overlay);
        setShared(p.key, { value: option.value, at: Date.now() });
      }, option.value === p.current ? "✓" : null)));
  }

  renderConfirm(t) {
    const p = props();
    const copy = CONFIRM[p.name](p.pr);
    const yes = () => {
      closeOverlay(p.overlay);
      NAMED[p.name](p.pr);
    };
    return v_flex()
      .id("prs-confirm")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") yes();
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.stop_propagation();
      })
      .size_full()
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(copy.title))
      .child(div().flex_1().text_color(t.muted).child(copy.detail))
      .child(h_flex().justify_end().gap(8).child(button(t, "prs-no", "Cancel", () => closeOverlay(p.overlay))).child(button(t, "prs-yes", copy.label, yes, { primary: true })));
  }

  pick(key, options, current) {
    openOverlay({ mod: "prs", kind: "popup", width: 260, height: 16 + options.length * 28, props: { mode: "pick", key, options, current } });
  }

  consumePick(key, apply) {
    const picked = shared(key);
    if (picked && picked.at !== this[`seen-${key}`]) {
      this[`seen-${key}`] = picked.at;
      apply(picked.value);
    }
  }

  counts() {
    return {
      mine: this.mine ? this.mine.prs.length - this.hiddenDrafts() : undefined,
      reviews: this.reviews?.filter((pr) => !this.isHidden(pr)).length,
      code: Object.values(store().runs).filter((run) => run.kind === "review" && run.status === "running").length || null,
      tasks: Object.values(store().runs).filter((run) => run.status === "running").length || null,
      queue: this.trunk?.listing ? this.trunk.listing.items.filter((item) => item.state !== "Merged" && (this.mine?.prs ?? []).some((pr) => isTrunkPr(pr) && pr.number === item.number)).length || null : null,
    };
  }

  setPage(id, cx) {
    this.page = id;
    localStorage.setItem("page", id);
    cx.notify();
  }

  renderPanel(t) {
    if (!this.leader) this.pullShared();
    this.consumePick("prs.pick.repo", (value) => (this.repoFilter = value));
    this.consumePick("prs.pick.via", (value) => (this.viaFilter = value));
    const sized = (el) => el.on_size_change((size, cx) => {
      if (Math.abs(size.width - this.width) < 1) return;
      this.width = size.width;
      cx.notify();
    });
    if (props()?.page || this.width >= 900) return sized(this.renderWide(t));
    const counts = this.counts();
    if (this.width > 0 && this.width < 160) return sized(v_flex().id("prs-root")).size_full().bg(t.chrome).child(sidebarRail(this, t, counts));
    const body = this.sidebarTab === "queue" ? sidebarQueue(this, t) : this.sidebarTab === "reviews" ? sidebarReviews(this, t) : sidebarMine(this, t);
    const error = this.sidebarTab === "mine" ? (this.mine && this.mineError) : this.sidebarTab === "reviews" ? (this.reviews && this.reviewsError) : null;
    return sized(v_flex())
      .id("prs-root")
      .size_full()
      .bg(t.chrome)
      .text_color(t.foreground)
      .child(sidebarHeader(this, t, counts))
      .when(Boolean(error), (el) => el.child(div().px(10).pb(4).text_size(10.5).text_color(tone(t, "warn")).truncate().child(error)))
      .child(v_flex().id("prs-sb-list").flex_1().min_h(0).px(4).pb(8).overflow_y_scrollbar().children(body));
  }

  renderWide(t) {
    const counts = this.counts();
    const loading = this.loadingMine || this.loadingReviews;
    const title = { mine: "My PRs", reviews: "Review requests", queue: "Merge queue", code: "Code review", tasks: "Tasks", workflows: "Workflows", settings: "Settings" }[this.page];
    const nav = v_flex()
      .w(230)
      .flex_none()
      .h_full()
      .bg(t.chrome)
      .border_r_1()
      .border_color(t.border)
      .p(10)
      .gap(2)
      .child(div().px(8).pt(6).pb(12).text_size(14).font_semibold().child("Pull requests"))
      .children(PAGES.map((page) => h_flex()
        .id(`prs-nav-${page.id}`)
        .h(34)
        .px(10)
        .rounded(8)
        .items_center()
        .cursor_pointer()
        .when(this.page === page.id, (el) => el.bg(t.selected))
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => this.setPage(page.id, cx))
        .child(div().flex_1().text_size(13).child(page.id === "reviews" ? "Review requests" : page.id === "queue" ? "Merge queue" : page.label))
        .when(Boolean(counts[page.id]), (el) => el.child(div().px(7).rounded(9).bg(t.raised).text_size(11).text_color(t.muted).child(String(counts[page.id]))))))
      .child(div().flex_1())
      .child(h_flex()
        .id("prs-back")
        .h(34)
        .px(10)
        .gap(8)
        .rounded(8)
        .items_center()
        .text_color(t.muted)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_click(() => leavePage())
        .child(svg("mods/prs/icons/terminal.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().text_size(13).child(props()?.overlay ? "Close" : "Back to terminals"))
        .when(!props()?.overlay, (el) => el.child(div().text_size(11).text_color(t.dim).child("⌘⇧G"))));
    const columns = this.page === "mine" || this.page === "reviews"
      ? h_flex()
          .px(16)
          .py(8)
          .gap(12)
          .border_b_1()
          .border_color(t.border)
          .text_size(10.5)
          .font_semibold()
          .text_color(t.dim)
          .child(div().flex_1().child("TITLE"))
          .child(div().w(300).child(this.page === "mine" ? "STATUS" : "REQUESTED"))
          .child(div().w(80).child("UPDATED"))
          .child(div().w(QUICK_ACTIONS_WIDTH))
      : null;
    const body = this.page === "mine" ? this.wideMineRows(t) : this.page === "reviews" ? this.wideReviewRows(t) : this.pageBody(t);
    return h_flex()
      .id("prs-root")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .when(Boolean(props()?.page), (el) => el
        .track_focus(this.handle)
        .on_mouse_down("left", () => this.handle.focus())
        .on_key_down((e, cx) => {
          if (e.keystroke !== "cmd-shift-g") return;
          toggleView();
          cx.stop_propagation();
        }))
      .child(nav)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .child(
            h_flex()
              .px(18)
              .pt(14)
              .pb(8)
              .gap(8)
              .items_center()
              .child(div().flex_1().text_size(18).font_semibold().child(title))
              .when(loading, (el) => el.child(svg(SPINNER).size(13).spin(900).text_color(t.dim)))
              .when(this.page === "mine", (el) => el.child(textIconButton(t, "prs-addpr", "plus", "Add PR", () => openOverlay({ mod: "prs", kind: "dialog", width: 440, height: 200, props: { mode: "addPr" } }))))
              .when(["mine", "reviews"].includes(this.page), (el) => el.child(textIconButton(t, "prs-copylist", "copy", "Copy list", () => copyText(this.visibleList().map((pr) => `- ${markdownLink(pr)}`).join("\n"), "Copied the filtered PRs as a list."))))
              .child(iconButton(t, "prs-wide-refresh", "refresh", "Refresh", (_e, cx) => this.refreshAll(cx))),
          )
          .child(div().px(10).child(this.toolbar(t)))
          .when(Boolean(columns), (el) => el.child(columns))
          .child(v_flex().id("prs-wide-list").flex_1().min_h(0).px(6).pb(16).overflow_y_scrollbar().children(body)),
      );
  }

  quickActions(t, pr, scope) {
    const entries = [
      ...(scope === "reviews" ? [["reviewInClaude", "terminal", "Review in Claude"]] : []),
      ["agentReview", "bot", "Agent review (headless)"],
      ["copyLink", "copy", "Copy as Markdown link"],
      ["open", "external", "Open on GitHub"],
    ];
    return h_flex()
      .w(QUICK_ACTIONS_WIDTH)
      .flex_none()
      .gap(2)
      .justify_end()
      .child(glyphButton(t, `prs-q-${scope}-${pr.number}-claude`, image(CLAUDE_ICON).size(14), "Claude Code on this PR", () => choose("claude", pr)))
      .children(entries.map(([name, iconName, label]) => iconButton(t, `prs-q-${scope}-${pr.number}-${name}`, iconName, label, () => choose(name, pr))));
  }

  wideRow(t, id, pr, scope, depth, left, middle, right) {
    return h_flex()
      .id(id)
      .pl(16 + depth * 16)
      .pr(16)
      .py(9)
      .gap(12)
      .items_center()
      .border_b_1()
      .border_color(t.border)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click(() => NAMED.details(pr))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openMenu(pr, scope);
      })
      .child(v_flex().flex_1().min_w(0).gap(4).children(left))
      .child(middle)
      .child(div().w(80).flex_none().text_size(12).text_color(t.dim).child(right))
      .child(this.quickActions(t, pr, scope));
  }

  wideMineRows(t) {
    if (!this.mine) return [empty(t, this.mineError ? `GitHub: ${this.mineError}` : "Loading your PRs…")];
    const prs = this.mineVisible().map((row) => row.pr);
    if (!prs.length) return [empty(t, "No PRs match.")];
    const rows = [];
    for (const group of stackGroups(prs, this.sortNewest)) {
      const members = group.members.length > 1 ? [...group.members].reverse() : group.members;
      if (group.members.length > 1) rows.push(div().px(8).pt(6).child(stackHeader(this, t, group)));
      for (const member of members) {
        const pr = member.pr;
        const progress = progressLine(this, t, pr, group);
        rows.push(this.wideRow(t, `prs-wm-${pr.repo}-${pr.number}`, pr, "mine", group.members.length > 1 ? 1 : 0,
          [
            h_flex().gap(6).items_center().child(prIcon(this, t, pr, { group })).child(div().flex_1().min_w(0).child(this.titleLine(t, pr))),
            div().pl(19).min_w(0).truncate().text_size(TEXT.meta).text_color(t.dim).child(`${pr.repo}#${pr.number} · @${pr.author} · opened ${ago(pr.createdAt)}`),
          ],
          v_flex().w(300).flex_none().gap(4).child(statusLine(this, t, pr, { group })).when(Boolean(progress), (el) => el.child(progress)),
          ago(pr.updatedAt),
        ));
      }
    }
    return rows;
  }

  wideReviewRows(t) {
    if (!this.reviews) return [empty(t, this.reviewsError ? `GitHub: ${this.reviewsError}` : "Loading review requests…")];
    const { visible, hidden } = this.reviewsVisible();
    const row = (pr) => {
      const via = pr.via.direct ? "you" : pr.via.teams[0] ? `@${pr.via.teams[0]}` : "";
      return this.wideRow(t, `prs-wr-${pr.repo}-${pr.number}`, pr, "reviews", 0,
        [
          h_flex().gap(6).items_center().child(prIcon(this, t, pr, { scope: "reviews" })).child(div().flex_1().min_w(0).child(this.titleLine(t, pr))),
          div().pl(19).truncate().text_size(TEXT.meta).text_color(t.dim).child(`${pr.repo}#${pr.number}${via ? ` · via ${via}` : ""}`),
        ],
        div().w(300).flex_none().child(statusLine(this, t, pr, { scope: "reviews", buttons: false })),
        ago(pr.updatedAt),
      );
    };
    const rows = visible.length ? visible.map(row) : [empty(t, "No PRs waiting on your review.")];
    if (hidden.length) {
      rows.push(
        h_flex()
          .id("prs-wide-hidden")
          .px(16)
          .py(10)
          .text_size(12)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.showHidden = !this.showHidden;
            cx.notify();
          })
          .child(`${this.showHidden ? "Hide" : "Show"} ${hidden.length} hidden pull request${hidden.length === 1 ? "" : "s"}`),
      );
      if (this.showHidden) rows.push(...hidden.map(row));
    }
    return rows;
  }

  toolbar(t) {
    if (!["mine", "reviews"].includes(this.page)) return div();
    const scope = this.page;
    const repoLabel = this.repoFilter ? this.repoFilter.split("/")[1] : "All repos";
    const filters = store().filters.filter((filter) => (filter.scope ?? "mine") === scope);
    const search = h_flex()
      .w(320)
      .h(28)
      .flex_none()
      .pl(8)
      .gap(2)
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(t.input)
      .bg(t.background)
      .child(svg("mods/prs/icons/search.svg").size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).child(Input.new(this.search).h(26).px(4).bg(t.background).text_size(12).text_color(t.foreground)));
    return h_flex()
      .px(8)
      .pt(8)
      .pb(4)
      .gap(12)
      .items_start()
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .flex_wrap()
          .child(chip(t, "prs-repo", `${repoLabel} ▾`, Boolean(this.repoFilter), () => this.pick("prs.pick.repo", [{ label: "All repos", value: null }, ...this.knownRepos().map((repo) => ({ label: repo, value: repo }))], this.repoFilter)))
          .when(scope === "mine", (el) => el.children(MINE_CHIPS.map((item) => chip(t, `prs-chip-${item.id}`, item.label, this.chips.has(item.id), (_e, cx) => {
            if (this.chips.has(item.id)) this.chips.delete(item.id);
            else this.chips.add(item.id);
            cx.notify();
          }, this.mine ? this.mine.prs.filter(item.test).length || null : null))))
          .when(scope === "mine", (el) => el.child(chip(t, "prs-drafts", "Hide drafts", this.hideDrafts, (_e, cx) => this.toggleDrafts(cx), this.hideDrafts ? this.hiddenDrafts() || null : null)))
          .when(scope === "mine", (el) => el.child(chip(t, "prs-sort", this.sortNewest ? "↓ Newest" : "↑ Oldest", false, (_e, cx) => {
            this.sortNewest = !this.sortNewest;
            localStorage.setItem("sort", this.sortNewest ? "newest" : "oldest");
            cx.notify();
          })))
          .when(scope === "reviews", (el) => el
            .child(chip(t, "prs-via", `${this.viaLabel()} ▾`, Boolean(this.viaFilter), () => this.pick("prs.pick.via", this.viaOptions(), this.viaFilter)))
            .child(chip(t, "prs-rsort", REVIEW_SORTS[this.reviewSort].label, this.reviewSort === "priority", (_e, cx) => {
              this.reviewSort = REVIEW_SORTS[this.reviewSort].next;
              localStorage.setItem("reviewSort", this.reviewSort);
              cx.notify();
            })))
          .children(filters.map((filter) => chip(t, `prs-filter-${filter.id}`, filter.name, this.savedFilter === filter.id, (_e, cx) => {
            this.savedFilter = this.savedFilter === filter.id ? null : filter.id;
            cx.notify();
          })))
          .child(chip(t, "prs-newfilter", "+ Filter", false, () => openOverlay({ mod: "prs", kind: "dialog", width: 460, height: 640, props: { mode: "filter", scope, repos: this.knownRepos() } })))
      )
      .child(search);
  }

  viaOptions() {
    const teams = [...new Set((this.reviews ?? []).flatMap((pr) => pr.via.teams))].sort();
    return [{ label: "Any requested", value: null }, { label: `Directly (@${this.mine?.viewer ?? "me"})`, value: "direct" }, ...teams.map((team) => ({ label: `@${team}`, value: team }))];
  }

  viaLabel() {
    if (!this.viaFilter) return "Any requested";
    return this.viaFilter === "direct" ? "Directly" : `@${this.viaFilter.split("/")[1] ?? this.viaFilter}`;
  }

  isHidden(pr) {
    return store().hiddenReviews.some((item) => item.key === prKey(pr.repo, pr.number));
  }

  applyCommon(list) {
    const query = (this.search?.value() ?? "").trim().toLowerCase().replace(/^#/, "");
    const saved = store().filters.find((filter) => filter.id === this.savedFilter);
    return list.filter((pr) => {
      if (this.repoFilter && pr.repo !== this.repoFilter) return false;
      if (saved && !filterMatches(saved, pr)) return false;
      if (query && !`${pr.title} ${pr.repo} ${pr.number} ${pr.author}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }

  visibleList() {
    if (this.page === "reviews") return this.reviewsVisible().visible;
    return this.mineVisible().map((row) => row.pr);
  }

  mineVisible() {
    const prs = this.applyCommon(this.withDraftsApplied(this.mine?.prs ?? [])).filter((pr) => MINE_CHIPS.every((item) => !this.chips.has(item.id) || item.test(pr)));
    return orderWithStacks(prs, this.sortNewest);
  }

  reviewsVisible() {
    const all = (this.reviews ?? []).map((pr) => ({ ...pr, hidden: this.isHidden(pr) }));
    const filtered = this.applyCommon(all).filter((pr) => !this.viaFilter || (this.viaFilter === "direct" ? pr.via.direct : pr.via.teams.includes(this.viaFilter)));
    const sorter = REVIEW_SORTS[this.reviewSort].compare;
    return { visible: filtered.filter((pr) => !pr.hidden).sort(sorter), hidden: filtered.filter((pr) => pr.hidden) };
  }

  pageBody(t) {
    switch (this.page) {
      case "reviews":
        return this.wideReviewRows(t);
      case "queue":
        return this.queueRows(t);
      case "code":
        return this.codeRows(t);
      case "tasks":
        return this.taskRows(t);
      case "workflows":
        return this.workflowRows(t);
      case "settings":
        return this.settingsRows(t);
      default:
        return this.wideMineRows(t);
    }
  }

  rowShell(t, id, pr, scope, depth, children) {
    return v_flex()
      .id(id)
      .pl(8 + depth * 14)
      .pr(8)
      .py(7)
      .gap(4)
      .rounded(8)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click(() => NAMED.details(pr))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openMenu(pr, scope);
      })
      .children(children);
  }

  titleLine(t, pr) {
    return h_flex()
      .gap(6)
      .items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.title).child(pr.title))
      .when(isBusy(pr), (el) => el.child(svg(SPINNER).size(11).spin(900).text_color(t.dim)));
  }

  queueRows(t) {
    const rows = sidebarQueue(this, t);
    const ready = (this.mine?.prs ?? []).filter((pr) => !pr.queue?.active && !(isTrunkPr(pr) && this.trunk?.items?.[pr.number]) && readyToMerge(pr) && pr.mine);
    if (ready.length) {
      rows.push(section(t, "Ready to merge"));
      for (const pr of ready) {
        rows.push(this.rowShell(t, `prs-ready-${pr.repo}-${pr.number}`, pr, "mine", 0, [
          this.titleLine(t, pr),
          h_flex()
            .gap(6)
            .items_center()
            .child(statusLine(this, t, pr, { buttons: false }))
            .child(div().flex_1())
            .child(iconButton(t, `prs-merge-${pr.number}`, "merged", isTrunkPr(pr) || usesTrunk(pr) ? "Send to queue…" : "Merge…", () => choose("merge", pr), "ok")),
        ]));
      }
    }
    return rows;
  }

  findPr(repo, number, title) {
    return [...(this.mine?.prs ?? []), ...(this.reviews ?? [])].find((pr) => pr.repo === repo && pr.number === number) ?? { repo, number, title: title ?? `${repo}#${number}`, url: `https://github.com/${repo}/pull/${number}`, author: "?", labels: [], checks: { total: 0, passed: 0, failed: 0, inProgress: 0 }, threads: { total: 0 } };
  }

  runBadge(t, run) {
    if (run.status === "running") return badge(t, "RUNNING", "run");
    if (run.status === "failed") return badge(t, "FAILED", "bad");
    if (run.status === "done") return badge(t, "DONE", "ok");
    return badge(t, "INTERACTIVE", "merged");
  }

  codeRows(t) {
    const runs = Object.values(store().runs).filter((run) => run.kind === "review" && !run.interactive).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    if (!runs.length) return [empty(t, "No agent reviews yet. Right-click a PR and pick Agent review.")];
    return runs.map((run) => {
      const findings = store().findings[prKey(run.repo, run.number)] ?? [];
      const mineFindings = findings.filter((finding) => finding.runId === run.id);
      const open = mineFindings.filter((finding) => finding.state === "open").length;
      const dismissed = mineFindings.filter((finding) => finding.state === "dismissed").length;
      const pr = this.findPr(run.repo, run.number);
      return v_flex()
        .id(`prs-code-${run.id}`)
        .px(8)
        .py(7)
        .gap(4)
        .rounded(8)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_click(() => openOverlay({ mod: "prs", kind: "dialog", width: 760, height: 700, props: { mode: "sheet", pr, tab: "findings" } }))
        .child(h_flex().gap(6).items_center().child(this.runBadge(t, run)).child(div().flex_1().min_w(0).truncate().child(run.title)))
        .child(div().truncate().text_size(11).text_color(t.dim).child(`${run.repo}#${run.number} · started ${ago(run.startedAt)}${run.status === "done" ? ` · ${open} open${dismissed ? `, ${dismissed} dismissed` : ""}` : ""}${run.summary && run.status === "failed" ? ` · ${run.summary}` : ""}`));
    });
  }

  taskRows(t) {
    const runs = Object.values(store().runs).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 40);
    if (!runs.length) return [empty(t, "No agent tasks yet.")];
    const allTabs = spaces().flatMap((space) => space.tabs.map((tab) => ({ ...tab, space: space.id, machine: space.machine ?? null })));
    return runs.map((task) => {
      const tab = task.interactive ? allTabs.find((candidate) => candidate.name === task.tabName && candidate.machine === (task.machine ?? null)) : null;
      const status = task.interactive ? (tab ? tab.status ?? "idle" : "closed") : task.status;
      const label = { review: "Agent review", fix: "Fix session", "claude-review": "Review session" }[task.kind] ?? task.kind;
      return v_flex()
        .id(`prs-task-${task.id}`)
        .px(8)
        .py(7)
        .gap(4)
        .rounded(8)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          if (tab) run("tab.select", { id: tab.id });
          else if (task.terminal && task.status === "running") run("terminal.peek", { terminal: task.terminal });
          else NAMED.details(this.findPr(task.repo, task.number));
        })
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(badge(t, status.toUpperCase(), { running: "run", working: "run", blocked: "warn", done: "ok", failed: "bad", closed: "dim", idle: "muted" }[status] ?? "muted"))
            .child(div().flex_1().min_w(0).truncate().child(`${label} · #${task.number}`))
            .child(div().text_size(11).text_color(t.dim).child(ago(task.startedAt))),
        )
        .child(div().truncate().text_size(11).text_color(t.dim).child(task.summary || task.title));
    });
  }

  initSettingsForm() {
    const c = config();
    const form = {
      repoInput: InputState.new({ placeholder: "owner/repo, or owner/* for every repo there" }),
      trunkRepo: InputState.new({ placeholder: "owner/repo, empty turns Trunk off", value: c.trunk?.repo ?? "" }),
      review: InputState.new({ placeholder: "Model for the lenses", value: c.models?.review ?? "" }),
      judge: InputState.new({ placeholder: "Model for the judge", value: c.models?.judge ?? "" }),
      checkouts: {},
      draft: JSON.parse(JSON.stringify(c)),
      detected: {},
    };
    for (const repo of form.draft.repos) form.checkouts[repo] = InputState.new({ placeholder: "Found automatically", value: c.checkouts?.[repo] ?? "" });
    form.repoInput.on("submit", () => this.addRepo());
    this.settingsForm = form;
  }

  addRepo() {
    const form = this.settingsForm;
    const repo = form.repoInput.value().trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/([\w.-]+|\*)$/.test(repo) || form.draft.repos.includes(repo)) return;
    form.draft.repos.push(repo);
    form.checkouts[repo] = InputState.new({ placeholder: "Found automatically" });
    form.repoInput.set_value?.("");
    setShared("prs.settings.edit", Date.now());
  }

  saveSettings() {
    const form = this.settingsForm;
    const draft = form.draft;
    draft.trunk = { ...draft.trunk, repo: form.trunkRepo.value().trim() || null };
    draft.models = { review: form.review.value().trim() || "claude-sonnet-5-5", judge: form.judge.value().trim() || "claude-opus-5-5" };
    draft.checkouts = {};
    for (const repo of draft.repos) {
      const value = form.checkouts[repo]?.value().trim();
      if (value) draft.checkouts[repo] = value;
    }
    return report("Settings", async () => {
      await updateConfig((next) => Object.assign(next, draft));
      return { ok: true, message: `Saved to ${configPath()}.` };
    });
  }

  machinePicker(t, id, current, onPick) {
    const names = machines().map((entry) => entry.name).filter(Boolean);
    const options = [null, ...names];
    return h_flex().gap(4).flex_wrap().children(options.map((name) => chip(t, `${id}-${name ?? "local"}`, machineLabel(name), (current ?? null) === name, (_e, cx) => {
      onPick(name);
      cx.notify();
    })));
  }

  settingsRows(t) {
    if (!this.settingsForm) return [empty(t, "Loading settings…")];
    this.consumePick("prs.settings.edit", () => {});
    const form = this.settingsForm;
    const draft = form.draft;
    const card = (title, hint, body) => v_flex().mx(8).mt(10).p(14).gap(8).rounded(10).border_1().border_color(t.border).bg(t.surface).child(div().text_size(13).font_semibold().child(title)).when(Boolean(hint), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(hint))).child(body);
    const detect = (repo) => (_e, cx) => cx.spawn(async (cx) => {
      try {
        forgetCheckouts();
        form.detected[repo] = await checkoutFor(repo, draft.runner?.machine ?? null);
      } catch (error) {
        form.detected[repo] = String(error?.message ?? error);
      }
      cx.notify();
    });
    return [
      card("Repositories", "Pull requests from these repos show in every view. owner/* covers every repo of that owner. The first one comes first in the sidebar.",
        v_flex()
          .gap(6)
          .children(draft.repos.map((repo, index) =>
            h_flex()
              .id(`prs-set-repo-${repo}`)
              .gap(8)
              .items_center()
              .child(div().flex_1().child(repo))
              .when(index > 0, (el) => el.child(button(t, `prs-set-up-${repo}`, "↑", (_e, cx) => {
                draft.repos.splice(index - 1, 0, draft.repos.splice(index, 1)[0]);
                cx.notify();
              }, { small: true })))
              .child(button(t, `prs-set-rm-${repo}`, "Remove", (_e, cx) => {
                draft.repos = draft.repos.filter((item) => item !== repo);
                cx.notify();
              }, { small: true, danger: true })),
          ))
          .child(h_flex().gap(6).child(div().flex_1().child(this.input(t, form.repoInput))).child(button(t, "prs-set-add", "Add", (_e, cx) => {
            this.addRepo();
            cx.notify();
          })))),
      card("Agents run on", "Where Fix sessions, agent reviews and workflow agents run. Pick this computer or any machine you added to Herdr.",
        this.machinePicker(t, "prs-set-runner", draft.runner?.machine, (name) => (draft.runner = { ...draft.runner, machine: name }))),
      card("Checkouts", `Where each repo is checked out on ${machineLabel(draft.runner?.machine ?? null)}. Leave empty to find it from your open spaces and common folders, else it's cloned to ~/.herdr-prs/repos the first time it's needed.`,
        v_flex().gap(6).children(draft.repos.filter((repo) => !isOrgWide(repo)).map((repo) =>
          v_flex()
            .gap(3)
            .child(h_flex().gap(6).items_center().child(div().w(170).flex_none().truncate().text_size(12).child(repo)).child(div().flex_1().child(this.input(t, form.checkouts[repo]))).child(button(t, `prs-set-detect-${repo}`, "Detect", detect(repo), { small: true })))
            .when(Boolean(form.detected[repo]), (el) => el.child(div().pl(176).text_size(11).text_color(t.dim).child(`Found: ${form.detected[repo]}`))),
        ))),
      card("Trunk merge queue", "The repo whose merge queue is Trunk's, and the machine whose Trunk CLI is logged in (`trunk login`). It needs a checkout of that repo there.",
        v_flex().gap(8).child(this.input(t, form.trunkRepo)).child(this.machinePicker(t, "prs-set-trunk", draft.trunk?.machine, (name) => (draft.trunk = { ...draft.trunk, machine: name }))).when(Boolean(this.trunk?.error), (el) => el.child(div().text_size(11.5).text_color(tone(t, "warn")).child(`Last check: ${this.trunk.error}`)))),
      card("Agent models", "Agent reviews run four lenses on the first model, then a judge on the second.",
        v_flex().gap(6).child(this.input(t, form.review)).child(this.input(t, form.judge))),
      card("Notifications", "Approved, changes requested, checks failing, visual changes to approve, merged, queue failed, and new direct review requests.",
        h_flex().gap(4).child(chip(t, "prs-set-notify-on", "On", draft.notifications !== false, (_e, cx) => {
          draft.notifications = true;
          cx.notify();
        })).child(chip(t, "prs-set-notify-off", "Off", draft.notifications === false, (_e, cx) => {
          draft.notifications = false;
          cx.notify();
        }))),
      h_flex()
        .mx(8)
        .mt(12)
        .gap(8)
        .items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(configPath()))
        .child(button(t, "prs-set-reset", "Discard changes", (_e, cx) => {
          this.initSettingsForm();
          cx.notify();
        }))
        .child(button(t, "prs-set-save", "Save", () => this.saveSettings(), { primary: true })),
    ];
  }

  workflowRows(t) {
    const workflows = store().workflows;
    const rows = [
      h_flex()
        .px(8)
        .pt(8)
        .gap(6)
        .items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Runs on your PRs and review requests while Herdr is open, checked on every refresh. At most 5 runs per PR per hour."))
        .child(button(t, "prs-wf-new", "New workflow", () => openOverlay({ mod: "prs", kind: "dialog", width: 560, height: 720, props: { mode: "workflow", repos: this.knownRepos() } }), { small: true, primary: true })),
    ];
    if (!workflows.length) rows.push(empty(t, "No workflows yet."));
    for (const workflow of workflows) {
      const enabled = workflow.enabled !== false;
      rows.push(
        v_flex()
          .id(`prs-wf-${workflow.id}`)
          .px(8)
          .py(7)
          .gap(4)
          .rounded(8)
          .hover((el) => el.bg(t.hover))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(badge(t, enabled ? "ON" : "OFF", enabled ? "ok" : "dim"))
              .child(div().flex_1().min_w(0).truncate().child(workflow.name))
              .child(button(t, `prs-wf-edit-${workflow.id}`, "Edit", () => openOverlay({ mod: "prs", kind: "dialog", width: 560, height: 720, props: { mode: "workflow", id: workflow.id, repos: this.knownRepos() } }), { small: true }))
              .child(button(t, `prs-wf-toggle-${workflow.id}`, enabled ? "Turn off" : "Turn on", () => updateStore((state) => {
                const target = state.workflows.find((item) => item.id === workflow.id);
                if (target) target.enabled = !enabled;
              }), { small: true })),
          )
          .child(div().truncate().text_size(11).text_color(t.dim).child(`When ${workflow.triggers.map((id) => TRIGGERS.find((trigger) => trigger.id === id)?.label ?? id).join(" or ")} → ${workflow.actions.map((action) => ACTION_KINDS.find((kind) => kind.id === action.kind)?.label ?? action.kind).join(", ")}`)),
      );
    }
    const log = (store().workflowLog ?? []).slice(0, 15);
    if (log.length) {
      rows.push(section(t, "Recent runs"));
      for (const [index, entry] of log.entries()) {
        rows.push(div().id(`prs-wflog-${index}`).px(8).py(3).truncate().text_size(11).text_color(t.dim).child(`${ago(entry.at)} · ${entry.name} · ${entry.pr} · ${entry.event} · ${entry.results.join("; ") || "no actions"}`));
      }
    }
    return rows;
  }

  initSheet(p, cx) {
    this.tab = p.tab ?? "overview";
    this.detail = null;
    this.detailError = null;
    this.loadDetail(cx);
  }

  loadDetail(cx) {
    this.loadingDetail = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.detail = await fetchDetail(props().pr);
        this.detailError = null;
      } catch (error) {
        this.detailError = String(error?.message ?? error);
      }
      this.loadingDetail = false;
      cx.notify();
    });
  }

  renderSheet(t) {
    const p = props();
    const pr = { ...p.pr, watching: store().watched.includes(prKey(p.pr.repo, p.pr.number)) };
    const tabs = ["overview", "findings", "checks", "reviews", "files"];
    const findings = store().findings[prKey(pr.repo, pr.number)] ?? [];
    return this.escapable("prs-sheet", v_flex())
      .size_full()
      .bg(t.popover)
      .text_size(12.5)
      .text_color(t.foreground)
      .child(
        v_flex()
          .px(18)
          .pt(16)
          .pb(10)
          .gap(4)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().flex_1().min_w(0).text_size(15).font_semibold().truncate().child(pr.title))
              .when(this.loadingDetail, (el) => el.child(svg(SPINNER).size(12).spin(900).text_color(t.dim)))
              .child(button(t, "prs-sheet-refresh", "Refresh", (_e, cx) => this.loadDetail(cx), { small: true }))
              .child(button(t, "prs-sheet-open", "Open", () => openUrl(pr.url), { small: true }))
              .child(button(t, "prs-sheet-close", "Close", () => closeOverlay(p.overlay), { small: true })),
          )
          .child(div().text_size(11.5).text_color(t.dim).child(`${pr.repo}#${pr.number} · @${pr.author} · ${pr.headRef ?? ""} → ${pr.baseRef ?? ""}`)),
      )
      .child(
        h_flex()
          .px(14)
          .gap(4)
          .children(tabs.map((tab) => chip(t, `prs-sheet-tab-${tab}`, tab[0].toUpperCase() + tab.slice(1), this.tab === tab, (_e, cx) => {
            this.tab = tab;
            cx.notify();
          }, tab === "findings" ? findings.filter((finding) => finding.state === "open").length || null : tab === "checks" ? pr.checks?.total || null : null))),
      )
      .child(div().mt(8).h(1).bg(t.border))
      .child(v_flex().id("prs-sheet-body").flex_1().min_h(0).p(16).gap(8).overflow_y_scrollbar().children(this.sheetBody(t, pr, findings)));
  }

  sheetBody(t, pr, findings) {
    if (this.detailError) return [empty(t, `GitHub: ${this.detailError}`)];
    if (this.tab === "findings") return this.findingsTab(t, pr, findings);
    if (!this.detail) return [empty(t, "Loading details…")];
    if (this.tab === "checks") return this.checksTab(t, pr);
    if (this.tab === "reviews") return this.reviewsTab(t, pr);
    if (this.tab === "files") return this.filesTab(t, pr);
    return this.overviewTab(t, pr);
  }

  overviewTab(t, pr) {
    const fact = (label, value) => h_flex().gap(8).child(div().w(110).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).child(value));
    const failing = this.detail.checks.filter((check) => check.bucket === "failed");
    const openThreads = this.detail.threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
    const actions = pr.mine
      ? [
          button(t, "prs-ov-fix", "Fix with Claude", () => NAMED.fix(pr), { primary: true }),
          button(t, "prs-ov-review", "Agent review", () => NAMED.agentReview(pr)),
          ...(pr.isDraft ? [button(t, "prs-ov-ready", "Ready for review", () => NAMED.markReady(pr))] : []),
          button(t, "prs-ov-merge", usesTrunk(pr) ? "Send to queue…" : "Merge…", () => choose("merge", pr)),
          button(t, "prs-ov-update", "Update branch", () => NAMED.updateBranch(pr)),
          button(t, "prs-ov-rerun", "Rerun failed", () => NAMED.rerunFailed(pr), { disabled: !failing.length }),
          button(t, "prs-ov-watch", pr.watching ? "Unwatch" : "Watch", () => NAMED.watch(pr)),
          button(t, "prs-ov-copy", "Copy link", () => NAMED.copyLink(pr)),
        ]
      : [
          button(t, "prs-ov-claude", "Review in Claude", () => NAMED.reviewInClaude(pr), { primary: true }),
          button(t, "prs-ov-review", "Agent review", () => NAMED.agentReview(pr)),
          button(t, "prs-ov-approve", "Approve…", () => choose("approve", pr)),
          button(t, "prs-ov-watch", pr.watching ? "Unwatch" : "Watch", () => NAMED.watch(pr)),
          button(t, "prs-ov-copy", "Copy link", () => NAMED.copyLink(pr)),
        ];
    return [
      h_flex().gap(6).flex_wrap().children(actions),
      v_flex()
        .pt(8)
        .gap(6)
        .child(fact("Status", statusLine(this, t, pr, { scope: pr.mine ? "mine" : "reviews", buttons: false })))
        .child(fact("Merge state", `${pr.mergeState ?? "?"} · ${pr.mergeable ?? "?"}`))
        .child(fact("Queue", pr.queue ? `${pr.queue.provider}: ${pr.queue.state.replace(/_/g, " ")}${pr.queue.position ? ` #${pr.queue.position}` : ""}` : "—"))
        .child(fact("Size", `+${pr.additions ?? 0} −${pr.deletions ?? 0} in ${pr.changedFiles ?? "?"} files`))
        .child(fact("Open threads", String(openThreads.length)))
        .child(fact("Labels", pr.labels?.join(", ") || "—")),
      ...(failing.length ? [section(t, `Failing checks (${failing.length})`), ...failing.slice(0, 12).map((check, index) => this.checkRow(t, check, index))] : []),
      section(t, "Description"),
      div().text_size(12).text_color(t.muted).child((this.detail.body || "No description.").slice(0, 3000)),
    ];
  }

  checkRow(t, check, index) {
    const color = { failed: tone(t, "bad"), running: tone(t, "run"), passed: tone(t, "ok") }[check.bucket];
    return h_flex()
      .id(`prs-check-${index}`)
      .gap(8)
      .py(2)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => check.url && openUrl(check.url))
      .child(div().w(7).h(7).rounded(4).flex_none().bg(color))
      .child(div().flex_1().min_w(0).truncate().child(check.name))
      .when(check.required, (el) => el.child(badge(t, "REQUIRED", "dim")));
  }

  checksTab(t, pr) {
    const checks = this.detail.checks;
    const count = (bucket) => checks.filter((check) => check.bucket === bucket).length;
    const tile = (label, value, colorName) => v_flex().flex_1().p(10).rounded(8).border_1().border_color(t.border).child(div().text_size(18).font_semibold().text_color(tone(t, colorName)).child(String(value))).child(div().text_size(11).text_color(t.dim).child(label));
    return [
      h_flex().gap(8).child(tile("Passed", count("passed"), "ok")).child(tile("Running", count("running"), "run")).child(tile("Failed", count("failed"), "bad")),
      h_flex().gap(6).child(button(t, "prs-checks-rerun", "Rerun failed", () => act(pr, "rerun", `Rerun failed checks on #${pr.number}`, () => rerunFailed(pr, this.detail)), { small: true, disabled: !count("failed") })),
      ...checks.filter((check) => check.bucket !== "passed").map((check, index) => this.checkRow(t, check, index)),
      section(t, `Passed (${count("passed")})`),
      ...checks.filter((check) => check.bucket === "passed").slice(0, 150).map((check, index) => this.checkRow(t, check, 1000 + index)),
    ];
  }

  reviewsTab(t, pr) {
    const threads = this.detail.threads;
    const reviewIds = new Set(this.detail.reviews.map((review) => review.id));
    const threadsOf = (reviewId) => threads.filter((thread) => thread.reviewId === reviewId).sort((a, b) => Number(a.isResolved) - Number(b.isResolved));
    const entries = [
      ...this.detail.reviews
        .map((review) => ({ at: review.submittedAt, review, threads: threadsOf(review.id) }))
        .filter(({ review, threads: own }) => review.state !== "COMMENTED" || cleanBody(review.body) || own.length),
      ...threads.filter((thread) => !reviewIds.has(thread.reviewId)).map((thread) => ({ at: thread.comments[0]?.createdAt, threads: [thread] })),
    ].sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
    const open = threads.filter((thread) => !thread.isResolved).length;
    if (!entries.length) return [empty(t, "No reviews or comments yet.")];
    return [
      section(t, `Conversation · ${open ? `${open} open` : "no open"} thread${open === 1 ? "" : "s"}`),
      ...entries.map((entry, index) => (entry.review ? this.reviewCard(t, pr, entry.review, entry.threads, index) : this.threadCard(t, pr, entry.threads[0], { standalone: true }))),
    ];
  }

  reviewCard(t, pr, review, threads, index) {
    const body = cleanBody(review.body);
    return v_flex()
      .id(`prs-rv-${index}`)
      .p(10)
      .gap(8)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().font_semibold().child(`@${review.author?.login ?? "ghost"}`))
          .child(badge(t, review.state.replace(/_/g, " "), review.state === "APPROVED" ? "ok" : review.state === "CHANGES_REQUESTED" ? "bad" : "dim"))
          .when(threads.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${threads.length} comment${threads.length === 1 ? "" : "s"}`)))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child(ago(review.submittedAt)))
          .when(Boolean(review.url), (el) => el.child(button(t, `prs-rv-open-${index}`, "Open", () => openUrl(review.url), { small: true }))),
      )
      .when(Boolean(body), (el) => el.child(div().text_size(12).text_color(t.muted).child(body.slice(0, 600))))
      .children(threads.map((thread) => this.threadCard(t, pr, thread)));
  }

  threadCard(t, pr, thread, { standalone = false } = {}) {
    this.toggledThreads ??= new Set();
    const expanded = thread.isResolved === this.toggledThreads.has(thread.id);
    const toggle = (_e, cx) => {
      if (this.toggledThreads.has(thread.id)) this.toggledThreads.delete(thread.id);
      else this.toggledThreads.add(thread.id);
      cx.notify();
    };
    const comments = expanded ? thread.comments.slice(0, 6) : [];
    return v_flex()
      .id(`prs-thread-${thread.id}`)
      .p(10)
      .gap(6)
      .rounded(8)
      .border_1()
      .border_color(thread.isResolved ? t.border : tone(t, "warn"))
      .when(thread.isResolved, (el) => el.bg(t.raised))
      .child(
        h_flex()
          .id(`prs-thread-head-${thread.id}`)
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_click(toggle)
          .child(badge(t, thread.isResolved ? "RESOLVED" : "OPEN", thread.isResolved ? "ok" : "warn"))
          .when(thread.isOutdated, (el) => el.child(badge(t, "OUTDATED", "dim")))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(thread.isResolved ? t.dim : t.muted).child(`${thread.path}${thread.line ? `:${thread.line}` : ""}`))
          .when(!expanded, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${thread.comments.length} comment${thread.comments.length === 1 ? "" : "s"} · Show`)))
          .when(expanded, (el) => el.child(div().text_size(11).text_color(t.dim).child("Hide")))
          .when(standalone && Boolean(thread.comments[0]?.url), (el) => el.child(button(t, `prs-thread-open-${thread.id}`, "Open", () => openUrl(thread.comments[0].url), { small: true })))
          .when(!thread.isResolved, (el) => el.child(button(t, `prs-thread-resolve-${thread.id}`, "Resolve", (_e, cx) => act(pr, "resolve", "Resolve thread", async () => {
            const result = await resolveThread(thread.id);
            this.loadDetail(cx);
            return result;
          }), { small: true }))),
      )
      .children(comments.map((comment, index) =>
        v_flex()
          .id(`prs-tc-${thread.id}-${index}`)
          .gap(2)
          .child(h_flex().gap(6).text_size(11).text_color(t.dim).child(div().font_semibold().text_color(t.foreground).child(`@${comment.author}${comment.isBot ? " (bot)" : ""}`)).child(ago(comment.createdAt)))
          .child(div().text_size(12).text_color(t.muted).child(cleanBody(comment.body).slice(0, 600))),
      ));
  }

  filesTab(t, pr) {
    return this.detail.files.map((file, index) =>
      h_flex()
        .id(`prs-file-${index}`)
        .gap(8)
        .py(2)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => openUrl(`${pr.url}/files`))
        .child(div().flex_1().min_w(0).truncate().child(file.path))
        .child(div().text_size(11).text_color(tone(t, "ok")).child(`+${file.additions}`))
        .child(div().text_size(11).text_color(tone(t, "bad")).child(`−${file.deletions}`)),
    );
  }

  findingsTab(t, pr, findings) {
    const key = prKey(pr.repo, pr.number);
    const open = findings.filter((finding) => finding.state === "open");
    const reviewRunning = Object.values(store().runs).some((run) => run.kind === "review" && run.status === "running" && run.repo === pr.repo && run.number === pr.number);
    const rows = [
      h_flex()
        .gap(6)
        .flex_wrap()
        .child(button(t, "prs-f-review", reviewRunning ? "Review running…" : findings.length ? "Review again" : "Start review", () => NAMED.agentReview(pr), { primary: !findings.length, disabled: reviewRunning }))
        .when(open.length > 0 && pr.mine, (el) => el.child(button(t, "prs-f-fix", `Fix ${open.length} in Claude`, () => act(pr, "fix", `Fix findings on #${pr.number}`, async () => {
          const prompt = findingsFixPrompt(pr, open);
          if ((await startFixSession(pr, prompt)) === false) return copyText(prompt, "A fix session is already open on this PR, so it's shown instead. The findings prompt is on your clipboard to paste into it.");
          return { ok: true, message: `Opened a Claude session on ${agentsWhere()}.` };
        }), { primary: true })))
        .when(open.length > 0, (el) => el.child(button(t, "prs-f-post", "Post to PR", () => act(pr, "post", `Post findings to #${pr.number}`, () => commentOnPr(pr, findingsMarkdown(open)))))),
    ];
    if (!findings.length) rows.push(empty(t, reviewRunning ? `The review is running on ${agentsWhere()}. Findings show up here when the judge finishes.` : "No findings. Start a review to run the correctness, security, reliability and tests lenses, then a judge."));
    for (const finding of findings) {
      const dismissed = finding.state === "dismissed";
      rows.push(
        v_flex()
          .id(`prs-finding-${finding.id}`)
          .p(10)
          .gap(4)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .when(dismissed, (el) => el.opacity(0.5))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(Boolean(finding.severity), (el) => el.child(badge(t, finding.severity.toUpperCase(), finding.severity === "blocker" ? "bad" : finding.severity === "warning" ? "warn" : "dim")))
              .when(Boolean(finding.lens), (el) => el.child(badge(t, finding.lens.toUpperCase(), "dim")))
              .child(div().flex_1().min_w(0).truncate().font_semibold().child(finding.title))
              .child(button(t, `prs-f-toggle-${finding.id}`, dismissed ? "Restore" : "Dismiss", () => setFindingState(key, finding.id, dismissed ? "open" : "dismissed"), { small: true })),
          )
          .when(Boolean(finding.path), (el) => el.child(div().text_size(11).text_color(t.dim).child(`${finding.path}${finding.line ? `:${finding.line}` : ""}`)))
          .child(div().text_size(12).text_color(t.muted).child(finding.body.slice(0, 1200))),
      );
    }
    return rows;
  }

  initFilterEditor(p, cx) {
    this.form = {
      name: InputState.new({ placeholder: "e.g. Frontend, needs my review" }),
      labels: InputState.new({ placeholder: "bug, frontend" }),
      excludeLabels: InputState.new({ placeholder: "wip, do-not-merge" }),
      title: InputState.new({ placeholder: "feat(" }),
      authors: InputState.new({ placeholder: "octocat" }),
    };
    for (const input of Object.values(this.form)) input.on("change", (_e, cx) => cx.notify());
    this.form.name.focus();
    this.formRepos = new Set();
    this.labelsMode = "any";
  }

  input(t, state) {
    return Input.new(state).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
  }

  checkbox(t, id, label, on, onClick) {
    return h_flex()
      .id(id)
      .gap(8)
      .py(3)
      .items_center()
      .cursor_pointer()
      .on_click(onClick)
      .child(div().w(14).h(14).rounded(3).border_1().border_color(t.input).when(on, (el) => el.bg(t.accent)))
      .child(label);
  }

  renderFilterEditor(t) {
    const p = props();
    const value = (key) => this.form[key].value().trim();
    const valid = value("name") && (this.formRepos.size || value("labels") || value("excludeLabels") || value("title") || value("authors"));
    const save = () =>
      updateStore((state) => {
        state.filters.push({ id: newId(), scope: p.scope, name: value("name"), repos: [...this.formRepos], labels: value("labels"), labelsMode: this.labelsMode, excludeLabels: value("excludeLabels"), title: value("title"), authors: value("authors") });
      }).then(() => closeOverlay(p.overlay));
    return this.escapable("prs-filter", v_flex())
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        v_flex()
          .id("prs-filter-body")
          .flex_1()
          .min_h(0)
          .p(18)
          .overflow_y_scrollbar()
          .child(div().text_size(16).font_semibold().child("New filter"))
          .child(field(t, "Name", this.input(t, this.form.name), "Shown on the chip in the filter bar."))
          .child(field(t, "Repositories", v_flex().children(p.repos.map((repo) => this.checkbox(t, `prs-fr-${repo}`, repo, this.formRepos.has(repo), (_e, cx) => {
            if (this.formRepos.has(repo)) this.formRepos.delete(repo);
            else this.formRepos.add(repo);
            cx.notify();
          }))), "Nothing selected = any repo."))
          .child(field(t, "Labels", h_flex().gap(6).child(div().flex_1().child(this.input(t, this.form.labels))).child(button(t, "prs-fl-mode", this.labelsMode === "any" ? "Match any" : "Match all", (_e, cx) => {
            this.labelsMode = this.labelsMode === "any" ? "all" : "any";
            cx.notify();
          }, { small: true })), "Comma-separated. Case-insensitive."))
          .child(field(t, "Exclude labels", this.input(t, this.form.excludeLabels), "A PR carrying any of these never matches."))
          .child(field(t, "Title contains", this.input(t, this.form.title), "Case-insensitive substring of the PR title."))
          .child(field(t, "Authors", this.input(t, this.form.authors), "Comma-separated GitHub logins.")),
      )
      .child(
        h_flex()
          .p(14)
          .gap(8)
          .items_center()
          .child(div().flex_1().text_size(11).text_color(t.dim).child(valid ? "" : "Name it and set at least one criterion."))
          .child(button(t, "prs-filter-cancel", "Cancel", () => closeOverlay(p.overlay)))
          .child(button(t, "prs-filter-save", "Create filter", save, { primary: true, disabled: !valid })),
      );
  }

  initAddPr(cx) {
    this.addInput = InputState.new({ placeholder: "https://github.com/owner/repo/pull/123" });
    this.addInput.on("change", (_e, cx) => cx.notify());
    this.addInput.on("submit", () => this.submitAddPr());
    this.addInput.focus();
  }

  submitAddPr() {
    const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(this.addInput.value());
    if (!match) return;
    const key = prKey(match[1], Number(match[2]));
    updateStore((state) => {
      if (!state.watched.includes(key)) state.watched.push(key);
    }).then(() => {
      refreshSoon();
      closeOverlay(props().overlay);
    });
  }

  renderAddPr(t) {
    const valid = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(this.addInput.value());
    return this.escapable("prs-add", v_flex())
      .size_full()
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child("Watch a PR"))
      .child(this.input(t, this.addInput))
      .child(div().text_size(11).text_color(t.dim).child("It shows in My PRs with a Watching badge."))
      .child(h_flex().justify_end().gap(8).child(button(t, "prs-add-cancel", "Cancel", () => closeOverlay(props().overlay))).child(button(t, "prs-add-save", "Watch", () => this.submitAddPr(), { primary: true, disabled: !valid })));
  }

  initWorkflowEditor(p, cx) {
    const existing = p.id ? store().workflows.find((item) => item.id === p.id) : null;
    this.wf = existing ? JSON.parse(JSON.stringify(existing)) : { id: newId(), name: "", enabled: true, triggers: [], conditions: { repos: [], draft: "any", mineOnly: false }, actions: [] };
    this.wfName = InputState.new({ placeholder: "Label new PRs from bots", value: this.wf.name });
    this.wfLabelsAny = InputState.new({ placeholder: "Has any of these labels", value: this.wf.conditions.labelsAny ?? "" });
    this.wfLabelsNone = InputState.new({ placeholder: "Has none of these labels", value: this.wf.conditions.labelsNone ?? "" });
    this.wfBase = InputState.new({ placeholder: "Base branch, e.g. master", value: this.wf.conditions.base ?? "" });
    this.wfTitle = InputState.new({ placeholder: "Title contains", value: this.wf.conditions.titleContains ?? "" });
    this.wfActionInputs = this.wf.actions.map((action) => this.actionInput(action));
    for (const key of ["prs.pick.wfTrigger", "prs.pick.wfAction"]) this[`seen-${key}`] = shared(key)?.at;
    for (const input of [this.wfName, this.wfLabelsAny, this.wfLabelsNone, this.wfBase, this.wfTitle]) input.on("change", (_e, cx) => cx.notify());
    this.wfName.focus();
    cx.timer.every(250, (cx) => {
      let changed = false;
      this.consumePick("prs.pick.wfTrigger", (value) => {
        if (value && !this.wf.triggers.includes(value)) this.wf.triggers.push(value);
        changed = true;
      });
      this.consumePick("prs.pick.wfAction", (value) => {
        if (!value) return;
        const action = { kind: value, value: "" };
        this.wf.actions.push(action);
        this.wfActionInputs.push(this.actionInput(action));
        changed = true;
      });
      if (changed) cx.notify();
    });
  }

  actionInput(action) {
    const kind = ACTION_KINDS.find((item) => item.id === action.kind);
    if (!kind?.input) return null;
    const input = InputState.new({ placeholder: kind.input, value: action.value ?? "" });
    return input;
  }

  renderWorkflowEditor(t) {
    const p = props();
    const wf = this.wf;
    const valid = this.wfName.value().trim() && wf.triggers.length && wf.actions.length;
    const save = () => {
      wf.name = this.wfName.value().trim();
      wf.conditions.labelsAny = this.wfLabelsAny.value().trim();
      wf.conditions.labelsNone = this.wfLabelsNone.value().trim();
      wf.conditions.base = this.wfBase.value().trim();
      wf.conditions.titleContains = this.wfTitle.value().trim();
      wf.actions = wf.actions.map((action, index) => ({ ...action, value: this.wfActionInputs[index]?.value() ?? "" }));
      updateStore((state) => {
        const index = state.workflows.findIndex((item) => item.id === wf.id);
        if (index >= 0) state.workflows[index] = wf;
        else state.workflows.push(wf);
      }).then(() => closeOverlay(p.overlay));
    };
    const remove = () => updateStore((state) => {
      state.workflows = state.workflows.filter((item) => item.id !== wf.id);
    }).then(() => closeOverlay(p.overlay));
    const card = (title, hint, right, body) =>
      v_flex()
        .mt(12)
        .rounded(10)
        .border_1()
        .border_color(t.border)
        .child(h_flex().p(12).gap(8).items_center().child(v_flex().flex_1().child(div().font_semibold().child(title)).child(div().text_size(11).text_color(t.dim).child(hint))).child(right))
        .child(div().h(1).bg(t.border))
        .child(v_flex().p(12).gap(6).child(body));
    const removable = (id, label, onRemove) => h_flex().id(id).h(26).px(9).gap(6).flex_none().items_center().rounded(7).border_1().border_color(t.border).bg(t.surface).text_size(12).child(label).child(div().id(`${id}-x`).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(onRemove).child("×"));
    const c = wf.conditions;
    return this.escapable("prs-wf", v_flex())
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        v_flex()
          .id("prs-wf-body")
          .flex_1()
          .min_h(0)
          .p(18)
          .overflow_y_scrollbar()
          .child(div().text_size(16).font_semibold().child(p.id ? "Edit workflow" : "New workflow"))
          .child(field(t, "Name", this.input(t, this.wfName)))
          .child(card("When this happens", "Any one of these events on your PRs or review requests.", button(t, "prs-wf-addtrigger", "+ Add trigger", () => this.pick("prs.pick.wfTrigger", TRIGGERS.filter((trigger) => !wf.triggers.includes(trigger.id)).map((trigger) => ({ label: trigger.label, value: trigger.id }))), { small: true }),
            wf.triggers.length ? h_flex().gap(6).flex_wrap().children(wf.triggers.map((id) => removable(`prs-wf-t-${id}`, TRIGGERS.find((trigger) => trigger.id === id)?.label ?? id, (_e, cx) => {
              wf.triggers = wf.triggers.filter((item) => item !== id);
              cx.notify();
            }))) : div().text_size(12).text_color(t.dim).child("No trigger yet.")))
          .child(card("Only if", "Every condition has to hold. Leave them empty to run on every PR the trigger fires for.", div(),
            v_flex()
              .gap(6)
              .child(h_flex().gap(4).flex_wrap().children(p.repos.map((repo) => chip(t, `prs-wf-r-${repo}`, repo.split("/")[1], c.repos.includes(repo), (_e, cx) => {
                c.repos = c.repos.includes(repo) ? c.repos.filter((item) => item !== repo) : [...c.repos, repo];
                cx.notify();
              }))))
              .child(h_flex().gap(4).flex_wrap()
                .child(chip(t, "prs-wf-mine", "Only my PRs", c.mineOnly, (_e, cx) => {
                  c.mineOnly = !c.mineOnly;
                  cx.notify();
                }))
                .children(["any", "no", "yes"].map((value) => chip(t, `prs-wf-draft-${value}`, { any: "Drafts or not", no: "Not draft", yes: "Draft only" }[value], c.draft === value, (_e, cx) => {
                  c.draft = value;
                  cx.notify();
                }))))
              .child(this.input(t, this.wfLabelsAny))
              .child(this.input(t, this.wfLabelsNone))
              .child(this.input(t, this.wfBase))
              .child(this.input(t, this.wfTitle))))
          .child(card("Do this", "In order, top to bottom. A failing step stops the rest.", button(t, "prs-wf-addaction", "+ Add action", () => this.pick("prs.pick.wfAction", ACTION_KINDS.map((kind) => ({ label: kind.label, value: kind.id }))), { small: true }),
            wf.actions.length
              ? v_flex().gap(6).children(wf.actions.map((action, index) => v_flex()
                  .gap(4)
                  .child(removable(`prs-wf-a-${index}`, `${index + 1}. ${ACTION_KINDS.find((kind) => kind.id === action.kind)?.label ?? action.kind}`, (_e, cx) => {
                    wf.actions.splice(index, 1);
                    this.wfActionInputs.splice(index, 1);
                    cx.notify();
                  }))
                  .when(Boolean(this.wfActionInputs[index]), (el) => el.child(this.input(t, this.wfActionInputs[index])))))
              : div().text_size(12).text_color(t.dim).child("Nothing yet."))),
      )
      .child(
        h_flex()
          .p(14)
          .gap(8)
          .items_center()
          .when(Boolean(p.id), (el) => el.child(button(t, "prs-wf-delete", "Delete", remove, { danger: true })))
          .child(div().flex_1())
          .child(button(t, "prs-wf-cancel", "Cancel", () => closeOverlay(p.overlay)))
          .child(button(t, "prs-wf-save", p.id ? "Save" : "Create workflow", save, { primary: true, disabled: !valid })),
      );
  }
}
