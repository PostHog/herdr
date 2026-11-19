import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { agents, panes, terminals, run, theme, setAgentOrder, shared, setShared, home, exec } from "herdr";
import { REVIEW_SESSIONS } from "./shared.js";

const AI_TRIAGE = "squirrel.ai-triage";
const AI_FEEDBACK = "squirrel.ai-triage-feedback";
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
    const prompt = ownPrompt ?? `Load my ${skill} skill from the PostHog MCP (learn project:${skill}) and use it on ${pr.url}. `
      + "Check every claim against the code before you state it; if you haven't checked something, say so or leave it out. "
      + "Label opinion as opinion. Be clear, concise and direct: answer first, no filler, no recap, no pedantry.";
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
    const prev = marks[pr.url];
    this.undo.push({ number: pr.number, label: { done: "Done", watch: "Watch" }[mode] ?? "untick", restore: () => {
      const now = { ...(shared(TRIAGED) ?? {}) };
      if (prev === undefined) delete now[pr.url]; else now[pr.url] = prev;
      setShared(TRIAGED, now);
    } });
    if (mode === "done") marks[pr.url] = Date.now();
    else if (mode === "watch") marks[pr.url] = { at: Date.now(), watch: true };
    else delete marks[pr.url];
    setShared(TRIAGED, marks);
    // Confetti when this clears the list. Checked on save, not on click, so fast clicks on the last few rows
    // (each still fading when the next is clicked) still count: those were all marked in the last minute.
    const fresh = (v) => (typeof v === "number" ? v : v?.at ?? 0) > Date.now() - 60000;
    if (mode && open.some((o) => o.url === pr.url) && open.every((o) => o.url === pr.url || (!this.leaving[o.url] && fresh(marks[o.url]))))
      run("mod.open", { name: "squirrel-confetti" });
  },

  // Clicking an AI tag flips it to your call; clicking again hands the call back to the AI. A flip or a
  // note becomes an example for the next tags.
  correctTag(p) {
    const tag = (shared(AI_TRIAGE) ?? {})[p.url];
    if (!tag) return;
    this.undo.push({ number: p.number, label: "tag change", restore: () => this.saveTag(p, tag) });
    this.saveTag(p, tag.corrected
      ? { ...tag, verdict: tag.aiVerdict, reason: tag.aiReason, corrected: false }
      : { ...tag, verdict: tag.verdict === "needs" ? "skip" : "needs", aiVerdict: tag.verdict, aiReason: tag.reason, reason: `Your call (AI said: ${tag.reason})`, corrected: true });
  },

  saveNote(p, text) {
    const tag = (shared(AI_TRIAGE) ?? {})[p.url], note = text.trim().slice(0, 300).replace(/[\uD800-\uDBFF]$/, "");
    if (tag && (tag.note ?? "") !== note) this.saveTag(p, { ...tag, note });
  },

  saveTag(p, tag) {
    setShared(AI_TRIAGE, { ...(shared(AI_TRIAGE) ?? {}), [p.url]: tag });
    const feedback = (shared(AI_FEEDBACK) ?? []).filter((f) => f.url !== p.url);
    if (tag.corrected || tag.note) feedback.push({ url: p.url, title: p.title, verdict: tag.verdict,
      aiVerdict: tag.corrected ? tag.aiVerdict : tag.verdict, aiReason: tag.corrected ? tag.aiReason : tag.reason, note: tag.note || undefined, at: Date.now() });
    setShared(AI_FEEDBACK, feedback.slice(-200));
  },

  // InputState can't be made during render, so the click that shows the note box makes it.
  noteState(p) {
    this.notes ??= {};
    if (this.notes[p.url] || !(shared(AI_TRIAGE) ?? {})[p.url]) return;
    const s = InputState.new({ placeholder: "Why? Optional, steers the next tags", value: (shared(AI_TRIAGE) ?? {})[p.url].note ?? "" });
    // Saves a moment after you stop typing.
    s.on("change", (_e, cx) => {
      const typed = s.value();
      cx.spawn(async (cx) => { await cx.sleep(800); if (s.value() === typed) this.saveNote(p, typed); });
    });
    s.on("submit", () => this.saveNote(p, s.value()));
    s.on("blur", () => this.saveNote(p, s.value()));
    this.notes[p.url] = s;
  },

  aiTag(p, tag, key, c, t) {
    const care = tag.verdict === "needs";
    return div().id(`ai-${key}`).flex_none().cursor_pointer()
      .tooltip(`${tag.reason}${tag.note ? `\nYour note: ${tag.note}` : ""}\nClick to ${tag.corrected ? "hand it back to the AI" : "flip it"}`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.correctTag(p); this.noteState(p); this.expanded[key] = true; cx.notify(); })
      .child(c.tag(`${care ? "You care" : "Not important"}${tag.corrected ? " ✓" : ""}`, care ? c.yellow : t.dim, Boolean(tag.corrected)));
  },

  // The tag's reason and the note box, for a row's detail. Returns the extra height with the lines.
  aiLines(p, tag, t, c) {
    if (!tag) return { lines: [], extra: 0 };
    const lines = [div().text_color(tag.verdict === "needs" ? c.yellow : t.dim).child(`${tag.verdict === "needs" ? "You care" : "Not important"}: ${tag.reason}`)];
    const s = this.notes?.[p.url];
    if (!s) return { lines, extra: 0 };
    lines.push(div().id(`note-${p.url}`).h(26).max_w(560).rounded(5).border_1().border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation())
      .child(Input.new(s).h(24).px(4).bg(t.background).text_size(11.5).text_color(t.foreground)));
    return { lines, extra: 26 - LINE };
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
    const ai = p.mine ? { lines: [], extra: 0 } : this.aiLines(p, (shared(AI_TRIAGE) ?? {})[p.url], t, c);
    lines.push(...ai.lines);
    if (!p.activity.length) lines.push(div().text_color(t.dim).child("No comments yet"));
    for (const a of p.activity) {
      lines.push(h_flex().id(`act-${p.number}-${a.at}`).gap(6).min_w(0).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(a.url); })
        .child(div().flex_none().w(110).truncate().text_color(a.mentionsMe ? t.accent : t.muted).child(a.who))
        .child(div().flex_none().w(36).text_color(t.dim).child(ago(Date.parse(a.at))))
        .when(Boolean(a.state && a.state !== "COMMENTED"), (el) => el.child(c.tag(a.state === "APPROVED" ? "approved" : "changes", a.state === "APPROVED" ? c.green : c.red)))
        .child(div().flex_1().min_w(0).truncate().text_color(a.mentionsMe ? t.foreground : t.muted).child(a.text)));
    }
    return { height: 10 + lines.length * LINE + ai.extra, el: v_flex().pl(30).pr(12).pb(6).pt(2).gap(2).text_size(11.5).children(lines) };
  },

  reviewsView(t, gh) {
    const c = this.cells(t);
    const marks = shared(TRIAGED) ?? {}, aiTags = shared(AI_TRIAGE) ?? {};
    const prs = gh.prs ?? [];
    const back = new Map(prs.map((p) => [p.url + p.number, this.resurfaced(p, marks[p.url])]));
    const isDone = (p) => Boolean(marks[p.url]) && !back.get(p.url + p.number);
    // You care (asked by name, tagged You care, or not tagged yet): approved with CI passed, then CI passed, then the rest.
    // Not important last. Longest waiting first in each group.
    const group = (p) => p.mine || aiTags[p.url]?.verdict !== "skip" ? (p.ci !== "SUCCESS" ? 2 : p.review === "APPROVED" ? 0 : 1) : 3;
    // The order is set when GitHub data arrives, so a click (a tag flip) never moves rows under the pointer.
    if (this.reviewOrder?.at !== gh.at) this.reviewOrder = { at: gh.at,
      pos: new Map(prs.slice().sort((a, b) => group(a) - group(b) || Date.parse(a.requestedAt) - Date.parse(b.requestedAt)).map((p, i) => [p.url, i])) };
    const sorted = prs.slice().sort((a, b) => (this.reviewOrder.pos.get(a.url) ?? 1e9) - (this.reviewOrder.pos.get(b.url) ?? 1e9));
    const open = sorted.filter((p) => !isDone(p)), done = sorted.filter(isDone);
    const prW = Math.ceil(Math.max(2 * 6.2, ...prs.map((p) => `#${p.number}`.length * 7.2))) + 6;
    const sizeW = Math.ceil(Math.max(4 * 6.2, ...prs.map((p) => `+${p.additions} −${p.deletions}`.length * 6.4))) + 6;
    const watching = done.filter((p) => marks[p.url]?.watch).length;
    const rows = this.showTriaged ? [...open, ...done] : open;
    let content = 0;

    const row = (p) => {
      const key = p.url + p.number, expanded = Boolean(this.expanded[key]);
      const triaged = isDone(p), again = back.get(key) ?? (p.rereview ? "new commits" : null);
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
          .on_click((_e, cx) => { this.expanded[key] = !expanded; if (!p.mine) this.noteState(p); cx.notify(); })
          .child(h_flex().w(22).flex_none().gap(3).items_center()
            .child(svg(`mods/squirrel-panel/${expanded ? "chevron-down" : "chevron-right"}.svg`).size(11).text_color(t.dim)).child(dot))
          .child(c.review(p)).child(c.ci(p)).child(c.link(p, prW))
          .child(h_flex().flex_1().min_w(0).gap(5).items_center()
            .when(p.mine, (el) => el.child(c.tag("@you", t.accent, true)))
            .when(Boolean(again), (el) => el.child(c.tag(`↻ ${again}`, c.yellow, false)))
            .when(p.mentioned, (el) => el.child(c.tag("mentioned", t.accent, false)))
            .when(!p.mine && Boolean(aiTags[p.url]) && (aiTags[p.url].sha === p.headSha || aiTags[p.url].corrected), (el) => el.child(this.aiTag(p, aiTags[p.url], key, c, t)))
            .child(div().id(`title-r0-${p.url}`).tooltip(p.title).flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).when(p.myReview === null, (el) => el.font_semibold()).child(p.title)))
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

    // Merged without my review though I was asked by name, or a team request tagged likely mine. Shown only while one is unchecked.
    // Newest merge first. Ones a teammate approved or the AI called not important are dimmed.
    const rank = (p) => (p.coveredBy?.length ? 2 : 0) + (aiTags[p.url]?.verdict === "skip" ? 1 : 0);
    const skipped = (gh.skipped ?? []).filter((p) => !marks[p.url] || this.leaving[p.url]).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    // Click a row to see why it's here: who asked for me by name and when, and who reviewed instead.
    const skippedWhy = (p) => {
      const lines = [
        ...p.askedMe.map((a, i) => div().id(`asked-${p.url}-${i}`).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(p.url); })
          .child(`${a.by}${a.by === p.author ? " (author)" : ""} requested your review on GitHub ${ago(Date.parse(a.at))} ago`)),
        ...(p.askedMe.length ? [] : (p.askedTeams ?? []).map((a) => div().text_color(t.muted).child(`${a.team} asked to review ${ago(Date.parse(a.at))} ago`))),
        ...this.aiLines(p, aiTags[p.url], t, c).lines,
        ...(p.mentions ?? []).map((m, i) => h_flex().id(`mention-${p.url}-${i}`).gap(6).min_w(0).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(m.url); })
          .child(div().flex_none().text_color(t.accent).child(`${m.who} mentioned you ${ago(Date.parse(m.at))} ago:`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(m.text))),
        ...p.reviews.map((r) => div().text_color(t.dim).child(`${r.who} ${r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "requested changes" : "commented"} ${ago(Date.parse(r.at))} ago`)),
        div().text_color(t.dim).child(`Merged${p.mergedBy && p.mergedBy !== "trunk-io" ? ` by ${p.mergedBy}` : ""} ${ago(Date.parse(p.mergedAt))} ago`),
      ];
      const extra = aiTags[p.url] && this.notes?.[p.url] ? 26 - LINE : 0;
      return { height: 10 + lines.length * LINE + extra, el: v_flex().pl(30).pr(12).pb(6).pt(2).gap(2).text_size(11.5).children(lines) };
    };
    const skippedRow = (p) => {
      const key = `skipped:${p.url}`, expanded = Boolean(this.expanded[key]);
      const leaving = this.leaving[p.url];
      const out = leaving ? Math.min(1, Math.max(0, (Date.now() - leaving.start - 150) / (LEAVE_MS - 150))) : 0;
      const ease = out * out * (3 - 2 * out);
      const detail = expanded ? skippedWhy(p) : null;
      content += (ROW + (detail?.height ?? 0)) * (1 - ease);
      return v_flex().when(Boolean(leaving), (el) => el.h((ROW + (detail?.height ?? 0)) * (1 - ease)).overflow_hidden().opacity(1 - ease))
        .child(h_flex().id(`skipped-${p.url}`).h(ROW).px(6).gap(8).items_center().min_w(0).rounded(4)
          .when(expanded, (el) => el.bg(t.surface))
          .hover((s) => s.bg(t.hover)).cursor_pointer()
          .on_click((_e, cx) => { this.expanded[key] = !expanded; this.noteState(p); cx.notify(); })
          .child(h_flex().w(22).flex_none().items_center()
            .child(svg(`mods/squirrel-panel/${expanded ? "chevron-down" : "chevron-right"}.svg`).size(11).text_color(t.dim)))
          .child(c.chip(116, "Merged", c.green)).child(div().w(70).flex_none()).child(c.link(p, prW))
          .child(h_flex().flex_1().min_w(0).gap(5).items_center()
            .when(Boolean(aiTags[p.url]), (el) => el.child(this.aiTag(p, aiTags[p.url], key, c, t)))
            .when(Boolean(p.coveredBy?.length), (el) => el.child(c.tag(`✓ ${p.coveredBy.map((l) => settings().nicknames?.[l] ?? l).join(", ")}`, c.green, false)))
            .child(div().id(`title-r1-${p.url}`).tooltip(p.title).flex_1().min_w(0).truncate().text_size(12.5).text_color(rank(p) ? t.muted : t.foreground).child(p.title)))
          .child(c.cell(110, p.author, t.muted))
          .child(c.cell(52, ago(Date.parse(p.mergedAt)), c.green))
          .child(div().w(36).flex_none()).child(div().w(52).flex_none())
          .child(c.size(p, sizeW))
          .child(this.iconButton(`review-skipped-${p.url}`, "mods/squirrel-panel/open-pane.svg", (_e, cx) => this.review(p, cx), t,
            { spin: this.starting[p.url], color: this.reviewPane(p) ? t.accent : t.muted }))
          .child(this.checkbox(`seen-${p.url}`, Boolean(leaving), (cx) => this.triage(p, "done", [], cx), t, "Seen: hide it"))
          .child(div().w(44).flex_none()))
        .when(Boolean(detail), (el) => el.child(detail.el));
    };
    const skippedHeader = h_flex().flex_none().h(COLS).px(6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(c.head(22, "")).child(c.head(116, "STATUS")).child(c.head(70, "")).child(c.head(prW, "PR")).child(c.headFlex("MERGED WITHOUT YOUR REVIEW"))
      .child(c.head(110, "AUTHOR")).child(c.head(52, "MERGED")).child(c.head(36, "")).child(c.head(52, ""))
      .child(c.head(sizeW, "SIZE")).child(c.head(28, "CC", true)).child(c.head(44, "SEEN", true)).child(c.head(44, ""));

    const body = v_flex().px(4).py(2)
      .when(Boolean(gh.at) && open.length === 0, (el) => el.child(div().px(8).h(ROW).flex().items_center().text_size(12).text_color(t.dim).child("Nothing waiting on you")))
      .children(rows.map(row))
      .when(skipped.length > 0, (el) => el.child(div().h(9).flex().items_center().child(div().w_full().h(2).bg(t.border)))
        .child(skippedHeader).children(skipped.map(skippedRow)))
      .when(done.length > 0, (el) => el.child(div().id("show-triaged").px(8).h(ROW).flex().items_center().text_size(11).text_color(t.dim)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.showTriaged = !this.showTriaged; cx.notify(); })
        .child(`${this.showTriaged ? "Hide" : "Show"} ${done.length} triaged (${watching} watching)`)));
    if (skipped.length) content += COLS + 9;
    if (done.length) content += ROW;
    if (gh.at && open.length === 0) content += ROW;
    return { columns, body, content: Math.max(content, ROW) };
  },
};
