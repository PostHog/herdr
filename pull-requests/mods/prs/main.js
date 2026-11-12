import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, shared, setShared, run, machines, notify, layout, nextCommand, focused, window } from "herdr";
import { loadStore, store, updateStore, prKey, newId } from "./store.js";
import { fetchMyPrs, fetchReviews, fetchDetail, statusPill, needsReview, readyToMerge, comparePriority, isOrgWide, ownerOf } from "./github.js";
import { mergePr, markReady, updateBranch, rerunFailed, approvePr, commentOnPr, resolveThread, openUrl, copyText, markdownLink, toggleWatch, toggleHidden, report, usesTrunk, isTrunkPr, mergesThroughQueue } from "./actions.js";
import { startFixSession, startReview, syncRuns, fixPrompt, findingsFixPrompt, reviewPromptForOthers, setFindingState, findingsMarkdown } from "./agents.js";
import { processSnapshot, TRIGGERS, ACTION_KINDS } from "./automation.js";
import { loadConfig, config, updateConfig, configPath, machineLabel } from "./config.js";
import { forgetCheckouts, checkoutFor } from "./runner.js";
import { loadTrunk, dequeue, resetTrunk } from "./trunk.js";
import { fetchServices, isIncident, queueService, statusOverview } from "./status.js";
import { sidebarHeader, sidebarMine, sidebarReviews, sidebarRail, statusLine, prIcon, progressLine, stackHeader, gatesFor, splitByNeed, isQuiet, rowButtons, nextFor, needsYou, workRank } from "./sidebar.js";
import { visualAsks, stackGroups, withoutDraftStacks, step, queueFor, withTrunkQueue } from "./steps.js";
import { openClaude, CLAUDE_ICON } from "./claude.js";
import { ago, button, iconButton, glyphButton, textIconButton, chip, badge, section, empty, field, menuItem, SPINNER, tone, TEXT, tint, avatar, countPill, codePill, gateStrip, titleText, readable } from "./ui.js";
import { readiness, groupChecks, rowMatches, tallyChecks, tallyText, tallyLabel, worstBucket, mergeStateNote, changeShape, parseMarkdown } from "./sheet.js";

const MINE_EVERY_MS = 90000;
const REVIEWS_EVERY_MS = 180000;
const RUNS_EVERY_MS = 20000;
const TRUNK_EVERY_MS = 45000;
const SERVICES_EVERY_MS = 120000;
const FAILURES_BEFORE_ERROR = 3;
const STALE_AFTER_MS = 20000;
const VIEW_STACK = "pr-center";
const PAGE_NODE = "prs-page";
const WORK_NODE = "work";
const SUGGESTED_WIDTH = 88;
const QUICK_ACTIONS_WIDTH = SUGGESTED_WIDTH + 144;
const CONTENT_MAX_WIDTH = 1280;
const GATE_WIDTH = 72;
const NAV_WIDTH = 230;
const STATUS_TILE_MIN = 220;
const STATUS_TILE_GAP = 10;
const statusWidth = (gate) => gate * 5 + 12;
const GATE_HEADERS = ["CHECKS", "REVIEW", "THREADS", "CONFLICTS", "QUEUE"];
const ICON = (name) => `mods/prs/icons/${name}.svg`;
const GATE_ICONS = { ok: "tick", bad: "x", warn: "loader", run: "loader", info: "loader", merged: "merged", idle: "circle" };
const REVIEW_LOOK = {
  APPROVED: { icon: "tick", tone: "ok", word: "approved", verb: "Approved" },
  CHANGES_REQUESTED: { icon: "x", tone: "bad", word: "requested changes", verb: "Requested changes" },
  COMMENTED: { icon: "comment", tone: "dim", word: "commented", verb: "Commented" },
  DISMISSED: { icon: "ban", tone: "dim", word: "was dismissed", verb: "Dismissed" },
};
const THREAD_LOOK = { icon: "comment", tone: "warn", word: "commented on the diff" };
const BUCKET_TONES = { failed: "bad", running: "run", passed: "ok" };
const bucketColor = (t, bucket) => (BUCKET_TONES[bucket] ? tone(t, BUCKET_TONES[bucket]) : t.dim);
const sendsToTrunk = (pr) => isTrunkPr(pr) || usesTrunk(pr);

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
  { id: "code", label: "Code review" },
  { id: "workflows", label: "Workflows" },
  { id: "status", label: "Status" },
  { id: "settings", label: "Settings" },
];

const MINE_CHIPS = [
  { id: "attention", label: "Needs you", test: (pr, needs) => needs.has(prKey(pr.repo, pr.number)) },
  { id: "review", label: "Needs review", test: needsReview },
  { id: "ready", label: "Ready to merge", test: readyToMerge },
  { id: "watching", label: "Watching", test: (pr) => pr.watching, hideWhenEmpty: true },
];

