import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, terminals, run, theme, setAgentOrder, shared, setShared, home, exec } from "herdr";
import { REVIEW_SESSIONS } from "./shared.js";
import { NAMES, VIEW, GITHUB, TRIAGED, REVIEW_PANES, VISITED, ROW, HEADER, COLS, MAX_ROWS, LINE, STALE_MS, CARD_W, CARD_H, GAP, now, settings, ago, order, newest } from "./shared.js";

const LEAVE_MS = 550;

// Reviews: PRs waiting on my review, triage (DONE / WATCH), the Claude review button and confetti.
export const reviewViews = {
  reviewPane(pr) {
    const id = (shared(REVIEW_PANES) ?? {})[pr.url];
    return id ? panes().find((p) => p.pane === id) : null;
  },

  // One Claude pane per PR: a second click focuses it instead of starting another.
  // Remembers the Claude session behind each review pane (from the statusline), so a closed review
  // can be resumed later instead of starting over.
  rememberReviewSessions(terminals) {
    const panesByPr = shared(REVIEW_PANES) ?? {}, saved = shared(REVIEW_SESSIONS) ?? {};
    let changed = false;
    for (const [url, paneId] of Object.entries(panesByPr)) {
      const term = panes().find((p) => p.pane === paneId)?.terminal, live = term && terminals[term];
      if (!live?.sessionId || saved[url]?.sessionId === live.sessionId) continue;
      saved[url] = { sessionId: live.sessionId, cwd: live.cwd };
      changed = true;
    }
    if (changed) setShared(REVIEW_SESSIONS, { ...saved });
  },

  // One Claude pane per PR: a second click focuses it instead of starting another. If that pane was
  // closed, the click resumes its conversation (claude --resume in the folder it ran in).
  review(pr, cx, ownPrompt) {
    const existing = this.reviewPane(pr);
    if (existing) { run("tab.select", { id: existing.tab }); run("pane.focus", { pane: existing.pane }); return; }
    if (this.starting[pr.url]) return;
    this.starting[pr.url] = true;
    cx.notify();
    const before = new Set(panes().map((p) => p.pane));
    const skill = settings().reviewSkill, past = (shared(REVIEW_SESSIONS) ?? {})[pr.url];
    const prompt = ownPrompt ?? `Load my ${skill} skill from the PostHog MCP (learn project:${skill}) and use it on ${pr.url}`;
    const argv = past?.sessionId
      ? ["/bin/sh", "-c", 'cd "$1" 2>/dev/null; exec claude --resume "$2"', "sh", past.cwd ?? home(), past.sessionId]
      : ["claude", prompt];
    run("pane.split", { direction: "down", argv });
    cx.spawn(async (cx) => {
      for (let i = 0; i < 50; i++) {
        const added = panes().find((p) => !before.has(p.pane));
        if (added) {
          setShared(REVIEW_PANES, { ...(shared(REVIEW_PANES) ?? {}), [pr.url]: added.pane });
          setShared(NAMES, { ...(shared(NAMES) ?? {}), [added.pane]: `Review #${pr.number}` });
          break;
        }
        await cx.sleep(100);
      }
      delete this.starting[pr.url];
      cx.notify();
    });
  },

  // mode "done": hidden for good. "watch": hidden until new commits, a new comment or a re-request. null: untriaged.
  // Ticking DONE or WATCH shows the tick, then fades and folds the row away over about half a second
  // before the mark is saved, so the list doesn't jump under the pointer.
  triage(pr, mode, open, cx) {
    if (mode && !this.showTriaged && cx) {
      if (this.leaving[pr.url]) return;
      this.leaving[pr.url] = { mode, start: Date.now() };
      cx.spawn(async (cx) => {
        while (Date.now() - this.leaving[pr.url].start < LEAVE_MS) { await cx.sleep(16); cx.notify(); }
        delete this.leaving[pr.url];
        this.triage(pr, mode, open);
        cx.notify();
      });
      cx.notify();
      return;
    }
    const marks = { ...(shared(TRIAGED) ?? {}) };
    if (mode === "done") marks[pr.url] = Date.now();
    else if (mode === "watch") marks[pr.url] = { at: Date.now(), watch: true };
    else delete marks[pr.url];
    setShared(TRIAGED, marks);
    if (mode && open.length === 1 && open[0].url === pr.url)
      run("mod.open", { name: "squirrel-confetti" });
  },

  // DONE hides a PR for good. WATCH ({at, watch}) brings it back on new commits, a new comment or a re-request.
  resurfaced(p, mark) {
    if (!mark?.watch) return null;
    if (Date.parse(p.requestedAt) > mark.at) return "asked again";
    if (Date.parse(p.headAt) > mark.at) return "new commits";
    if (p.activity.some((a) => Date.parse(a.at) > mark.at)) return "new comment";
    return null;
  },

  details(p, t, c) {
    const lines = [];
    lines.push(div().text_color(t.muted).child(`Waiting on ${p.waiting.join(", ") || "nobody"} · requested ${ago(Date.parse(p.requestedAt))} ago`));
    if (p.notification) lines.push(div().text_color(p.notification.unread ? t.accent : t.dim)
      .child(`GitHub inbox: ${p.notification.reason.replace(/_/g, " ")}${p.notification.unread ? ", unread" : ""}`));
    if (!p.activity.length) lines.push(div().text_color(t.dim).child("No comments yet"));
    for (const a of p.activity) {
      lines.push(h_flex().id(`act-${p.number}-${a.at}`).gap(6).min_w(0).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(a.url); })
        .child(div().flex_none().w(110).truncate().text_color(a.mentionsMe ? t.accent : t.muted).child(a.who))
        .child(div().flex_none().w(36).text_color(t.dim).child(ago(Date.parse(a.at))))
        .when(Boolean(a.state && a.state !== "COMMENTED"), (el) => el.child(c.tag(a.state === "APPROVED" ? "approved" : "changes", a.state === "APPROVED" ? c.green : c.red)))
        .child(div().flex_1().min_w(0).truncate().text_color(a.mentionsMe ? t.foreground : t.muted).child(a.text)));
    }
    return { height: 10 + lines.length * LINE, el: v_flex().pl(30).pr(12).pb(6).pt(2).gap(2).text_size(11.5).children(lines) };
  },

  reviewsView(t, gh) {
    const c = this.cells(t);
    const marks = shared(TRIAGED) ?? {};
    const prs = gh.prs ?? [];
    const back = new Map(prs.map((p) => [p.url + p.number, this.resurfaced(p, marks[p.url])]));
    const isDone = (p) => Boolean(marks[p.url]) && !back.get(p.url + p.number);
    // Asked by name, then back after triage, then newest first.
    const sorted = prs.slice().sort((a, b) => (b.mine - a.mine) || (Boolean(back.get(b.url + b.number)) - Boolean(back.get(a.url + a.number))) || Date.parse(b.created) - Date.parse(a.created));
    const open = sorted.filter((p) => !isDone(p)), done = sorted.filter(isDone);
    const prW = Math.ceil(Math.max(2 * 6.2, ...prs.map((p) => `#${p.number}`.length * 7.2))) + 6;
    const sizeW = Math.ceil(Math.max(4 * 6.2, ...prs.map((p) => `+${p.additions} −${p.deletions}`.length * 6.4))) + 6;
    const watching = done.filter((p) => marks[p.url]?.watch).length;
    const rows = this.showTriaged ? [...open, ...done] : open;
    let content = 0;

    const row = (p) => {
      const key = p.url + p.number, expanded = Boolean(this.expanded[key]);
      const triaged = isDone(p), again = back.get(key);
      const leaving = this.leaving[p.url];
      const mode = leaving ? leaving.mode : !triaged ? null : marks[p.url]?.watch ? "watch" : "done";
      // 0 → 1 while the row leaves: a short pause on the tick, then an eased fade and fold.
      const out = leaving ? Math.min(1, Math.max(0, (Date.now() - leaving.start - 150) / (LEAVE_MS - 150))) : 0;
      const ease = out * out * (3 - 2 * out);
      const pane = this.reviewPane(p), starting = this.starting[p.url];
      const waited = now() - Date.parse(p.requestedAt);
      const stale = waited > STALE_MS && p.review !== "APPROVED" && !p.draft;
      const dot = p.myReview === null ? div().size(7).rounded(4).bg(c.blue)
        : p.myReview === "stale" ? div().size(7).rounded(4).border(1).border_color(c.blue) : div().size(7);
      const detail = expanded ? this.details(p, t, c) : null;
      content += (ROW + (detail?.height ?? 0)) * (1 - ease);
      return v_flex().when(Boolean(leaving), (el) => el.h((ROW + (detail?.height ?? 0)) * (1 - ease)).overflow_hidden().opacity(1 - ease))
        .child(h_flex().id(`pr-${key}`).h(ROW).px(6).gap(8).items_center().min_w(0).rounded(4)
          .when(p.mine, (el) => el.border_l(2).border_color(t.accent))
          .when(Boolean(again), (el) => el.border_l(2).border_color(c.yellow))
          .when(triaged, (el) => el.opacity(0.45))
          .when(expanded, (el) => el.bg(t.surface))
          .hover((s) => s.bg(t.hover)).cursor_pointer()
          .on_click((_e, cx) => { this.expanded[key] = !expanded; cx.notify(); })
          .child(h_flex().w(22).flex_none().gap(3).items_center()
            .child(svg(`mods/squirrel-panel/${expanded ? "chevron-down" : "chevron-right"}.svg`).size(11).text_color(t.dim)).child(dot))
          .child(c.review(p)).child(c.ci(p)).child(c.link(p, prW))
          .child(h_flex().flex_1().min_w(0).gap(5).items_center()
            .when(p.mine, (el) => el.child(c.tag("@you", t.accent, true)))
            .when(Boolean(again), (el) => el.child(c.tag(`↻ ${again}`, c.yellow, false)))
            .when(p.mentioned, (el) => el.child(c.tag("mentioned", t.accent, false)))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).when(p.myReview === null, (el) => el.font_semibold()).child(p.title)))
          .child(c.cell(110, p.author, t.muted))
          .child(div().w(52).flex_none().text_size(11).when(stale, (el) => el.font_semibold()).text_color(stale ? c.red : t.dim).child(ago(Date.parse(p.requestedAt))))
          .child(c.cell(36, ago(Date.parse(p.updated))))
          .child(c.cell(52, p.newActivity ? `${p.newActivity} new` : "", t.accent))
          .child(c.size(p, sizeW))
          .child(this.iconButton(`review-${key}`, "mods/squirrel-panel/open-pane.svg", (_e, cx) => this.review(p, cx), t,
            { spin: starting, color: pane ? t.accent : t.muted }))
          .child(this.checkbox(`done-${key}`, mode === "done", (cx) => this.triage(p, mode === "done" ? null : "done", open, cx), t, "Done: hide it for good"))
          .child(this.checkbox(`watch-${key}`, mode === "watch", (cx) => this.triage(p, mode === "watch" ? null : "watch", open, cx), t,
            "Watch: hide it until new commits, a new comment or you're asked again")))
        .when(Boolean(detail), (el) => el.child(detail.el));
    };

    const columns = h_flex().flex_none().h(COLS).px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(c.head(22, "")).child(c.head(116, "STATUS")).child(c.head(70, "CI")).child(c.head(prW, "PR")).child(c.headFlex("TITLE"))
      .child(c.head(110, "AUTHOR")).child(c.head(52, "WAITING")).child(c.head(36, "UPD")).child(c.head(52, "ACTIVITY"))
      .child(c.head(sizeW, "SIZE")).child(c.head(28, "CC", true)).child(c.head(44, "DONE", true)).child(c.head(44, "WATCH", true));

    const body = v_flex().px(4).py(2)
      .when(Boolean(gh.at) && open.length === 0, (el) => el.child(div().px(8).h(ROW).flex().items_center().text_size(12).text_color(t.dim).child("Nothing waiting on you")))
      .children(rows.map(row))
      .when(done.length > 0, (el) => el.child(div().id("show-triaged").px(8).h(ROW).flex().items_center().text_size(11).text_color(t.dim)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.showTriaged = !this.showTriaged; cx.notify(); })
        .child(`${this.showTriaged ? "Hide" : "Show"} ${done.length} triaged (${watching} watching)`)));
    if (done.length) content += ROW;
    if (gh.at && open.length === 0) content += ROW;
    return { columns, body, content: Math.max(content, ROW) };
  },
};
