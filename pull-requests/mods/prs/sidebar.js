import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run } from "herdr";
import { comparePriority } from "./github.js";
import { LISTING_CAP } from "./trunk.js";
import { step, queueFor, stackGroups, layerWaitingOn, visualAsks, fixable } from "./steps.js";
import { CLAUDE_ICON } from "./claude.js";
import { ago, tone, button, actionButton, badge, gateStrip, titleText, TEXT } from "./ui.js";
import { readiness } from "./sheet.js";
import { mergesThroughQueue } from "./actions.js";

const ICON = (name) => `mods/prs/icons/${name}.svg`;

export function icon(t, name, toneName, size = 13, spin = false) {
  const el = svg(ICON(name)).size(size).flex_none().text_color(tone(t, toneName));
  return spin ? el.spin(900) : el;
}

export const SIDEBAR_TABS = [
  { id: "mine", label: "Mine", icon: "pr" },
  { id: "queue", label: "Queue", icon: "queue" },
  { id: "reviews", label: "Review", icon: "eye" },
];

function tinyButton(t, id, label, onClick, primary = false, extra = {}) {
  return button(t, id, label, onClick, { small: true, primary, ...extra });
}

const VISUAL_ICONS = { storybook: "book", playwright: "drama" };

export function stat(t, iconName, text, toneName = "dim") {
  return h_flex().gap(3).flex_none().items_center().child(icon(t, iconName, toneName, 11)).child(div().text_size(TEXT.meta).text_color(tone(t, toneName)).child(text));
}

export function progressBar(t, run) {
  if (!run?.checks?.total) return null;
  const done = run.checks.passed + run.checks.failed;
  return h_flex()
    .w_full()
    .h(3)
    .rounded(2)
    .overflow_hidden()
    .bg(t.border)
    .child(div().h_full().w(`${Math.round((done / run.checks.total) * 100)}%`).bg(run.checks.failed ? tone(t, "bad") : tone(t, "run")));
}

export function foldHeader(view, t, id, label, count, right) {
  const folded = view.folded.has(id);
  return h_flex()
    .id(`prs-fold-${id}`)
    .px(6)
    .pt(9)
    .pb(3)
    .gap(4)
    .items_center()
    .cursor_pointer()
    .on_click((_e, cx) => view.toggleFold(id, cx))
    .child(icon(t, folded ? "chevron-right" : "chevron-down", "dim", 11))
    .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(label.toUpperCase()))
    .when(count !== null && count !== undefined, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(count))))
    .child(div().flex_1())
    .when(Boolean(right), (el) => el.child(right));
}

export function nextFor(view, pr, group) {
  const trunk = view.trunk;
  const entry = queueFor(pr, group, trunk);
  let next = step(pr, entry, trunk);
  const waitingOn = next.ready && group && group.members.length > 1 ? layerWaitingOn(group, pr, trunk) : null;
  if (waitingOn) next = { icon: "hourglass", tone: "warn", label: `Waiting on #${waitingOn} below` };
  return { next, entry };
}

export function gatesFor(view, pr, group, scope = "mine") {
  const { gates } = readiness(pr, null, { queueBased: mergesThroughQueue(pr) });
  if (scope !== "mine") return gates;
  const { next, entry } = nextFor(view, pr, group);
  if (!entry) return gates;
  return gates.map((gate) => (gate.id === "queue" ? { ...gate, state: next.tone === "dim" ? "warn" : next.tone, sub: next.label } : gate));
}

export function needsYou(view, pr, group) {
  if (!pr.mine) return false;
  const { next, entry } = nextFor(view, pr, group);
  return pr.isDraft || visualAsks(pr).length > 0 || Boolean(next.requeue) || fixable(pr) || Boolean(next.ready && !entry);
}

export function splitByNeed(view, groups) {
  const needs = groups.filter((group) => group.members.some((member) => needsYou(view, member.pr, group)));
  return [
    { id: "needs", label: "Needs you", groups: needs },
    { id: "waiting", label: "Waiting on others", groups: groups.filter((group) => !needs.includes(group)) },
  ].filter((part) => part.groups.length);
}

