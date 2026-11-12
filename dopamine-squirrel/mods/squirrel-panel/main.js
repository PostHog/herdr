// Dopamine Squirrel's panel under the top bar (cmd-b toggles it, cmd-1/2/3 pick a view).
// Views: Running agents (agents.js), Reviews (reviews.js) and My PRs (my-prs.js). squirrel-topbar
// fetches the PR lists into shared "squirrel.github" every 5 minutes.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, run, theme, shared, setShared } from "herdr";
import { VIEW, GITHUB, TRIAGED, ROW, HEADER, COLS, MAX_ROWS, CARD_W, CARD_H, GAP, ago } from "./shared.js";
import { stepSim } from "./visualizer.js";
import { readContext, readBackground, agentsViews, usageHeight } from "./agents.js";
import { readUsage } from "./usage.js";
import { tableParts } from "./table.js";
import { reviewViews } from "./reviews.js";
import { myPrViews } from "./my-prs.js";

export default class SquirrelPanel extends View {
  init(_props, cx) {
    this.context = {};
    cx.spawn(async (cx) => {
      for (;;) {
        const next = await readContext();
        this.rememberReviewSessions(next.terminals);
        const ids = agents().map((a) => panes().find((p) => p.pane === a.pane)?.terminal).filter(Boolean);
        const bg = await readBackground(ids);
        if (JSON.stringify(bg) !== JSON.stringify(this.background ?? {})) { this.background = bg; cx.notify(); }
        if (JSON.stringify(next) !== JSON.stringify(this.context)) { this.context = next; cx.notify(); }
        await cx.sleep(10000);
      }
    });
    // /usage for each Claude subscription, every 10 minutes (usage.js).
    this.usage = {};
    cx.spawn(async (cx) => {
      for (;;) {
        const next = await readUsage().catch(() => null);
        if (next && Object.keys(next).length) { this.usage = next; cx.notify(); }
        await cx.sleep(10 * 60 * 1000);
      }
    });
    this.width = 0;
    cx.spawn(async (cx) => {
      for (;;) {
        await cx.sleep(60);
        if (this.view() !== "mine" || !(shared(GITHUB)?.merged ?? []).length || !this.vizSize) continue;
        const nowMs = Date.now(), dt = Math.min(0.1, (nowMs - (this.vizAt ?? nowMs)) / 1000);
        this.vizAt = nowMs;
        this.sims ??= {};
        for (const key of ["left", "right"]) this.sims[key] = stepSim(this.sims[key], ...this.vizSize[key], dt);
        cx.notify();
      }
    });
    this.starting = {};
    this.queueBusy = {};
    this.queueError = {};
    this.queueAdded = {};
    this.confirm = {};
    this.expanded = {};
    this.leaving = {};
    this.showTriaged = false;
  }

  view() { const v = shared(VIEW); return v === "reviews" || v === "mine" ? v : "agents"; }

  // Every view sizes the panel to its content.
  fit(view, want) {
    const px = Math.round(want);
    const key = `${view}:${px}`;
    if (key === this.fitted) return;
    this.fitted = key;
    run("layout.resize", { id: "agents-panel", px });
  }

  render() {
    const t = theme();
    const view = this.view();
    const gh = shared(GITHUB) ?? {};
    const marks = shared(TRIAGED) ?? {};
    const reviewCount = (gh.prs ?? []).filter((p) => !p.draft && (!marks[p.url] || this.resurfaced(p, marks[p.url]))).length;
    const tab = (id, label) => h_flex().id(`view-${id}`).h(22).px(8).gap(5).items_center().rounded(4).text_size(11.5)
      .bg(view === id ? t.selected : t.chrome).text_color(view === id ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click(() => setShared(VIEW, id)).child(label);

    let columns = null, body;
    if (view === "agents") {
      body = this.agentsView(t);
      // Cards wrap; size the panel to however many rows they take at this width.
      const perRow = Math.max(1, Math.floor((this.width - GAP * 2 + GAP) / (CARD_W + GAP)));
      const rows = Math.max(1, Math.ceil(agents().length / perRow));
      const strip = usageHeight(this.context.accounts ?? {}, this.usage ?? {});

      if (this.width) this.fit("agents", HEADER + strip + (this.cardsHeight ?? GAP * 2 + rows * CARD_H + (rows - 1) * GAP) + 2);
    }
    else {
      const v = view === "reviews" ? this.reviewsView(t, gh) : this.mineView(t, gh);
      columns = v.columns; body = v.body;
      // Up to MAX_ROWS rows show before the list scrolls under the sticky header.
      this.fit(view, HEADER + COLS + Math.min(v.content, MAX_ROWS * ROW) + 6);
    }

    return v_flex().id("root").size_full().bg(t.chrome).border_b(1).border_color(t.border)
      .on_size_change((size, cx) => {
        if (Math.round(size.width) === this.width) return;
        this.width = Math.round(size.width);
        cx?.notify();
      })
      .child(h_flex().flex_none().h(HEADER).px(6).gap(4).items_center().border_b(1).border_color(t.border)
        .child(tab("agents", this.helperCount ? `Running agents (${agents().length - this.helperCount} + ${this.helperCount} helpers)` : `Running agents (${agents().length})`))
        .child(tab("reviews", `Reviews (${reviewCount})`))
        .child(tab("mine", `My PRs (${(gh.mine ?? []).length})`))
        .child(div().flex_1())
        .when(view !== "agents", (el) => el
          .when(Boolean(gh.error), (el) => el.child(div().text_size(10.5).text_color(t.ansi1).child(gh.error)))
          .child(div().text_size(10.5).text_color(t.dim).child(gh.loading ? "refreshing…" : gh.at ? `updated ${ago(gh.at)} ago` : "loading…"))
          .child(div().id("gh-refresh").h(22).px(6).flex().items_center().rounded(4).text_size(11).text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("squirrel-topbar.gh_refresh")).child("Refresh"))))
      .when(Boolean(columns), (el) => el.child(columns))
      .child(div().id("body").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }
}

Object.assign(SquirrelPanel.prototype, agentsViews, tableParts, reviewViews, myPrViews);
