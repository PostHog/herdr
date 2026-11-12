import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, terminals, run, theme, setAgentOrder, shared, setShared, home, exec } from "herdr";
import { NAMES, VIEW, GITHUB, TRIAGED, REVIEW_PANES, VISITED, ROW, HEADER, COLS, MAX_ROWS, LINE, STALE_MS, CARD_W, CARD_H, GAP, now, settings, ago, order, newest } from "./shared.js";
import { stepSim, drawSim } from "./visualizer.js";

// Runs the trunk CLI from the PostHog checkout: its flox environment's trunk if there is one, else trunk on PATH.
// Needs `trunk login` once.
function trunk(args) {
  const checkout = settings().posthogCheckout.replace(/^~/, home());
  const script = 'cd "$1" && shift && t=$(ls .flox/run/*/bin/trunk 2>/dev/null | head -1); exec "${t:-trunk}" "$@"';
  return exec("/bin/sh", ["-c", script, "sh", checkout, ...args], { timeout: 60000 });
}

// My PRs: three tables on one column grid (in review, merge queue, recently merged) and the visualizer.
export const myPrViews = {
  // Trunk merge queue buttons: Add runs `trunk merge` at once; Remove asks for a second click within 4s.
  queue(p, action, cx) {
    const key = p.url;
    if (this.queueBusy[key]) return;
    if (action === "remove" && !this.confirm[key]) {
      this.confirm[key] = true;
      cx.notify();
      cx.spawn(async (cx) => { await cx.sleep(4000); delete this.confirm[key]; cx.notify(); });
      return;
    }
    delete this.confirm[key];
    delete this.queueError[key];
    this.queueBusy[key] = true;
    cx.notify();
    const args = action === "add" ? ["merge", String(p.number)] : ["merge", "cancel", String(p.number)];
    cx.spawn(async (cx) => {
      const r = await trunk(args).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) this.queueError[key] = (r.stderr || r.stdout || "trunk failed").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop();
      else if (action === "add") this.queueAdded[key] = Date.now();
      delete this.queueBusy[key];
      cx.notify();
      for (const wait of [3000, 20000]) { await cx.sleep(wait); run("squirrel-topbar.gh_refresh"); }
    });
  },

  mineView(t, gh) {
    const c = this.cells(t);
    const all = (gh.mine ?? []).slice().sort(newest);
    // Mutually exclusive: a PR is still in review (first table), in Trunk's queue (second) or merged (third).
    const queued = (p) => ["waiting", "queued", "testing", "failed", "merged"].includes(p.trunk?.state);
    const list = all.filter((p) => !queued(p)), inQueue = all.filter(queued), merged = gh.merged ?? [];
    const QUEUE = {
      none: ["Not queued", t.dim], waiting: ["Waiting on checks", c.yellow], queued: ["In queue", c.blue],
      testing: ["Testing in queue", c.yellow], merged: ["Merged", c.green], failed: ["Failed", c.red], other: ["See Trunk", t.dim],
    };
    const queueAction = (p) => {
      const q = p.trunk, active = ["waiting", "queued", "testing"].includes(q?.state);
      if (active) return "remove";
      return p.repo === "PostHog/posthog" && !p.draft && q?.state !== "merged" ? "add" : null;
    };

    const commentsText = (p) => p.commentCount ? `${p.commentCount} comment${p.commentCount === 1 ? "" : "s"}` : "";
    // All three tables share one column grid; text columns are sized to their longest value.
    const repoName = (p) => p.repo.replace(/^PostHog\//, "");
    const sizeText = (p) => `+${p.additions} −${p.deletions}`;
    const rowsAll = [...list, ...inQueue, ...merged];
    const fit = (texts, label, perChar = 6.6) => Math.ceil(Math.max(label.length * 6.2, ...texts.map((x) => x.length * perChar))) + 6;
    const W = {
      repo: fit(rowsAll.map(repoName), "REPO"), status: 116, ci: 70, pr: fit(rowsAll.map((p) => `#${p.number}`), "PR", 7.2),
      note: Math.min(220, Math.max(0, ...[
        ...list.map((p) => (p.approvals ? `${p.approvals} approved  ` : "") + (p.openThreads ? `${p.openThreads} open threads  ` : "") + commentsText(p)),
        ...inQueue.map((p) => this.queueError[p.url] ?? p.trunk?.text ?? ""),
      ].map((x) => x.trim() ? x.length * 6.4 + 6 : 0), 76)), act: 52, age: 36, when: 52, size: fit(rowsAll.map(sizeText), "SIZE", 6.4), cc: 28,
      merge: [...list, ...inQueue].some(queueAction) ? 96 : 0,
    };

    const ccButton = (p) => this.iconButton(`mine-review-${p.url}`, "mods/squirrel-panel/open-pane.svg", (_e, cx) => this.review(p, cx), t,
      { spin: this.starting[p.url], color: this.reviewPane(p) ? t.accent : t.muted });
    const queueButton = (p) => {
      const key = p.url, action = queueAction(p);
      if (!W.merge) return null;
      if (!action) return div().w(W.merge).flex_none();
      const confirming = this.confirm[key], busy = this.queueBusy[key];
      return h_flex().id(`queue-${key}`).w(W.merge).flex_none().h(20).justify_center().items_center().rounded(4).border(1).text_size(11)
        .border_color(confirming ? (action === "add" ? c.green : c.red) : t.border)
        .text_color(confirming ? (action === "add" ? c.green : c.red) : t.muted)
        .hover((s) => s.bg(t.raised).text_color(t.foreground)).cursor_pointer()
        .on_click((_e, cx) => this.queue(p, action, cx))
        .child(busy ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900)
          : this.queueAdded?.[key] && Date.now() - this.queueAdded[key] < 20000 ? "Added ✓"
          : confirming ? "Click to confirm" : action === "add" ? "Add to queue" : "Remove");
    };
    const note = (p, kind) => {
      if (kind === "review") return h_flex().w(W.note).flex_none().gap(8).text_size(11).min_w(0)
        .when(p.approvals > 0, (el) => el.child(div().flex_none().text_color(c.green).child(`${p.approvals} approved`)))
        .when(p.openThreads > 0, (el) => el.child(div().flex_none().text_color(c.yellow).child(`${p.openThreads} open threads`)))
        .when(p.commentCount > 0, (el) => el.child(div().flex_none().text_color(t.accent).child(commentsText(p))));
      if (kind === "queue") {
        const q = p.trunk, error = this.queueError[p.url];
        return div().id(`trunk-note-${p.url}`).w(W.note).flex_none().truncate().text_size(11).text_color(error ? c.red : t.dim)
          .tooltip(error ?? q?.text ?? "")
          .when(Boolean(q?.url) && !error, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(q.url); }))
          .child(error ?? q?.text ?? "");
      }
      return div().w(W.note).flex_none();
    };
    // Click an open PR's row to read its open threads and the latest comments from others.
    let extra = 0;
    const details = (p) => {
      const line = (a, tagText) => h_flex().id(`mine-act-${p.number}-${a.at}`).gap(6).min_w(0).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(a.url); })
        .child(div().flex_none().w(110).truncate().text_color(t.muted).child(a.who))
        .child(div().flex_none().w(36).text_color(t.dim).child(ago(Date.parse(a.at))))
        .when(Boolean(tagText), (el) => el.child(c.tag(tagText, c.yellow, false)))
        .when(Boolean(a.state && a.state !== "COMMENTED"), (el) => el.child(c.tag(a.state === "APPROVED" ? "approved" : "changes", a.state === "APPROVED" ? c.green : c.red)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(a.path ? `${a.path.split("/").pop()}: ${a.text}` : a.text));
      const lines = [
        ...(p.threads ?? []).map((a) => line(a, "open")),
        ...(p.activity ?? []).map((a) => line(a, null)),
      ];
      if (!lines.length) lines.push(div().text_color(t.dim).child("No comments yet"));
      extra += 10 + lines.length * LINE;
      return v_flex().pl(16).pr(12).pb(6).pt(2).gap(2).text_size(11.5).children(lines);
    };
    const row = (p, kind) => {
      const key = `mine:${p.url}`, open = kind !== "merged" && Boolean(this.expanded[key]);
      return v_flex().child(rowLine(p, kind, key, open)).when(open, (el) => el.child(details(p)));
    };
    const rowLine = (p, kind, key, open) => {
      const [qLabel, qColor] = QUEUE[p.trunk?.state ?? "none"];
      const when = kind === "merged" ? p.mergedAt : kind === "queue" ? p.trunk?.at : p.updated;
      return h_flex().id(`${kind}-${p.url}`).h(ROW).px(6).gap(8).items_center().min_w(0).rounded(4).hover((s) => s.bg(t.hover))
        .when(open, (el) => el.bg(t.surface))
        .when(kind !== "merged", (el) => el.cursor_pointer().on_click((_e, cx) => { this.expanded[key] = !open; cx.notify(); }))
        .child(c.cell(W.repo, repoName(p), t.muted))
        .child(kind === "review" ? c.review(p) : kind === "queue" ? c.chip(W.status, qLabel, qColor) : div().w(W.status).flex_none())
        .child(kind === "merged" ? div().w(W.ci).flex_none() : c.ci(p))
        .child(c.link(p, W.pr))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(p.title))
        .child(note(p, kind))
        .child(c.cell(W.act, p.newActivity ? `${p.newActivity} new` : "", t.accent))
        .child(c.cell(W.age, ago(Date.parse(p.created))))
        .child(c.cell(W.when, when ? ago(Date.parse(when)) : "", kind === "merged" ? c.green : t.dim))
        .child(c.size(p, W.size))
        .child(kind === "merged" ? div().w(W.cc).flex_none() : ccButton(p))
        .when(W.merge > 0, (el) => el.child(kind === "merged" ? div().w(W.merge).flex_none() : queueButton(p)));
    };
    const header = (title, noteLabel, whenLabel, sticky) => h_flex().flex_none().h(COLS).px(sticky ? 10 : 6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(c.head(W.repo, "REPO")).child(c.head(W.status, "STATUS")).child(c.head(W.ci, "CI")).child(c.head(W.pr, "PR")).child(c.headFlex(title))
      .child(c.head(W.note, noteLabel)).child(c.head(W.act, "ACTIVITY")).child(c.head(W.age, "AGE")).child(c.head(W.when, whenLabel))
      .child(c.head(W.size, "SIZE")).child(c.head(W.cc, "CC", true)).when(W.merge > 0, (el) => el.child(c.head(W.merge, "MERGE", true)));
    const empty = (text) => div().px(8).h(ROW).flex().items_center().text_size(12).text_color(t.dim).child(text);

    const body = v_flex().px(4).py(2)
      .when(Boolean(gh.at) && list.length === 0, (el) => el.child(empty("Nothing in review")))
      .children(list.map((p) => row(p, "review")))
      .child(div().h(10)).child(header("MERGE QUEUE", "TRUNK SAYS", "SINCE"))
      .when(inQueue.length === 0, (el) => el.child(empty("Nothing in the merge queue")))
      .children(inQueue.map((p) => row(p, "queue")))
      .child(div().h(10)).child(header("RECENTLY MERGED", "", "MERGED"))
      .when(merged.length === 0, (el) => el.child(empty(`Nothing merged in the last ${gh.mergedDays ?? 7} days`)))
      .when(merged.length > 0, (el) => {
        // Two canvases span the merged rows: one over STATUS+CI, one over CC (+MERGE).
        const H = merged.length * ROW, leftX = 6 + W.repo + 8, leftW = W.status + 8 + W.ci, rightW = W.cc + (W.merge ? 8 + W.merge : 0);
        this.vizSize = { left: [leftW, H], right: [rightW, H] };
        const canvas = (key, x, wd) => div().absolute().top(0).left(x).w(wd).h(H).rounded(4).overflow_hidden().bg("#00000055").children(drawSim(this.sims?.[key], t.dim));
        return el.child(div().relative().children(merged.map((p) => row(p, "merged")))
          .child(canvas("left", leftX, leftW))
          .child(div().absolute().top(0).right(6).w(rightW).h(H).rounded(4).overflow_hidden().bg("#00000055").children(drawSim(this.sims?.right, t.dim))));
      });
    const rows = Math.max(list.length, 1) + Math.max(inQueue.length, 1) + Math.max(merged.length, 1);
    return { columns: header("IN REVIEW", "REVIEWS", "UPD", true), body, content: rows * ROW + 2 * (COLS + 10) + extra };
  },
};