export function priorityBadge(t, pr) {
  const chip = pr.priority?.chip;
  return chip ? badge(t, chip.label, chip.points > 0 ? "ok" : "dim") : null;
}

export function rowButtons(view, t, pr, { scope, next, entry, group }) {
  const buttons = [];
  if (scope !== "mine" || !next) return buttons;
  for (const ask of visualAsks(pr)) buttons.push(tinyButton(t, `prs-b-vis-${pr.number}-${ask.type}`, "Approve", () => view.act("openUrl", { ...pr, url: ask.url }), true, { icon: VISUAL_ICONS[ask.type] ?? "eye", tooltip: `Approve ${ask.type} changes: ${ask.summary}` }));
  if (pr.isDraft && pr.mine) buttons.push(actionButton(t, `prs-b-ready-${pr.number}`, "pr", "Mark ready for review", () => view.act("markReady", pr), "ok"));
  if (next.ready && (!group || group.members.length === 1) && !entry) buttons.push(actionButton(t, `prs-b-merge-${pr.number}`, "merged", mergesThroughQueue(pr) ? "Send to queue…" : "Merge…", () => view.act("merge", pr), "ok"));
  if (next.requeue) buttons.push(actionButton(t, `prs-b-again-${pr.number}`, "merged", mergesThroughQueue(pr) ? "Send to queue again…" : "Merge again…", () => view.act("merge", pr), "ok"));
  if (fixable(pr)) buttons.push(actionButton(t, `prs-b-fix-${pr.number}`, "wrench", "Fix with Claude", () => view.act("fix", pr), "merged"));
  return buttons;
}

export function statusLine(view, t, pr, { scope = "mine", group = null, buttons = true } = {}) {
  const { next, entry } = scope === "mine" ? nextFor(view, pr, group) : { next: null, entry: null };
  const ci = pr.checks.total && next?.icon !== "spinner" ? stat(t, pr.checks.failed ? "fail" : "check", `${pr.checks.passed}/${pr.checks.total}`, pr.checks.failed ? "bad" : "dim") : null;
  const priority = scope !== "mine" ? priorityBadge(t, pr) : null;
  return h_flex()
    .gap(7)
    .items_center()
    .flex_wrap()
    .when(Boolean(next), (el) => el.child(div().flex_none().text_size(TEXT.chip).text_color(tone(t, next.tone)).child(next.label)))
    .when(Boolean(priority), (el) => el.child(priority))
    .when(scope !== "mine", (el) => el.child(div().flex_none().text_size(TEXT.meta).text_color(t.dim).child(`@${pr.author} · ${ago(pr.createdAt)}`)))
    .when(Boolean(ci), (el) => el.child(ci))
    .when(pr.approvals > 0, (el) => el.child(stat(t, "approved", String(pr.approvals), "ok")))
    .when(pr.threads.total > 0, (el) => el.child(stat(t, "comment", String(pr.threads.total), "warn")))
    .when(Boolean(pr.watching && !pr.mine), (el) => el.child(stat(t, "eye", "watching", "info")))
    .when(buttons, (el) => el.children(rowButtons(view, t, pr, { scope, next, entry, group })));
}

export function prIcon(view, t, pr, { scope = "mine", group = null } = {}) {
  const next = scope === "mine" ? nextFor(view, pr, group).next : null;
  return icon(t, next?.icon ?? (pr.isDraft ? "pr-draft" : "pr"), next?.tone ?? "muted", 13, Boolean(next?.spin));
}

export function progressLine(view, t, pr, group) {
  const { next } = nextFor(view, pr, group);
  if (!(next?.progress?.checks?.total > 0)) return null;
  const run = next.progress;
  return v_flex()
    .gap(2)
    .child(progressBar(t, run))
    .child(div().text_size(TEXT.section).text_color(t.dim).child(`${run.checks.passed + run.checks.failed}/${run.checks.total} checks · started ${ago(new Date(next.since ?? run.started).toISOString())}`));
}

