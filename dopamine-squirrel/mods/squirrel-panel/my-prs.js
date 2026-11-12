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

const SECTION_GAP = 9;

// My PRs: three tables on one column grid (in review, merge queue, recently merged) and the visualizer.
const CI_PANES = "squirrel.ci-panes";

export const myPrViews = {
  // RFR on a draft: `gh pr ready`, then refresh so the row updates.
  markReady(pr, cx) {
    this.readyBusy ??= {};
    if (this.readyBusy[pr.url]) return;
    this.readyBusy[pr.url] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["pr", "ready", pr.url], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) this.queueError[pr.url] = (r.stderr || "gh pr ready failed").trim().split("\n").pop();
      run("squirrel-topbar.gh_refresh");
      await cx.sleep(4000);
      delete this.readyBusy[pr.url];
      cx.notify();
    });
  },

  // A failing CI chip opens Claude (Opus, high effort) in a pane below, in the PR's checkout, to fix what is
  // obvious or bring back what needs your call. A second click jumps to that pane.
  fixCi(pr, cx) {
    const paneId = (shared(CI_PANES) ?? {})[pr.url], existing = paneId && panes().find((p) => p.pane === paneId);
    if (existing) { run("tab.select", { id: existing.tab }); run("pane.focus", { pane: existing.pane }); return; }
    this.ciStarting ??= {};
    if (this.ciStarting[pr.url]) return;
    this.ciStarting[pr.url] = true;
    cx.notify();
    const checkout = pr.repo === "PostHog/posthog" ? settings().posthogCheckout.replace(/^~/, home()) : home();
    const prompt = `CI is failing on my PR ${pr.url}. Find out why. If the fix is clear and common sense, make it on the PR's branch and tell me what you changed, but don't push. If it needs human judgment or taste, stop and give me a short summary of the failure and the options.`;
    const before = new Set(panes().map((p) => p.pane));
    run("pane.split", { direction: "down", argv: ["/bin/sh", "-c", 'cd "$1" 2>/dev/null; exec claude --model opus --effort high "$2"', "sh", checkout, prompt] });
    cx.spawn(async (cx) => {
      for (let i = 0; i < 50; i++) {
        const added = panes().find((p) => !before.has(p.pane));
        if (added) {
          setShared(CI_PANES, { ...(shared(CI_PANES) ?? {}), [pr.url]: added.pane });
          setShared(NAMES, { ...(shared(NAMES) ?? {}), [added.pane]: `CI #${pr.number}` });
          break;
        }
        await cx.sleep(100);
      }
      delete this.ciStarting[pr.url];
      cx.notify();
    });
  },

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
      run("squirrel-topbar.gh_refresh");
      for (const wait of [3000, 20000]) { await cx.sleep(wait); run("squirrel-topbar.gh_refresh"); }
    });
  },

  mineView(t, gh) {
    const c = this.cells(t);
    const all = (gh.mine ?? []).slice().sort(newest);
    // Mutually exclusive: a PR is still in review (first table), in Trunk's queue (second) or merged (third).
    // Right after Add to queue succeeds, the row moves to the queue table as "Submitted" until Trunk's own
    // comment catches up (or 10 minutes pass), so it never bounces back to "Add to queue".
    const trunkOf = (p) => {
      const added = this.queueAdded[p.url], real = p.trunk;
      if (!added || Date.now() - added > 10 * 60 * 1000 || (real && real.state !== "none" && Date.parse(real.at) >= added - 60000)) return real;
      return { state: "submitted", text: "Added to the queue, waiting for Trunk to confirm", at: new Date(added).toISOString(), url: real?.url ?? null };
    };
    const queued = (p) => ["submitted", "waiting", "queued", "testing", "failed", "merged"].includes(trunkOf(p)?.state);
    const list = all.filter((p) => !queued(p)), inQueue = all.filter(queued), merged = gh.merged ?? [];
    const QUEUE = {
      none: ["Not queued", t.dim], submitted: ["Submitted", c.yellow], waiting: ["Waiting on checks", c.yellow], queued: ["In queue", c.blue],
      testing: ["Testing in queue", c.yellow], merged: ["Merged", c.green], failed: ["Failed", c.red], other: ["See Trunk", t.dim],
    };
    const queueAction = (p) => {
      const q = trunkOf(p), active = ["submitted", "waiting", "queued", "testing"].includes(q?.state);
      if (active) return "remove";
      const landable = p.review === "APPROVED" && !["FAILURE", "ERROR"].includes(p.ci);
      return p.repo === "PostHog/posthog" && !p.draft && landable && q?.state !== "merged" ? "add" : null;
    };

    const reviewBits = (p) => [
      p.approvals ? [`✓${p.approvals}`, c.green, `${p.approvals} approved`] : null,
      p.openThreads ? [`${p.openThreads} open`, c.yellow, `${p.openThreads} open threads`] : null,
      p.commentCount ? [`💬${p.commentCount}`, t.accent, `${p.commentCount} comments from others`] : null,
      p.newActivity ? [`${p.newActivity} new`, t.accent, `${p.newActivity} new since you last looked`] : null,
    ].filter(Boolean);
    // All three tables share one column grid; text columns are sized to their longest value.
    const repoName = (p) => p.repo.replace(/^PostHog\//, "");
    const sizeText = (p) => `+${p.additions} −${p.deletions}`;
    const rowsAll = [...list, ...inQueue, ...merged];
    const fit = (texts, label, perChar = 6.6) => Math.ceil(Math.max(label.length * 6.2, ...texts.map((x) => x.length * perChar))) + 6;
    const W = {
      repo: fit(rowsAll.map(repoName), "REPO"), status: 116, ci: 70, pr: fit(rowsAll.map((p) => `#${p.number}`), "PR", 7.2),
      // Sized to the longest review summary; Trunk's longer message truncates at that width (full text on hover).
      note: Math.min(170, Math.max(64, ...list.map((p) => reviewBits(p).reduce((w, [text]) => w + text.length * 6.6 + 8, 0)))), age: 36, when: 52, size: fit(rowsAll.map(sizeText), "SIZE", 6.4), cc: 28,
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
      if (kind === "review") return h_flex().w(W.note).flex_none().gap(6).text_size(11).min_w(0).overflow_hidden()
        .children(reviewBits(p).map(([text, color, tip], i) => div().id(`bit-${p.url}-${i}`).flex_none().text_color(color).tooltip(tip).child(text)));
      if (kind === "queue") {
        const q = trunkOf(p), error = this.queueError[p.url];
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
      const [qLabel, qColor] = QUEUE[trunkOf(p)?.state ?? "none"];
      const when = kind === "merged" ? p.mergedAt : kind === "queue" ? trunkOf(p)?.at : p.updated;
      return h_flex().id(`${kind}-${p.url}`).h(ROW).px(6).gap(8).items_center().min_w(0).rounded(4).hover((s) => s.bg(t.hover))
        .when(open, (el) => el.bg(t.surface))
        .when(kind !== "merged", (el) => el.cursor_pointer().on_click((_e, cx) => { this.expanded[key] = !open; cx.notify(); }))
        .child(c.cell(W.repo, repoName(p), t.muted))
        .child(kind === "review" && p.draft ? h_flex().w(W.status).flex_none().gap(4).items_center()
            .child(c.chip(W.status - 46, "Draft", t.dim))
            .child(h_flex().id(`rfr-${p.url}`).w(42).flex_none().h(17).justify_center().items_center().rounded(3).border(1).border_color(t.accent)
              .text_size(10).font_semibold().text_color(t.accent).cursor_pointer().tooltip("Mark ready for review")
              .hover((s) => s.bg(t.raised))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.markReady(p, cx); })
              .child(this.readyBusy?.[p.url] ? svg("mods/workspace-chrome/spinner.svg").size(10).spin(900) : "RFR"))
          : kind === "review" ? c.review(p) : kind === "queue" ? c.chip(W.status, qLabel, qColor) : div().w(W.status).flex_none())
        .child(kind === "merged" ? div().w(W.ci).flex_none()
          : ["FAILURE", "ERROR"].includes(p.ci) ? div().id(`ci-${p.url}`).flex_none().cursor_pointer().tooltip("Open Claude on the failing CI")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.fixCi(p, cx); })
            // Once opened (pane open or since closed), the chip fills in so you can see you already sent Claude.
            .child(this.ciStarting?.[p.url] ? c.chip(W.ci, "Opening…", c.red)
              : (shared(CI_PANES) ?? {})[p.url] ? c.chip(W.ci, "CI · on it", c.red).bg(c.red + "33") : c.ci(p))
          : c.ci(p))
        .child(c.link(p, W.pr))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .when(Boolean(p.cloud), (el) => el.child(div().id(`cloud-${p.url}`).flex_none().px(5).h(16).flex().items_center().rounded(3)
            .border(1).border_color(t.ansi6).text_size(10).font_semibold().text_color(t.ansi6).cursor_pointer().tooltip("Opened by your PostHog cloud task")
            .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(p.taskUrl); }).child("cloud")))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(p.title)))
        .child(note(p, kind))
        .child(c.cell(W.age, ago(Date.parse(p.created))))
        .child(c.cell(W.when, when ? ago(Date.parse(when)) : "", kind === "merged" ? c.green : t.dim))
        .child(c.size(p, W.size))
        .child(kind === "merged" ? div().w(W.cc).flex_none() : ccButton(p))
        .when(W.merge > 0, (el) => el.child(kind === "merged" ? div().w(W.merge).flex_none() : queueButton(p)));
    };
    const header = (title, noteLabel, whenLabel, sticky) => h_flex().flex_none().h(COLS).px(sticky ? 10 : 6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(c.head(W.repo, "REPO")).child(c.head(W.status, "STATUS")).child(c.head(W.ci, "CI")).child(c.head(W.pr, "PR")).child(c.headFlex(title))
      .child(c.head(W.note, noteLabel)).child(c.head(W.age, "AGE")).child(c.head(W.when, whenLabel))
      .child(c.head(W.size, "SIZE")).child(c.head(W.cc, "CC", true)).when(W.merge > 0, (el) => el.child(c.head(W.merge, "MERGE", true)));
    // A clear break between the three tables.
    const divider = () => div().h(SECTION_GAP).flex().items_center().child(div().w_full().h(2).bg(t.border));
    const empty = (text) => div().px(8).h(ROW).flex().items_center().text_size(12).text_color(t.dim).child(text);

    const body = v_flex().px(4).py(2)
      .when(Boolean(gh.at) && list.length === 0, (el) => el.child(empty("Nothing in review")))
      .children(list.map((p) => row(p, "review")))
      .child(divider()).child(header("MERGE QUEUE", "TRUNK SAYS", "SINCE"))
      .when(inQueue.length === 0, (el) => el.child(empty("Nothing in the merge queue")))
      .children(inQueue.map((p) => row(p, "queue")))
      .child(divider()).child(header("RECENTLY MERGED", "", "MERGED"))
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
    return { columns: header("IN REVIEW", "REVIEWS", "UPD", true), body, content: rows * ROW + 2 * (COLS + SECTION_GAP) + extra };
  },
};