const MINE_SORTS = {
  newest: { label: "↓ Newest", next: "oldest" },
  oldest: { label: "↑ Oldest", next: "priority" },
  priority: { label: "✦ Priority", next: "newest" },
};

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
const keepFocus = (_e, cx) => cx.stop_propagation();
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
  details: (pr) => openOverlay({ mod: "prs", kind: "dialog", width: 900, height: 820, props: { mode: "sheet", pr } }),
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
    this.sidebarTab = localStorage.getItem("sidebarTab") === "reviews" ? "reviews" : "mine";
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? '["review:teams","queue:merged"]'));
    this.trunk = shared("prs.cache.trunk") ?? null;
    this.serviceStatus = shared("prs.cache.services") ?? null;
    this.mineFailures = 0;
    this.reviewsFailures = 0;
    this.seen = null;
    this.seenConfig = shared("prs.config") ?? null;
    this.mineSort = MINE_SORTS[localStorage.getItem("sort")] ? localStorage.getItem("sort") : "newest";
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
      this.loadServices(cx);
      cx.timer.every(SERVICES_EVERY_MS, (cx) => this.loadServices(cx));
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
    this.wasAttending = true;
    this.wasOnPage = pageShown();
    cx.timer.every(1500, (cx) => {
      if (this.leader) this.publishStatus();
      if (this.leader) this.refreshOnReturn(cx);
      const refreshAll = shared("prs.refreshAll") ?? null;
      if (this.leader && refreshAll !== this.seenRefreshAll) {
        this.seenRefreshAll = refreshAll;
        this.loadMine(cx);
        this.loadReviews(cx);
        this.loadServices(cx);
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

  refreshOnReturn(cx) {
    const attending = Boolean(window()?.active);
    const onPage = pageShown();
    const returned = attending && (!this.wasAttending || (onPage && !this.wasOnPage));
    this.wasAttending = attending;
    this.wasOnPage = onPage;
    if (!returned) return;
    const now = Date.now();
    if (now - (this.mineStartedAt ?? 0) > STALE_AFTER_MS) this.loadMine(cx);
    if (now - (this.reviewsStartedAt ?? 0) > STALE_AFTER_MS) this.loadReviews(cx);
  }

  loadMine(cx) {
    if (this.loadingMine) return;
    this.loadingMine = true;
    this.mineStartedAt = Date.now();
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

  loadServices(cx) {
    if (this.loadingServices) return;
    this.loadingServices = true;
    cx.spawn(async (cx) => {
      try {
        const previous = this.serviceStatus;
        this.serviceStatus = await fetchServices(config().status?.services, (ms) => cx.sleep(ms));
        setShared("prs.cache.services", this.serviceStatus);
        this.announceOutages(previous?.services ?? []);
      } catch {}
      this.loadingServices = false;
      cx.notify();
    });
  }

  announceOutages(previous) {
    if (config().notifications === false) return;
    const wasDown = new Set(previous.filter((service) => service.level === "bad").map((service) => service.name));
    const action = hasPage() ? { action: { name: "layout.select", args: { stack: VIEW_STACK, child: PAGE_NODE } } } : {};
    for (const service of this.serviceStatus.services) {
      if (service.level !== "bad" || wasDown.has(service.name)) continue;
      const incident = service.incidents[0]?.name;
      notify({ title: `${service.name} major outage`, body: incident ?? service.description, level: "error", timeout: 12000, ...action });
    }
  }

  allServices() {
    const queue = queueService(this.trunk);
    return [...(this.serviceStatus?.services ?? []), ...(queue ? [queue] : [])];
  }

  statusAlert() {
    const overview = statusOverview(this.allServices());
    return overview.troubled.length ? overview : null;
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
    this.serviceStatus = shared("prs.cache.services") ?? this.serviceStatus;
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
    setShared("prs.page.request", { page: page ?? this.sidebarTab, at: Date.now() });
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
    this.loadServices(cx);
  }

  loadReviews(cx) {
    if (this.loadingReviews) return;
    this.loadingReviews = true;
    this.reviewsStartedAt = Date.now();
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
    const t = readable(theme());
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
    const body = this.sidebarTab === "reviews" ? sidebarReviews(this, t) : sidebarMine(this, t);
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
    const title = { mine: "My PRs", reviews: "Review requests", status: "Status", code: "Code review", workflows: "Workflows", settings: "Settings" }[this.page];
    const alert = this.statusAlert();
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
        .child(div().flex_1().text_size(13).child(page.id === "reviews" ? "Review requests" : page.label))
        .when(page.id === "status" && Boolean(alert), (el) => el.child(svg("mods/prs/icons/alert.svg").size(14).flex_none().text_color(tone(t, alert.level))))
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
    const columnsFit = this.wideLayout();
    const columns = this.page === "mine" || this.page === "reviews"
      ? h_flex()
          .px(20)
          .py(8)
          .gap(12)
          .border_b_1()
          .border_color(t.border)
          .text_size(10.5)
          .font_semibold()
          .text_color(t.dim)
          .child(div().flex_1().child("TITLE"))
          .child(columnsFit.gate === GATE_WIDTH
            ? h_flex().w(statusWidth(columnsFit.gate)).flex_none().gap(3).children(GATE_HEADERS.map((label) => div().w(columnsFit.gate).flex_none().text_size(10).child(label)))
            : div().w(statusWidth(columnsFit.gate)).flex_none().child("READINESS"))
          .child(div().w(columnsFit.actions).flex_none())
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
      .child(v_flex().flex_1().min_w(0).h_full().when(!columns, (el) => el.items_center()).child(
        v_flex()
          .w_full()
          .when(!columns, (el) => el.max_w(CONTENT_MAX_WIDTH))
          .h_full()
          .child(
            h_flex()
              .px(20)
              .pt(14)
              .pb(8)
              .gap(8)
              .items_center()
              .child(div().flex_1().text_size(18).font_semibold().child(title))
              .when(loading, (el) => el.child(svg(SPINNER).size(13).spin(900).text_color(t.dim)))
              .when(this.page === "workflows", (el) => el.child(textIconButton(t, "prs-wf-new", "plus", "New workflow", () => this.newWorkflow())))
              .when(this.page === "mine", (el) => el.child(textIconButton(t, "prs-addpr", "plus", "Add PR", () => openOverlay({ mod: "prs", kind: "dialog", width: 440, height: 200, props: { mode: "addPr" } }))))
              .when(["mine", "reviews"].includes(this.page), (el) => el.child(textIconButton(t, "prs-copylist", "copy", "Copy list", () => copyText(this.visibleList().map((pr) => `- ${markdownLink(pr)}`).join("\n"), "Copied the filtered PRs as a list."))))
              .child(iconButton(t, "prs-wide-refresh", "refresh", "Refresh", (_e, cx) => this.refreshAll(cx))),
          )
          .child(div().px(12).child(this.toolbar(t)))
          .when(Boolean(columns), (el) => el.child(columns))
          .child(v_flex().id("prs-wide-list").flex_1().min_h(0).px(12).pb(16).overflow_y_scrollbar().children(body)),
      ));
  }

  wideLayout() {
    const content = (this.width || CONTENT_MAX_WIDTH + NAV_WIDTH) - NAV_WIDTH;
    if (content >= 1100) return { gate: GATE_WIDTH, quick: true, actions: QUICK_ACTIONS_WIDTH };
    if (content >= 880) return { gate: 48, quick: true, actions: QUICK_ACTIONS_WIDTH };
    return { gate: 40, quick: false, actions: SUGGESTED_WIDTH };
  }

  quickActions(t, pr, scope, leading = [], shown = true) {
    const columnsFit = this.wideLayout();
    const entries = [
      ...(scope === "reviews" ? [["reviewInClaude", "terminal", "Review in Claude"]] : []),
      ["agentReview", "bot", "Agent review (headless)"],
      ["copyLink", "copy", "Copy as Markdown link"],
      ["open", "external", "Open on GitHub"],
    ];
    return h_flex()
      .w(columnsFit.actions)
      .flex_none()
      .gap(2)
      .justify_end()
      .items_center()
      .when(shown && columnsFit.quick, (el) => el
        .child(glyphButton(t, `prs-q-${scope}-${pr.number}-claude`, image(CLAUDE_ICON).size(14), "Claude Code on this PR", () => choose("claude", pr)))
        .children(entries.map(([name, iconName, label]) => iconButton(t, `prs-q-${scope}-${pr.number}-${name}`, iconName, label, () => choose(name, pr))))
        .child(div().w(6).flex_none()))
      .child(h_flex().flex_none().gap(4).items_center().children(leading));
  }

  wideRow(t, id, pr, scope, depth, left, middle, leading = []) {
    return h_flex()
      .id(id)
      .pl(8 + depth * 16)
      .pr(8)
      .py(9)
      .gap(12)
      .items_center()
      .border_b_1()
      .border_color(t.border)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_hover((on, cx) => this.hover(id, on, cx))
      .on_click(() => NAMED.details(pr))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openMenu(pr, scope);
      })
      .child(v_flex().flex_1().min_w(0).gap(4).children(left))
      .child(middle)
      .child(this.quickActions(t, pr, scope, leading, this.hovered === id));
  }

  wideMineRows(t) {
    if (!this.mine) return [empty(t, this.mineError ? `GitHub: ${this.mineError}` : "Loading your PRs…")];
    const prs = this.mineVisible().map((row) => row.pr);
    if (!prs.length) return [empty(t, "No PRs match.")];
    const rows = [];
    const groups = this.mineGroups(prs);
    const columnsFit = this.wideLayout();
    const primaryRepo = [...new Set(prs.map((pr) => pr.repo))].sort((a, b) => this.repoIndex(a) - this.repoIndex(b))[0];
    for (const part of splitByNeed(this, groups)) {
      rows.push(div().px(2).child(section(t, `${part.label} · ${part.groups.reduce((sum, group) => sum + group.members.length, 0)}`)));
      for (const group of part.groups) {
        const members = group.members.length > 1 ? [...group.members].reverse() : group.members;
        if (group.members.length > 1) rows.push(div().pt(6).child(stackHeader(this, t, group)));
        for (const member of members) {
          const pr = member.pr;
          const id = `prs-wm-${pr.repo}-${pr.number}`;
          const progress = progressLine(this, t, pr, group);
          const { next, entry } = nextFor(this, pr, group);
          const meta = `${pr.repo === primaryRepo ? "" : pr.repo}#${pr.number}${pr.mine ? "" : ` · @${pr.author}`} · opened ${ago(pr.createdAt)} · updated ${ago(pr.updatedAt)}`;
          rows.push(this.wideRow(t, id, pr, "mine", group.members.length > 1 ? 1 : 0,
            [
              h_flex().gap(6).items_center().child(prIcon(this, t, pr, { group })).child(div().flex_1().min_w(0).child(this.titleLine(t, pr, isQuiet(this, part, pr, group)))),
              div().pl(19).min_w(0).truncate().text_size(TEXT.meta).text_color(t.dim).child(meta),
            ],
            v_flex().w(statusWidth(columnsFit.gate)).flex_none().gap(5).child(statusLine(this, t, pr, { group, buttons: false })).child(gateStrip(t, id, gatesFor(this, pr, group), { segment: columnsFit.gate, height: 4 })).when(Boolean(progress), (el) => el.child(progress)),
            rowButtons(this, t, pr, { scope: "mine", next, entry, group }),
          ));
        }
      }
    }
    return rows;
  }

  wideReviewRows(t) {
    if (!this.reviews) return [empty(t, this.reviewsError ? `GitHub: ${this.reviewsError}` : "Loading review requests…")];
    const { visible, hidden } = this.reviewsVisible();
    const columnsFit = this.wideLayout();
    const row = (pr) => {
      const via = pr.via.direct ? "you" : pr.via.teams[0] ? `@${pr.via.teams[0]}` : "";
      const id = `prs-wr-${pr.repo}-${pr.number}`;
      return this.wideRow(t, id, pr, "reviews", 0,
        [
          h_flex().gap(6).items_center().child(prIcon(this, t, pr, { scope: "reviews" })).child(div().flex_1().min_w(0).child(this.titleLine(t, pr))),
          div().pl(19).truncate().text_size(TEXT.meta).text_color(t.dim).child(`${pr.repo}#${pr.number}${via ? ` · via ${via}` : ""} · updated ${ago(pr.updatedAt)}`),
        ],
        v_flex().w(statusWidth(columnsFit.gate)).flex_none().gap(5).child(statusLine(this, t, pr, { scope: "reviews", buttons: false })).child(gateStrip(t, id, gatesFor(this, pr, null, "reviews"), { segment: columnsFit.gate, height: 4 })),
      );
    };
    const rows = visible.length ? visible.map(row) : [empty(t, "No PRs waiting on your review.")];
    if (hidden.length) {
      rows.push(
        h_flex()
          .id("prs-wide-hidden")
          .px(8)
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
      .child(div().flex_1().min_w(0).on_mouse_down("left", keepFocus).child(Input.new(this.search).h(26).px(4).bg(t.background).text_size(12).text_color(t.foreground)));
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
          .when(scope === "mine", (el) => el.child(chip(t, "prs-sort", MINE_SORTS[this.mineSort].label, this.mineSort === "priority", (_e, cx) => {
            this.mineSort = MINE_SORTS[this.mineSort].next;
            localStorage.setItem("sort", this.mineSort);
            cx.notify();
          })))
          .when(scope === "reviews", (el) => el.child(chip(t, "prs-rsort", REVIEW_SORTS[this.reviewSort].label, this.reviewSort === "priority", (_e, cx) => {
            this.reviewSort = REVIEW_SORTS[this.reviewSort].next;
            localStorage.setItem("reviewSort", this.reviewSort);
            cx.notify();
          })))
          .child(chip(t, "prs-repo", `${repoLabel} ▾`, Boolean(this.repoFilter), () => this.pick("prs.pick.repo", [{ label: "All repos", value: null }, ...this.knownRepos().map((repo) => ({ label: repo, value: repo }))], this.repoFilter)))
          .when(scope === "mine", (el) => {
            const needs = this.needsYouKeys();
            return el.children(MINE_CHIPS.flatMap((item) => {
              const count = this.mine ? this.mine.prs.filter((pr) => item.test(pr, needs)).length : 0;
              if (item.hideWhenEmpty && !count && !this.chips.has(item.id)) return [];
              return [chip(t, `prs-chip-${item.id}`, item.label, this.chips.has(item.id), (_e, cx) => {
                if (this.chips.has(item.id)) this.chips.delete(item.id);
                else this.chips.add(item.id);
                cx.notify();
              }, count || null)];
            }));
          })
          .when(scope === "mine", (el) => el.child(chip(t, "prs-drafts", "Hide drafts", this.hideDrafts, (_e, cx) => this.toggleDrafts(cx), this.hideDrafts ? this.hiddenDrafts() || null : null)))
          .when(scope === "reviews", (el) => el.child(chip(t, "prs-via", `${this.viaLabel()} ▾`, Boolean(this.viaFilter), () => this.pick("prs.pick.via", this.viaOptions(), this.viaFilter))))
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
    const needs = this.needsYouKeys();
    const prs = this.applyCommon(this.withDraftsApplied(this.mine?.prs ?? [])).filter((pr) => MINE_CHIPS.every((item) => !this.chips.has(item.id) || item.test(pr, needs)));
    return this.mineGroups(prs).flatMap((group) => group.members);
  }

  needsYouKeys() {
    const groups = stackGroups(this.mine?.prs ?? []).filter((group) => group.members.some((member) => needsYou(this, member.pr, group)));
    return new Set(groups.flatMap((group) => group.members.map((member) => prKey(member.pr.repo, member.pr.number))));
  }

  mineGroups(prs) {
    const groups = stackGroups(prs, this.mineSort !== "oldest");
    if (this.mineSort !== "priority") return groups;
    const rank = new Map(groups.map((group) => [group, Math.max(...group.members.map((member) => workRank(this, member.pr, group)))]));
    return groups.sort((a, b) => rank.get(b) - rank.get(a) || b.updated - a.updated);
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
      case "status":
        return this.statusRows(t);
      case "code":
        return this.codeRows(t);
      case "workflows":
        return this.workflowRows(t);
      case "settings":
        return this.settingsRows(t);
      default:
        return this.wideMineRows(t);
    }
  }

  titleLine(t, pr, quiet = false) {
    return h_flex()
      .gap(6)
      .items_center()
      .child(titleText(t, pr.title, { quiet }))
      .when(isBusy(pr), (el) => el.child(svg(SPINNER).size(11).spin(900).text_color(t.dim)));
  }

  statusRows(t) {
    const services = this.allServices();
    if (!this.serviceStatus) return [empty(t, "Reading the status pages…")];
    const overview = statusOverview(services);
    const troubled = overview.sorted.filter(isIncident);
    const calm = overview.sorted.filter((service) => !isIncident(service));
    const header = h_flex()
      .px(8)
      .pt(14)
      .pb(12)
      .gap(8)
      .items_center()
      .when(troubled.length > 0, (el) => el.child(svg("mods/prs/icons/alert.svg").size(15).flex_none().text_color(tone(t, overview.level))))
      .child(div().flex_1().text_size(14).font_semibold().text_color(troubled.length ? tone(t, overview.level) : t.foreground).child(overview.title))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`Checked ${ago(new Date(this.serviceStatus.at).toISOString())}`));
    return [
      header,
      ...troubled.map((service, index) => this.incidentCard(t, service, index)),
      ...this.statusGrid(t, calm),
    ];
  }

  incidentCard(t, service, index) {
    const color = tone(t, service.level);
    const incidents = service.incidents.slice(0, 3);
    const affected = (incident) => (incident.affected.length ? incident.affected : service.components.map((component) => component.name)).slice(0, 6);
    const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
    const when = (incident) => [
      incident.since ? `Started ${ago(incident.since)}` : null,
      incident.updated && incident.updated !== incident.since ? `updated ${ago(incident.updated)}` : null,
    ].filter(Boolean).join(" · ");
    return v_flex()
      .id(`prs-status-incident-${index}`)
      .mx(8)
      .mb(12)
      .rounded(12)
      .border_1()
      .border_color(color)
      .bg(t.surface)
      .overflow_hidden()
      .child(
        h_flex()
          .px(18)
          .pt(16)
          .pb(14)
          .gap(12)
          .items_center()
          .child(h_flex().relative().size(32).flex_none().items_center().justify_center().rounded(8).child(tint(color, 8)).child(svg("mods/prs/icons/alert.svg").size(16).text_color(color)))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(14).font_semibold().child(service.name))
            .child(div().truncate().text_size(12).text_color(color).child(service.description)))
          .when(Boolean(service.url), (el) => el.child(
            h_flex()
              .id(`prs-status-incident-${index}-page`)
              .flex_none()
              .h(26)
              .px(9)
              .gap(6)
              .items_center()
              .rounded(6)
              .text_size(11.5)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => openUrl(service.url))
              .child("Status page")
              .child(svg("mods/prs/icons/external.svg").size(12).text_color(t.dim)),
          )),
      )
      .when(!incidents.length && service.components.length > 0, (el) => el.child(
        h_flex().px(18).pb(16).pl(62).gap(6).flex_wrap().children(service.components.map((component) => codePill(t, component.name))),
      ))
      .children(incidents.map((incident, at) =>
        v_flex()
          .id(`prs-status-incident-${index}-${at}`)
          .pl(62)
          .pr(18)
          .py(14)
          .gap(8)
          .border_t_1()
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => openUrl(incident.url))
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().min_w(0).truncate().text_size(13).font_semibold().child(incident.name))
              .when(Boolean(incident.impact) && incident.impact !== "none", (el) => el.child(countPill(t, sentence(incident.impact), color)))
              .when(Boolean(incident.status), (el) => el.child(countPill(t, sentence(incident.status))))
              .child(div().flex_1())
              .when(Boolean(when(incident)), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(when(incident)))),
          )
          .when(Boolean(incident.latest), (el) => el.child(div().max_w(760).text_size(12.5).text_color(t.muted).child(incident.latest)))
          .when(affected(incident).length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(affected(incident).map((name) => codePill(t, name))))),
      ))
      .when(service.incidents.length > incidents.length, (el) => el.child(div().pl(62).pr(18).py(10).border_t_1().border_color(t.border).text_size(11).text_color(t.dim).child(`${service.incidents.length - incidents.length} more on the status page`)));
  }

  statusGrid(t, services) {
    if (!services.length) return [];
    const width = Math.min(CONTENT_MAX_WIDTH, (this.width || CONTENT_MAX_WIDTH + NAV_WIDTH) - NAV_WIDTH) - 40;
    const perRow = Math.max(1, Math.floor((width + STATUS_TILE_GAP) / (STATUS_TILE_MIN + STATUS_TILE_GAP)));
    const levelColor = (level) => (level === "unknown" ? t.dim : tone(t, level));
    const tile = (service, index) => v_flex()
      .id(`prs-status-${index}`)
      .flex_1()
      .min_w(0)
      .h(64)
      .px(12)
      .justify_center()
      .gap(4)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .when(Boolean(service.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => openUrl(service.url)))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().w(8).h(8).rounded(4).flex_none().bg(levelColor(service.level)))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(service.name))
          .when(Boolean(service.url), (el) => el.child(svg("mods/prs/icons/external.svg").size(12).flex_none().text_color(t.dim))),
      )
      .child(div().truncate().text_size(12).text_color(service.level === "info" ? levelColor(service.level) : t.muted).child(service.maintenance[0]?.name ?? service.description));
    const rows = [];
    for (let start = 0; start < services.length; start += perRow) {
      const slice = services.slice(start, start + perRow);
      rows.push(h_flex()
        .px(8)
        .mb(STATUS_TILE_GAP)
        .gap(STATUS_TILE_GAP)
        .children([
          ...slice.map((service, at) => tile(service, start + at)),
          ...Array.from({ length: perRow - slice.length }, () => div().flex_1().min_w(0).px(12).border_1().border_color(t.background)),
        ]));
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

  newWorkflow() {
    openOverlay({ mod: "prs", kind: "dialog", width: 560, height: 720, props: { mode: "workflow", repos: this.knownRepos() } });
  }

  workflowRows(t) {
    const workflows = store().workflows;
    const about = "Runs on your PRs and review requests while Herdr is open, checked on every refresh. At most 5 runs per PR per hour.";
    if (!workflows.length) {
      return [
        v_flex()
          .px(8)
          .pt(14)
          .gap(8)
          .items_start()
          .child(div().text_size(13).font_semibold().child("No workflows yet"))
          .child(div().text_size(12).text_color(t.muted).child(about))
          .child(button(t, "prs-wf-first", "New workflow", () => this.newWorkflow(), { small: true, primary: true })),
      ];
    }
    const rows = [div().px(8).pt(8).pb(4).text_size(11.5).text_color(t.dim).child(about)];
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

  trunkEntryFor(pr) {
    const trunk = shared("prs.cache.trunk") ?? this.trunk;
    const mine = (shared("prs.cache.mine") ?? this.mine)?.prs ?? [];
    const same = (member) => member.pr.repo === pr.repo && member.pr.number === pr.number;
    const group = stackGroups(mine).find((candidate) => candidate.members.some(same)) ?? null;
    return queueFor(group?.members.find(same)?.pr ?? pr, group, trunk);
  }

  renderSheet(t) {
    const p = props();
    const pr = withTrunkQueue({ ...p.pr, watching: store().watched.includes(prKey(p.pr.repo, p.pr.number)) }, this.trunkEntryFor(p.pr));
    const findings = store().findings[prKey(pr.repo, pr.number)] ?? [];
    const state = readiness(pr, this.detail, { queueBased: mergesThroughQueue(pr) });
    return this.escapable("prs-sheet", v_flex())
      .size_full()
      .bg(t.popover)
      .text_size(12.5)
      .text_color(t.foreground)
      .child(
        v_flex()
          .flex_none()
          .px(20)
          .pt(18)
          .child(this.sheetHeader(t, pr, state, p.overlay))
          .child(this.sheetMeta(t, pr))
          .child(this.readinessStrip(t, state))
          .child(this.sheetTabs(t, pr, findings, state)),
      )
      .child(div().h(1).flex_none().bg(t.border))
      .child(this.sheetBody(t, pr, findings, state))
      .child(div().h(1).flex_none().bg(t.border))
      .child(this.sheetFooter(t, pr, state));
  }

  sheetHeader(t, pr, state, overlay) {
    const color = tone(t, state.verdict.tone);
    const stateIcon = pr.state === "MERGED" ? "merged" : pr.isDraft ? "pr-draft" : "pr";
    return h_flex()
      .gap(10)
      .items_center()
      .child(h_flex().relative().size(28).flex_none().items_center().justify_center().rounded(8).child(tint(color, 8)).child(svg(ICON(stateIcon)).size(16).text_color(color)))
      .child(div().flex_1().min_w(0).text_size(16).font_semibold().truncate().child(pr.title))
      .when(this.loadingDetail, (el) => el.child(svg(SPINNER).size(12).spin(900).text_color(t.dim)))
      .child(iconButton(t, "prs-sheet-refresh", "refresh", "Refresh", (_e, cx) => this.loadDetail(cx)))
      .child(iconButton(t, "prs-sheet-open", "external", "Open on GitHub", () => openUrl(pr.url)))
      .child(iconButton(t, "prs-sheet-close", "x", "Close", () => closeOverlay(overlay)));
  }

  sheetMeta(t, pr) {
    return h_flex()
      .mt(6)
      .gap(8)
      .items_center()
      .text_size(12)
      .text_color(t.dim)
      .child(h_flex().flex_none().gap(4).child(pr.repo).child(div().text_color(t.muted).child(`#${pr.number}`)))
      .child(div().flex_none().child("·"))
      .child(h_flex().flex_none().gap(6).items_center().child(avatar(t, pr.author, 16)).child(div().text_color(t.muted).child(pr.author)))
      .when(Boolean(pr.headRef), (el) => el.child(div().flex_none().child("·")).child(codePill(t, pr.headRef)).child(div().flex_none().child("→")).child(codePill(t, pr.baseRef ?? "")));
  }

  readinessStrip(t, state) {
    const { verdict, gates } = state;
    return div()
      .flex()
      .mt(14)
      .gap(18)
      .px(14)
      .py(12)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .child(
        v_flex()
          .w(216)
          .flex_none()
          .gap(3)
          .justify_center()
          .pr(18)
          .border_r_1()
          .border_color(t.border)
          .child(div().text_size(13.5).font_semibold().text_color(tone(t, verdict.tone)).child(verdict.title))
          .child(div().text_size(12).text_color(t.muted).child(verdict.detail)),
      )
      .child(h_flex().flex_1().min_w(0).gap(6).items_start().children(gates.map((gate) => this.gateView(t, gate))));
  }

  gateView(t, gate) {
    const idle = gate.state === "idle";
    const color = idle ? t.dim : tone(t, gate.state);
    const glyph = gate.id === "threads" && gate.state === "warn" ? "comment" : GATE_ICONS[gate.state] ?? "circle";
    return v_flex()
      .flex_1()
      .min_w(0)
      .gap(7)
      .child(div().h(3).w_full().rounded(2).bg(idle ? t.border : color))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .text_size(12)
          .font_medium()
          .text_color(gate.state === "ok" ? t.foreground : color)
          .child(svg(ICON(glyph)).size(14).flex_none().text_color(color).when(gate.state === "run", (el) => el.spin(900)))
          .child(gate.label),
      )
      .child(div().pl(20).text_size(11).text_color(t.dim).truncate().child(gate.sub));
  }

  sheetTabs(t, pr, findings, state) {
    const openFindings = findings.filter((finding) => finding.state === "open").length;
    const worst = worstBucket(state.tally);
    const reviewCount = this.detail ? this.conversation().reviews : 0;
    const tabs = [
      ["overview", "Overview", null],
      ["findings", "Findings", openFindings ? countPill(t, String(openFindings)) : null],
      ["checks", "Checks", state.tally.total ? countPill(t, tallyLabel(state.tally), worst ? bucketColor(t, worst) : null) : null],
      ["reviews", "Reviews", reviewCount ? countPill(t, String(reviewCount)) : null],
    ];
    return h_flex()
      .mt(8)
      .gap(22)
      .children(
        tabs.map(([id, label, pill]) => {
          const on = this.tab === id;
          return h_flex()
            .id(`prs-sheet-tab-${id}`)
            .relative()
            .h(38)
            .gap(6)
            .items_center()
            .text_size(12.5)
            .font_medium()
            .text_color(on ? t.foreground : t.dim)
            .cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              this.tab = id;
              cx.notify();
            })
            .child(label)
            .when(Boolean(pill), (el) => el.child(pill))
            .when(on, (el) => el.child(div().absolute().left(0).right(0).bottom(0).h(2).bg(t.accent)));
        }),
      );
  }

  sheetBody(t, pr, findings, state) {
    if (this.detailError) return this.scrollBody([empty(t, `GitHub: ${this.detailError}`)]);
    if (this.tab === "findings") return this.scrollBody(this.findingsTab(t, pr, findings), 8);
    if (!this.detail) return this.scrollBody([empty(t, "Loading details…")]);
    if (this.tab === "checks") return this.scrollBody(this.checksTab(t), 12);
    if (this.tab === "reviews") return this.scrollBody(this.reviewsTab(t, pr, state), 20);
    return this.overviewTab(t, pr, state);
  }

  scrollBody(children, gap = 12) {
    return v_flex().id("prs-sheet-body").flex_1().min_h(0).px(20).py(16).gap(gap).overflow_y_scrollbar().children(children);
  }

  sheetFooter(t, pr, state) {
    const rerun = ["rerun", "Rerun failed", () => act(pr, "rerun", `Rerun failed checks on #${pr.number}`, () => rerunFailed(pr, this.detail ?? undefined))];
    const failed = state.tally.failed > 0;
    const actions = pr.mine
      ? [
          ["fix", "Fix with Claude", () => NAMED.fix(pr)],
          ["agentReview", "Agent review", () => NAMED.agentReview(pr)],
          ...(pr.isDraft ? [["markReady", "Ready for review", () => NAMED.markReady(pr)]] : []),
          ...(pr.queue?.active || pr.state === "MERGED" || pr.state === "CLOSED" ? [] : [["merge", sendsToTrunk(pr) ? "Send to queue…" : "Merge…", () => choose("merge", pr)]]),
          ["updateBranch", "Update branch", () => NAMED.updateBranch(pr)],
          ...(failed ? [rerun] : []),
        ]
      : [
          ["review", "Review in Claude", () => NAMED.reviewInClaude(pr)],
          ["agentReview", "Agent review", () => NAMED.agentReview(pr)],
          ["approve", "Approve…", () => choose("approve", pr)],
          ...(failed ? [rerun] : []),
        ];
    const primary = state.verdict.primary;
    const ordered = [...actions.filter(([id]) => id === primary), ...actions.filter(([id]) => id !== primary)];
    return h_flex()
      .min_h(54)
      .flex_none()
      .flex_wrap()
      .px(16)
      .py(11)
      .gap(8)
      .items_center()
      .bg(t.surface)
      .children(ordered.map(([id, label, onClick]) => button(t, `prs-sheet-${id}`, label, onClick, { primary: id === primary })))
      .child(div().flex_1())
      .child(button(t, "prs-sheet-watch", pr.watching ? "Unwatch" : "Watch", () => NAMED.watch(pr), { ghost: true, icon: "eye" }))
      .child(button(t, "prs-sheet-copy", "Copy link", () => NAMED.copyLink(pr), { ghost: true, icon: "copy" }));
  }

  inline(t, spans, id, { size = 12.5, color = null } = {}) {
    const plainColor = color ?? t.muted;
    if (spans.every((span) => !span.code && !span.bold && !span.link)) return div().text_size(size).text_color(plainColor).child(spans.map((span) => span.text).join(""));
    const words = [];
    let word = [];
    const finish = () => {
      if (word.length) words.push(word);
      word = [];
    };
    for (const span of spans) {
      if (span.code) {
        word.push(span);
        continue;
      }
      for (const part of span.text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) finish();
        else word.push({ ...span, text: part });
      }
    }
    finish();
    const piece = (span, key) => {
      if (span.code) return div().flex_none().px(5).rounded(4).bg(t.raised).text_size(size - 1).text_color(t.foreground).child(span.text);
      if (span.link && /^https?:\/\//.test(span.link)) return div().id(`prs-md-${id}-${key}`).flex_none().text_color(t.accent).cursor_pointer().hover((s) => s.opacity(0.8)).tooltip(span.link).on_click(() => openUrl(span.link)).child(span.text);
      return div().flex_none().text_color(span.bold ? t.foreground : plainColor).when(Boolean(span.bold), (el) => el.font_semibold()).child(span.text);
    };
    return h_flex()
      .flex_wrap()
      .gap(4)
      .text_size(size)
      .children(words.map((pieces, index) => (pieces.length === 1 ? piece(pieces[0], index) : h_flex().flex_none().children(pieces.map((span, part) => piece(span, `${index}-${part}`))))));
  }

  markdown(t, text, id, options = {}) {
    const size = options.size ?? 12.5;
    return parseMarkdown(text).map((block, index) => {
      if (block.type === "heading") return div().pt(index ? 8 : 0).text_size(block.level <= 2 ? size + 1 : size).font_semibold().text_color(t.foreground).child(block.spans.map((span) => span.text).join(""));
      if (block.type === "code") return v_flex().p(10).rounded(6).bg(t.raised).text_size(size - 1).text_color(t.foreground).children(block.lines.map((line) => div().child(line || " ")));
      if (block.type === "list") {
        return v_flex()
          .gap(6)
          .children(
            block.items.map((item, itemIndex) =>
              h_flex()
                .gap(10)
                .items_start()
                .child(item.marker ? div().flex_none().text_size(size).text_color(t.dim).child(item.marker) : div().flex_none().mt(7).size(4).rounded(2).bg(t.dim))
                .child(div().flex_1().min_w(0).child(this.inline(t, item.spans, `${id}-${index}-${itemIndex}`, options))),
            ),
          );
      }
      return this.inline(t, block.spans, `${id}-${index}`, options);
    });
  }

  overviewTab(t, pr, state) {
    const failing = groupChecks(this.detail.checks).flatMap((group) => group.rows).filter((row) => row.bucket === "failed");
    const body = cleanBody(this.detail.body).slice(0, 3000);
    return div()
      .flex()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .id("prs-sheet-body")
          .flex_1()
          .min_w(0)
          .px(24)
          .py(20)
          .gap(12)
          .overflow_y_scrollbar()
          .border_r_1()
          .border_color(t.border)
          .when(failing.length > 0, (el) =>
            el
              .child(div().text_size(10.5).font_semibold().text_color(tone(t, "bad")).child(`FAILING CHECKS (${failing.reduce((sum, row) => sum + row.shards.filter((shard) => shard.bucket === "failed").length, 0)})`))
              .children(failing.slice(0, 12).map((row, index) => this.checkRow(t, row, `ov-${index}`, 0)))
              .child(div().h(1).mt(4).bg(t.border)),
          )
          .children(body ? this.markdown(t, body, "body") : [div().text_size(12.5).text_color(t.dim).child("No description.")]),
      )
      .child(this.overviewRail(t, pr, state));
  }

  overviewRail(t, pr, state) {
    const block = (label, children) => v_flex().gap(9).child(div().text_size(10.5).font_semibold().text_color(t.dim).child(label.toUpperCase())).children(children);
    const reviewers = state.reviewers ?? [];
    const files = this.detail.files;
    const fileCount = pr.changedFiles ?? files.length;
    const shape = changeShape(files);
    const note = mergeStateNote(pr);
    return v_flex()
      .id("prs-sheet-rail")
      .w(248)
      .flex_none()
      .px(18)
      .py(20)
      .gap(22)
      .overflow_y_scrollbar()
      .bg(t.surface)
      .child(block("Reviewers", reviewers.length ? reviewers.slice(0, 8).map((reviewer) => this.reviewerRow(t, reviewer)) : [div().text_size(12.5).text_color(t.dim).child(pr.reviewDecision === "REVIEW_REQUIRED" ? "Waiting on a review" : "None yet")]))
      .child(
        block("Changes", [
          h_flex()
            .gap(8)
            .items_center()
            .text_size(12)
            .child(div().text_color(tone(t, "ok")).child(`+${pr.additions ?? 0}`))
            .child(div().text_color(tone(t, "bad")).child(`−${pr.deletions ?? 0}`))
            .child(div().text_color(t.dim).child(`in ${fileCount} file${fileCount === 1 ? "" : "s"}`)),
          ...(shape.where ? [div().text_size(11.5).text_color(t.muted).child(shape.where)] : []),
          ...shape.notes.map((note) => div().text_size(11.5).text_color(t.muted).child(note)),
          ...shape.largest.map((file, index) =>
            h_flex()
              .id(`prs-rail-file-${index}`)
              .gap(6)
              .items_center()
              .text_size(11.5)
              .cursor_pointer()
              .hover((el) => el.text_color(t.foreground))
              .tooltip(file.path)
              .on_click(() => openUrl(`${pr.url}/files`))
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(file.name))
              .child(div().flex_none().text_color(tone(t, "ok")).child(`+${file.additions}`))
              .child(div().flex_none().text_color(tone(t, "bad")).child(`−${file.deletions}`)),
          ),
          ...(shape.more ? [div().text_size(11.5).text_color(t.dim).child(`and ${shape.more} smaller file${shape.more === 1 ? "" : "s"}`)] : []),
          div().id("prs-rail-diff").text_size(11.5).text_color(t.accent).cursor_pointer().on_click(() => openUrl(`${pr.url}/files`)).child("Open the diff on GitHub"),
        ]),
      )
      .child(block("Labels", [pr.labels?.length ? h_flex().gap(4).flex_wrap().children(pr.labels.map((label) => codePill(t, label))) : div().text_size(12.5).text_color(t.dim).child("None")]))
      .child(
        block("GitHub state", [
          h_flex()
            .gap(6)
            .flex_wrap()
            .child(badge(t, pr.mergeState ?? "?", "muted"))
            .child(badge(t, pr.mergeable ?? "?", "muted")),
          ...(note ? [div().text_size(11.5).text_color(t.dim).child(note)] : []),
        ]),
      );
  }

  reviewerRow(t, reviewer) {
    const look = REVIEW_LOOK[reviewer.state] ?? REVIEW_LOOK.COMMENTED;
    return v_flex()
      .gap(3)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .text_size(12.5)
          .child(avatar(t, reviewer.login, 20))
          .child(div().flex_1().min_w(0).truncate().child(reviewer.login))
          .child(svg(ICON(look.icon)).size(14).flex_none().text_color(tone(t, look.tone))),
      )
      .child(div().pl(28).text_size(11.5).text_color(t.dim).child(`${look.verb} ${ago(reviewer.at)}${reviewer.commented && reviewer.state !== "COMMENTED" ? ", with a comment" : ""}`));
  }

  checkRow(t, row, id, indent = 30) {
    const color = bucketColor(t, row.bucket);
    return h_flex()
      .id(`prs-check-${id}`)
      .h(34)
      .pl(indent)
      .pr(10)
      .gap(10)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(row.name)
      .on_click(() => row.url && openUrl(row.url))
      .child(div().size(8).rounded(4).flex_none().bg(color))
      .child(div().min_w(0).truncate().font_medium().child(row.title))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(row.params))
      .when(row.sharded, (el) => el.child(h_flex().flex_none().gap(3).children(row.shards.slice(0, 24).map((shard) => div().size(9).rounded(2).bg(bucketColor(t, shard.bucket))))))
      .when(row.required, (el) => el.child(badge(t, "REQUIRED", "dim")))
      .child(h_flex().w(88).flex_none().justify_end().text_size(11).text_color(color).child(row.status));
  }

  checksTab(t) {
    this.checkFilter ??= "all";
    this.toggledGroups ??= new Set();
    const checks = this.detail.checks;
    if (!checks.length) return [empty(t, "No checks reported on the head commit.")];
    const tally = tallyChecks(checks);
    const filter = this.checkFilter;
    const filters = [
      ["all", "All", tally.total, null],
      ["failed", "Failed", tally.failed, bucketColor(t, "failed")],
      ["running", "Running", tally.running, bucketColor(t, "running")],
      ["passed", "Passed", tally.passed, bucketColor(t, "passed")],
    ];
    return [
      h_flex()
        .gap(6)
        .items_center()
        .children(
          filters.map(([id, label, count, dot]) =>
            chip(t, `prs-checks-filter-${id}`, label, filter === id, (_e, cx) => {
              this.checkFilter = id;
              cx.notify();
            }, count, dot ?? t.dim),
          ),
        ),
      h_flex()
        .h(6)
        .w_full()
        .flex_none()
        .rounded(3)
        .overflow_hidden()
        .bg(t.border)
        .children(["failed", "running", "cancelled", "passed"].filter((bucket) => tally[bucket]).map((bucket) => div().h_full().w(`${(tally[bucket] / tally.total) * 100}%`).bg(bucketColor(t, bucket)))),
      ...groupChecks(checks).map((group, index) => this.checkGroup(t, group, index, filter)).filter(Boolean),
    ];
  }

  checkGroup(t, group, index, filter) {
    const rows = group.rows.filter((row) => rowMatches(row, filter));
    if (!rows.length) return null;
    const open = (filter !== "all" || !group.settled) !== this.toggledGroups.has(group.name);
    return v_flex()
      .gap(1)
      .child(
        h_flex()
          .id(`prs-checks-group-${index}`)
          .h(32)
          .px(10)
          .gap(8)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .accessibility_label(`${open ? "Collapse" : "Expand"} ${group.name}`)
          .on_click((_e, cx) => {
            if (this.toggledGroups.has(group.name)) this.toggledGroups.delete(group.name);
            else this.toggledGroups.add(group.name);
            cx.notify();
          })
          .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
          .child(div().min_w(0).truncate().font_semibold().child(group.name))
          .child(div().flex_1())
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(tallyText(group.tally))),
      )
      .when(open, (el) => el.children(rows.map((row, rowIndex) => this.checkRow(t, row, `${index}-${rowIndex}`))));
  }

  conversation() {
    const threads = this.detail.threads;
    const reviewIds = new Set(this.detail.reviews.map((review) => review.id));
    const threadsOf = (reviewId) => threads.filter((thread) => thread.reviewId === reviewId).sort((a, b) => Number(a.isResolved) - Number(b.isResolved));
    const reviewEntries = this.detail.reviews
      .map((review) => ({ at: review.submittedAt, review, threads: threadsOf(review.id) }))
      .filter(({ review, threads: own }) => review.state !== "COMMENTED" || cleanBody(review.body) || own.length);
    const entries = [...reviewEntries, ...threads.filter((thread) => !reviewIds.has(thread.reviewId)).map((thread) => ({ at: thread.comments[0]?.createdAt, threads: [thread] }))].sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
    return { entries, reviews: reviewEntries.length, open: threads.filter((thread) => !thread.isResolved).length };
  }

  reviewsTab(t, pr, state) {
    const { entries, open } = this.conversation();
    const changes = (state.reviewers ?? []).filter((reviewer) => reviewer.state === "CHANGES_REQUESTED").length;
    const summary = h_flex()
      .gap(18)
      .items_center()
      .flex_wrap()
      .text_size(12.5)
      .text_color(t.muted)
      .child(
        state.approvals
          ? h_flex().gap(6).items_center().font_medium().text_color(tone(t, "ok")).child(svg(ICON("tick")).size(14).flex_none().text_color(tone(t, "ok"))).child(`${state.approvals} approval${state.approvals === 1 ? "" : "s"}`)
          : div().child("No approvals"),
      )
      .child(changes ? div().text_color(tone(t, "bad")).child(`${changes} reviewer${changes === 1 ? "" : "s"} requested changes`) : div().child("No changes requested"))
      .child(open ? div().text_color(tone(t, "warn")).child(`${open} open thread${open === 1 ? "" : "s"}`) : div().child("No open threads"));
    if (!entries.length) return [summary, empty(t, "No reviews or comments yet.")];
    return [
      summary,
      ...entries.map((entry, index) => this.timelineItem(t, pr, entry, index, index === entries.length - 1)),
      ...(this.detail.threads.length
        ? []
        : [h_flex().gap(12).items_center().child(h_flex().w(28).flex_none().justify_center().child(div().size(9).rounded(5).border_1().border_color(t.dim))).child(div().text_size(12).text_color(t.dim).child("No review threads on the diff."))]),
    ];
  }

  timelineItem(t, pr, entry, index, last) {
    const review = entry.review ?? null;
    const login = review ? review.author?.login ?? "ghost" : entry.threads[0]?.comments[0]?.author ?? "ghost";
    const look = review ? REVIEW_LOOK[review.state] ?? REVIEW_LOOK.COMMENTED : THREAD_LOOK;
    const body = review ? cleanBody(review.body) : "";
    const url = review?.url ?? null;
    return div()
      .flex()
      .gap(12)
      .child(
        v_flex()
          .w(28)
          .flex_none()
          .items_center()
          .gap(6)
          .child(
            div()
              .relative()
              .size(28)
              .flex_none()
              .child(avatar(t, login, 28))
              .child(h_flex().absolute().right(-4).bottom(-4).size(14).rounded(7).items_center().justify_center().border_1().border_color(t.popover).bg(tone(t, look.tone)).child(svg(ICON(look.icon)).size(9).text_color(t.popover))),
          )
          .when(!last, (el) => el.child(div().flex_1().w(1).bg(t.border))),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(8)
          .pb(8)
          .child(
            h_flex()
              .h(28)
              .gap(6)
              .items_center()
              .child(div().min_w(0).truncate().font_semibold().child(login))
              .child(div().flex_none().text_color(tone(t, look.tone)).child(look.word))
              .child(div().flex_none().text_color(t.dim).child(`· ${ago(entry.at)}`))
              .when(Boolean(review) && entry.threads.length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`· ${entry.threads.length} comment${entry.threads.length === 1 ? "" : "s"}`)))
              .child(div().flex_1())
              .when(Boolean(url), (el) => el.child(iconButton(t, `prs-rv-open-${index}`, "external", "Open review on GitHub", () => openUrl(url)))),
          )
          .when(Boolean(body), (el) => el.child(v_flex().px(14).py(12).gap(8).rounded(10).border_1().border_color(t.border).bg(t.raised).children(this.markdown(t, body.slice(0, 1200), `rv-${index}`, { size: 13, color: t.foreground }))))
          .children(entry.threads.map((thread) => this.threadCard(t, pr, thread, { standalone: !review }))),
      );
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
    return div().on_mouse_down("left", keepFocus).child(Input.new(state).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground));
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