function hoverIcon(t, id, glyph, tip, onClick) {
  return div().id(id).p(2).rounded(4).flex_none().cursor_pointer().text_color(t.dim)
    .hover((el) => el.bg(t.raised).text_color(t.foreground))
    .tooltip(tip)
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick();
    })
    .child(glyph);
}

function linkIcons(view, t, id, pr) {
  return h_flex()
    .flex_none()
    .gap(2)
    .items_center()
    .child(hoverIcon(t, `${id}-claude`, image(CLAUDE_ICON).size(13), "Claude Code on this PR", () => view.act("claude", pr)))
    .child(hoverIcon(t, `${id}-copy`, svg(ICON("copy")).size(13), "Copy as Markdown link", () => view.act("copyLink", pr)))
    .child(hoverIcon(t, `${id}-open`, svg(ICON("external")).size(13), "Open on GitHub", () => view.act("open", pr)));
}

function prRow(view, t, pr, { depth = 0, group = null, scope = "mine", quiet = false, showRepo = false } = {}) {
  const progress = scope === "mine" ? progressLine(view, t, pr, group) : null;
  const id = `prs-sb-${scope}-${pr.repo}-${pr.number}`;
  return v_flex()
    .id(id)
    .pl(8 + depth * 12)
    .pr(8)
    .py(5)
    .gap(3)
    .rounded(7)
    .cursor_pointer()
    .hover((el) => el.bg(t.hover))
    .on_hover((on, cx) => view.hover(id, on, cx))
    .on_click(() => view.act("details", pr))
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      view.menu(pr, scope);
    })
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(prIcon(view, t, pr, { scope, group }))
        .child(div().flex_none().text_size(TEXT.meta).text_color(t.dim).child(`${showRepo ? pr.repo.split("/")[1] : ""}#${pr.number}`))
        .child(titleText(t, pr.title, { quiet }))
        .when(view.isBusy(pr), (el) => el.child(icon(t, "spinner", "dim", 11, true)))
        .when(view.hovered === id, (el) => el.child(linkIcons(view, t, id, pr))),
    )
    .child(div().pl(19).child(gateStrip(t, id, gatesFor(view, pr, group, scope))))
    .child(div().pl(19).child(statusLine(view, t, pr, { scope, group })))
    .when(Boolean(progress), (el) => el.child(div().pl(19).child(progress)));
}

export function stackHeader(view, t, group) {
  const trunk = view.trunk;
  const top = group.members.at(-1).pr;
  const steps = group.members.map((member) => step(member.pr, queueFor(member.pr, group, trunk), trunk));
  const ready = steps.filter((item) => item.ready).length;
  const queued = trunk?.items?.[top.number];
  const all = ready === group.members.length;
  return h_flex()
    .id(`prs-stack-${group.id}`)
    .px(8)
    .pt(7)
    .pb(2)
    .gap(6)
    .items_center()
    .child(icon(t, "stack", "merged", 12))
    .child(div().flex_1().min_w(0).truncate().text_size(TEXT.meta).text_color(t.muted).child(`Stack of ${group.members.length} · ${top.headRef}`))
    .child(div().flex_none().text_size(TEXT.meta).text_color(queued ? t.accent : all ? tone(t, "ok") : t.dim).child(queued ? queued.state : `${ready}/${group.members.length} ready`))
    .when(all && !queued && top.mine, (el) => el.child(actionButton(t, `prs-stack-merge-${group.id}`, "merged", "Merge stack…", () => view.act("merge", top), "ok")));
}

export function sidebarMine(view, t) {
  if (!view.mine) return [view.placeholder(t, view.mineError, "Loading your PRs…")];
  const prs = view.applyCommon(view.withDraftsApplied(view.mine.prs));
  if (!prs.length) {
    const drafts = view.hiddenDrafts();
    return [view.placeholder(t, null, drafts ? `No open PRs besides ${drafts} hidden draft${drafts === 1 ? "" : "s"}.` : "No open PRs in your repos.")];
  }
  const groups = stackGroups(prs).sort((a, b) => view.repoIndex(a.repo) - view.repoIndex(b.repo));
  const primaryRepo = groups[0].repo;
  const rows = [];
  for (const part of splitByNeed(view, groups)) {
    const foldId = `mine:${part.id}`;
    rows.push(foldHeader(view, t, foldId, part.label, part.groups.reduce((sum, group) => sum + group.members.length, 0)));
    if (view.folded.has(foldId)) continue;
    for (const group of part.groups) {
      const showRepo = group.repo !== primaryRepo;
      if (group.members.length > 1) {
        rows.push(stackHeader(view, t, group));
        for (const member of [...group.members].reverse()) rows.push(prRow(view, t, member.pr, { depth: 1, group, quiet: !needsYou(view, member.pr, group), showRepo }));
      } else rows.push(prRow(view, t, group.members[0].pr, { group, quiet: part.id === "waiting", showRepo }));
    }
  }
  return rows;
}

