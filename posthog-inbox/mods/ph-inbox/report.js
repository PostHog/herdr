// A report, read in a pane: what it found, its work log, and the ways to act on
// it. Shows whichever report the sidebar chose last (shared "ph-inbox.report").

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, shared, openOverlay } from "herdr";
import { ph } from "./ph.js";
import { taskOfReport, spaceOf, goToTask } from "./store.js";
import { button, priority, ago, prNumber } from "./ui.js";

const words = (text) => (text ?? "").replace(/_/g, " ");
const HIDDEN = new Set(["ranking_score", "reviewer_corrections", "safety_judgment"]);

// An entry nobody wrote a sentence for: its plain values, one per line.
const fields = (c) => Object.entries(c).filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
  .map(([k, v]) => `- ${words(k)}: ${String(v).slice(0, 300)}`).join("\n");

// One work-log entry as markdown, or null for the ones only machines read.
function entry(a) {
  const c = a.content ?? {};
  if (HIDDEN.has(a.type)) return null;
  let text;
  if (a.type === "suggested_reviewers") text = (Array.isArray(c) ? c : []).map((r) => `- ${r.github_login ?? r.user?.email ?? "someone"}: ${r.reason ?? ""}`).join("\n");
  else if (a.type === "priority_judgment") text = `${c.priority ?? ""}: ${c.explanation ?? ""}`;
  else if (a.type === "actionability_judgment") text = `${words(c.actionability)}: ${c.explanation ?? ""}`;
  else if (a.type === "task_run") text = `${words(c.type) || "run"} by ${c.product ?? "a task"}${c.automation_branch ? ` on \`${c.automation_branch}\`` : ""}`;
  else if (a.type === "pull_request") text = c.url ? `[#${prNumber(c.url) ?? c.url}](${c.url})` : "";
  else if (a.type === "work_claim") text = `Claimed by ${c.display_name ?? "someone"}`;
  else if (a.type === "title_change") text = `"${c.old_title ?? ""}" became "${c.new_title ?? ""}"`;
  else if (a.type === "check_scheduled") text = `${c.title ?? "Follow-up check"}${c.next_run_at ? `, next run ${c.next_run_at.slice(0, 10)}` : ""}`;
  else text = c.note ?? c.explanation ?? c.reason ?? c.summary ?? c.description ?? c.text ?? c.message ?? c.title ?? (typeof c === "string" ? c : fields(c));
  return `**${words(a.type)}** · ${ago(a.created_at)}\n\n${text}`;
}

function body(report, artefacts) {
  const parts = [report.summary ?? ""];
  if (report.suggested_prompts?.length) parts.push("## Suggested next steps", report.suggested_prompts.map((p) => `- ${p}`).join("\n"));
  if (report.pull_requests?.length) {
    parts.push("## Pull requests", report.pull_requests.map((p) => `- [#${prNumber(p.url) ?? "?"}](${p.url}) ${p.merged ? "merged" : words(p.state)}${p.review_decision ? `, ${words(p.review_decision)}` : ""}`).join("\n"));
  }
  if (artefacts) {
    const log = artefacts.map(entry).filter(Boolean);
    if (log.length) parts.push("## Work log", log.join("\n\n---\n\n"));
  }
  return parts.join("\n\n");
}

const forDialog = (r) => ({
  id: r.id, title: r.title, summary: r.summary, status: r.status, repo_slug: r.repo_slug ?? null,
  assignee: r.assignee ?? null, pull_requests: r.pull_requests ?? [], _posthogUrl: r._posthogUrl,
});

export class ReportPane {
  init(p) {
    this.fixed = p.id ? { id: p.id } : null; // props { id }: always that report
    this.id = null;
    this.report = null;
    this.artefacts = null;
    this.error = null;
    this.version = 0;
  }

  load(want, cx) {
    const id = want.id;
    Object.assign(this, { id, report: want.row ?? null, artefacts: null, error: null });
    this.version++;
    cx.spawn(async (cx) => {
      try {
        const report = await ph("inbox-reports-retrieve", { id });
        if (this.id !== id) return;
        this.report = { ...(want.row ?? {}), ...report };
        this.version++;
        cx.notify();
        const log = await ph("inbox-report-artefacts-list", { report_id: id, limit: 100 });
        if (this.id !== id) return;
        this.artefacts = log.results ?? [];
        this.version++;
      } catch (e) {
        if (this.id === id) this.error = e.message;
      }
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const want = this.fixed ?? shared("ph-inbox.report");
    if (want?.id && want.id !== this.id) this.load(want, cx);
    const r = this.report;
    const root = v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13);
    if (!r) return root.items_center().justify_center().child(div().text_color(this.error ? t.blocked : t.dim).child(this.error ?? (this.id ? "Loading the report…" : "Choose a report from the inbox.")));
    const task = taskOfReport(r.id);
    const space = task ? spaceOf(task) : null;
    const dialog = (view, width, height) => () => openOverlay({ mod: "ph-inbox", kind: "dialog", modal: true, width, height, props: { view, report: forDialog(r) } });
    const facts = [words(r.status), words(r.work_state), r.repo_slug, r.scout_name, r.signal_count ? `${r.signal_count} signals` : null, r.updated_at ? `updated ${ago(r.updated_at)}` : null].filter(Boolean);
    return root
      .child(v_flex().flex_none().px(22).pt(18).pb(14).gap(10).border_b_1().border_color(t.border)
        .child(h_flex().gap(10).items_start()
          .child(div().pt(3).child(priority(t, r.priority)))
          .child(div().flex_1().min_w(0).text_size(16).font_semibold().child(r.title ?? "")))
        .child(div().text_size(12).text_color(t.dim).child(facts.join(" · ")))
        .when(Boolean(r.personal_reason), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(r.personal_reason)))
        .child(h_flex().gap(8).pt(2).flex_wrap()
          .when(Boolean(space), (el) => el.child(button(t, "go-task", "Go to task", () => goToTask(task), { primary: true })))
          .when(!space, (el) => el.child(button(t, "start-local", "Start locally", dialog("pickup", 540, 520), { primary: true })))
          .child(button(t, "start-cloud", "Start in cloud", dialog("cloud", 580, 560)))
          .child(button(t, "open-posthog", "Open in PostHog", (_e, cx) => cx.open_url(r._posthogUrl)))))
      .child(div().id("report-body").flex_1().min_h(0).px(22).py(16).overflow_y_scrollbar()
        .child(div().max_w(820).child(TextView.markdown(`report-${r.id}-${this.version}`, body(r, this.artefacts)).selectable(true)))
        .when(!this.artefacts && !this.error, (el) => el.child(div().pt(12).text_size(12).text_color(t.dim).child("Loading the work log…")))
        .when(Boolean(this.error), (el) => el.child(div().pt(12).text_size(12).text_color(t.blocked).child(this.error))));
  }
}