const QUEUE_SECTIONS = [
  { id: "testing", label: "Testing", states: ["Testing"] },
  { id: "merging", label: "Merging", states: ["Tests Passed"] },
  { id: "waiting", label: "Waiting", states: ["Pending"], numbered: true },
  { id: "notready", label: "Not ready", states: ["Not Ready"] },
  { id: "failing", label: "Failing", states: ["Pending Failure"] },
  { id: "failed", label: "Failed", states: ["Failed", "Cancelled"] },
  { id: "merged", label: "Recently merged", states: ["Merged"] },
];

const STATE_ICON = { Testing: ["testing", "run"], "Tests Passed": ["rocket", "ok"], Pending: ["hourglass", "accent"], "Not Ready": ["paused", "warn"], "Pending Failure": ["fail", "bad"], Failed: ["fail", "bad"], Cancelled: ["ban", "dim"], Merged: ["merged", "merged"] };

export function sidebarQueue(view, t) {
  const trunk = view.trunk;
  if (!trunk) return [view.placeholder(t, null, "Reading the Trunk merge queue…")];
  if (!trunk.listing) return [view.placeholder(t, trunk.error, "The merge queue isn't available.")];
  const mine = new Set((view.mine?.prs ?? []).filter((pr) => pr.repo === trunk.repo).map((pr) => pr.number));
  const items = trunk.listing.items;
  const rows = [
    h_flex()
      .px(8)
      .pt(6)
      .gap(6)
      .items_center()
      .child(icon(t, "queue", "muted", 12))
      .child(div().text_size(11).text_color(t.muted).child(`${trunk.repo} · ${trunk.listing.branch}`))
      .child(div().flex_1())
      .child(div().text_size(10.5).text_color(trunk.listing.running === "Running" ? tone(t, "ok") : tone(t, "warn")).child(trunk.listing.running)),
  ];
  const yours = items.filter((item) => mine.has(item.number) && item.state !== "Merged");
  const row = (item, index, numbered) => {
    const [iconName, toneName] = STATE_ICON[item.state] ?? ["pr", "muted"];
    const pr = view.findPr(trunk.repo, item.number, item.title);
    const id = `prs-q-${item.state}-${item.number}`;
    return h_flex()
      .id(id)
      .px(8)
      .py(4)
      .gap(6)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_hover((on, cx) => view.hover(id, on, cx))
      .on_click(() => view.act("details", pr))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        view.menu(pr, "queue");
      })
      .child(icon(t, iconName, toneName, 12))
      .when(numbered, (el) => el.child(div().w(18).flex_none().text_size(10.5).text_color(t.dim).child(String(index + 1))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${item.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(mine.has(item.number) ? t.foreground : t.muted).child(item.title))
      .when(view.hovered === id, (el) => el.child(linkIcons(view, t, id, pr)));
  };
  if (yours.length) {
    rows.push(foldHeader(view, t, "queue:yours", "Yours", yours.length));
    if (!view.folded.has("queue:yours")) rows.push(...yours.map((item, index) => row(item, index, false)));
  }
  for (const section of QUEUE_SECTIONS) {
    const list = items.filter((item) => section.states.includes(item.state));
    if (!list.length) continue;
    rows.push(foldHeader(view, t, `queue:${section.id}`, section.label, list.length >= LISTING_CAP ? `${LISTING_CAP}+` : list.length));
    if (!view.folded.has(`queue:${section.id}`)) rows.push(...list.map((item, index) => row(item, index, section.numbered)));
  }
  if (rows.length === 1) rows.push(view.placeholder(t, null, "The queue is empty."));
  return rows;
}

export function sidebarReviews(view, t) {
  if (!view.reviews) return [view.placeholder(t, view.reviewsError, "Loading review requests…")];
  const { visible, hidden } = view.reviewsVisible();
  const direct = visible.filter((pr) => pr.via.direct).sort(comparePriority);
  const teams = visible.filter((pr) => !pr.via.direct).sort(comparePriority);
  const rows = [];
  rows.push(foldHeader(view, t, "review:direct", "Requested from you", direct.length));
  if (!view.folded.has("review:direct")) rows.push(...(direct.length ? direct.map((pr) => prRow(view, t, pr, { scope: "reviews" })) : [view.placeholder(t, null, "Nothing asks you directly.")]));
  rows.push(foldHeader(view, t, "review:teams", "Your teams", teams.length));
  if (!view.folded.has("review:teams")) rows.push(...teams.map((pr) => prRow(view, t, pr, { scope: "reviews" })));
  if (hidden.length) {
    rows.push(foldHeader(view, t, "review:hidden", "Hidden", hidden.length));
    if (!view.folded.has("review:hidden")) rows.push(...hidden.map((pr) => prRow(view, t, pr, { scope: "reviews" })));
  }
  return rows;
}

export function sidebarHeader(view, t, counts) {
  const failing = view.failures > 0;
  return h_flex()
    .px(6)
    .pt(6)
    .pb(4)
    .gap(2)
    .items_center()
    .children(
      SIDEBAR_TABS.map((tab) => {
        const on = view.sidebarTab === tab.id;
        return h_flex()
          .id(`prs-sbtab-${tab.id}`)
          .h(24)
          .px(7)
          .gap(4)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.raised))
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => view.setSidebarTab(tab.id, cx))
          .child(icon(t, tab.icon, on ? "foreground" : "muted", 12))
          .child(div().text_size(11.5).text_color(on ? t.foreground : t.muted).child(tab.label))
          .when(Boolean(counts[tab.id]), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(counts[tab.id]))));
      }),
    )
    .child(div().flex_1())
    .when(view.sidebarTab === "mine", (el) => el.child(draftsButton(view, t)))
    .child(h_flex().id("prs-sb-refresh").p(4).rounded(5).cursor_pointer().hover((el) => el.bg(t.hover)).on_click((_e, cx) => view.refreshAll(cx)).child(icon(t, "refresh", failing ? "warn" : "dim", 12, view.loading())))
    .child(h_flex().id("prs-sb-page").px(5).h(20).items_center().rounded(5).cursor_pointer().hover((el) => el.bg(t.hover)).on_click(() => view.openPage()).child(div().text_size(11).text_color(t.dim).child("⤢")));
}

function draftsButton(view, t) {
  const hidden = view.hiddenDrafts();
  const tip = view.hideDrafts
    ? `${hidden} draft${hidden === 1 ? "" : "s"} hidden. Drafts in a stack with a ready-for-review layer stay. Click to show all.`
    : "Click to hide drafts. Drafts in a stack with a ready-for-review layer stay.";
  return h_flex().id("prs-sb-drafts").p(4).rounded(5).cursor_pointer().hover((el) => el.bg(t.hover)).tooltip(tip)
    .on_click((_e, cx) => view.toggleDrafts(cx))
    .child(icon(t, "pr-draft", view.hideDrafts ? "accent" : "dim", 12));
}

export function sidebarRail(view, t, counts) {
  return v_flex()
    .size_full()
    .py(6)
    .gap(8)
    .items_center()
    .children(SIDEBAR_TABS.map((tab) => v_flex().id(`prs-rail-${tab.id}`).items_center().gap(1).cursor_pointer().on_click((_e, cx) => {
      view.setSidebarTab(tab.id, cx);
      view.openPage();
    }).child(icon(t, tab.icon, "muted", 14)).child(div().text_size(9.5).text_color(t.dim).child(String(counts[tab.id] ?? 0)))));
}
