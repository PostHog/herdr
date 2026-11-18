// A finding, read in a pane: the scanner's write-up, our triage, fix PRs and
// comments, and the ways to act on it. Shows whichever finding the sidebar
// chose last (shared "security-hog.finding"), or props { id }.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, shared, notify } from "herdr";
import { sh, signIn, loadConfig, myEmail } from "./sh.js";
import { fixOf, patchFix, startFix, goToFix, spaceOfFix, fixPullRequest } from "./fix.js";
import { button, severity, verdict, verdictWords, ago, prNumber } from "./ui.js";

const words = (text) => (text ?? "").toString().replace(/_/g, " ").toLowerCase();

function lines(v) {
  const repo = v.repository;
  return (v.locations ?? []).map((l) => {
    const range = l.lineStart ? `#L${l.lineStart}${l.lineEnd && l.lineEnd !== l.lineStart ? `-L${l.lineEnd}` : ""}` : "";
    const label = `${l.file}${l.lineStart ? `:${l.lineStart}${l.lineEnd && l.lineEnd !== l.lineStart ? `-${l.lineEnd}` : ""}` : ""}`;
    return repo ? `- [${label}](https://github.com/${repo}/blob/${v.branch || "HEAD"}/${l.file}${range})` : `- ${label}`;
  }).join("\n");
}

function body(detail) {
  const v = detail.vulnerability;
  const d = v.detail ?? {};
  const parts = [];
  const section = (title, text) => text && parts.push(`## ${title}`, String(text));
  if (v.shortDescription ?? d.subtitle) parts.push(v.shortDescription ?? d.subtitle);
  section("Description", d.description);
  section("Impact", d.impact ?? d.impact_description);
  section("Recommendation", d.recommendation ?? d.remediation ?? d.remediationInstructions);
  section("Locations", lines(v));
  const triage = detail.triages?.[0];
  if (triage) {
    const head = triage.status === "completed"
      ? `**${verdictWords(triage.verdict)}**, ${words(triage.confidence)} confidence · ${ago(triage.completedAt)} ago${triage.commit ? ` at \`${triage.commit.slice(0, 10)}\`` : ""}`
      : `**${words(triage.status)}** · started ${ago(triage.startedAt)} ago${triage.error ? `\n\n${triage.error}` : ""}`;
    section("Triage", [head, triage.summary, triage.reasoning].filter(Boolean).join("\n\n"));
  }
  if (detail.fixes?.length) {
    section("Fix pull requests", detail.fixes.map((f) => `- [#${prNumber(f.url) ?? f.url}](${f.url})${f.state ? ` ${words(f.state)}` : ""} · added by ${f.addedBy}`).join("\n"));
  }
  if (detail.comments?.length) {
    const older = detail.olderCommentsOmitted ? `${detail.olderCommentsOmitted} older comments are on the finding's page.\n\n---\n\n` : "";
    section("Comments", older + detail.comments.map((c) => `**${c.author}** · ${ago(c.createdAt)}\n\n${c.body}`).join("\n\n---\n\n"));
  }
  return parts.join("\n\n");
}

export class FindingPane {
  init(p, cx) {
    this.fixed = p.id ? { id: p.id } : null;
    this.id = null;
    this.detail = null;
    this.row = null;
    this.error = null;
    this.busy = null;
    this.step = null;
    this.pr = null;
    this.version = 0;
    this.me = null;
    cx.spawn(async (cx) => {
      this.me = await myEmail(await loadConfig());
      cx.notify();
    });
  }

  load(id, cx) {
    this.id = id;
    this.version++;
    cx.spawn(async (cx) => {
      try {
        const detail = await sh("get_vulnerability", { id });
        if (this.id !== id) return;
        this.detail = detail;
        this.error = null;
        this.version++;
        cx.notify();
        await this.lookForPr(cx);
      } catch (e) {
        if (this.id === id) this.error = { code: e.code, message: e.message };
      }
      cx.notify();
    });
  }

  show(want, cx) {
    Object.assign(this, { detail: null, row: want.row ?? null, error: null, pr: null, step: null });
    this.load(want.id, cx);
  }

  async lookForPr(cx) {
    const id = this.id;
    const fix = fixOf(id);
    if (!fix) return;
    const pr = fix.pr_url ? { url: fix.pr_url, number: prNumber(fix.pr_url) } : await fixPullRequest(fix);
    if (this.id !== id || !pr) return;
    this.pr = pr;
    if (!fix.pr_url) patchFix(id, { pr_url: pr.url });
    cx.notify();
  }

  act(label, work, cx) {
    if (this.busy) return;
    this.busy = label;
    this.step = null;
    cx.notify();
    const id = this.id;
    cx.spawn(async (cx) => {
      try {
        const said = await work((text) => { this.step = text; cx.notify(); });
        if (said) notify({ title: said.title, body: said.body ?? "", level: said.level ?? "success" });
        if (this.id === id) this.load(id, cx);
      } catch (e) {
        notify({ title: `${label} failed`, body: e.message, level: "error" });
      }
      this.busy = null;
      this.step = null;
      cx.notify();
    });
  }

  fix(cx) {
    const detail = this.detail;
    this.act("Fix", async (step) => {
      const started = await startFix(detail, step);
      if (!started) return null;
      return started.warning ? { title: "Fix started", body: started.warning, level: "warning" } : null;
    }, cx);
  }

  assign(email, cx) {
    const id = this.id;
    this.act(email ? "Assign" : "Unassign", async () => {
      await sh("assign_vulnerability_person", { id, assignee: email });
      return { title: email ? `${id} is assigned to you` : `${id} is unassigned` };
    }, cx);
  }

  triage(cx) {
    const id = this.id;
    this.act("Triage", async () => {
      await sh("request_triage", { id });
      return { title: "Triage started", body: `${id} gets a new verdict in about 15 minutes.` };
    }, cx);
  }

  attach(cx) {
    const id = this.id, url = this.pr.url;
    this.act("Attach", async () => {
      await sh("attach_fix_pr", { id, url });
      return { title: `#${prNumber(url)} attached to ${id}` };
    }, cx);
  }

  render(cx) {
    const t = theme();
    const want = this.fixed ?? shared("security-hog.finding");
    if (want?.id && want.id !== this.id) this.show(want, cx);
    const root = v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13);
    const v = this.detail?.vulnerability ?? this.row;
    if (!v) {
      const message = this.error?.message ?? (this.id ? "Loading the finding…" : "Choose a finding from the Security list.");
      return root.items_center().justify_center().gap(12)
        .child(div().text_color(this.error ? t.blocked : t.dim).child(message))
        .when(this.error?.code === "login", (el) => el.child(button(t, "sign-in", "Sign in to SecurityHog", () => signIn(), { primary: true })));
    }
    const detail = this.detail;
    const assignee = detail ? detail.assignee?.email ?? null : v.assigneeEmail ?? null;
    const mine = Boolean(this.me && assignee?.toLowerCase() === this.me);
    const fix = fixOf(v.id);
    const fixSpace = fix ? spaceOfFix(fix) : null;
    const triaging = detail?.triages?.[0] && !["completed", "failed"].includes(detail.triages[0].status);
    const attached = this.pr && (detail?.fixes ?? []).some((f) => f.url === this.pr.url);
    const facts = [v.id, v.source, words(v.status), v.repository, v.team, assignee ? `assigned to ${mine ? "you" : assignee}` : "unassigned", `found ${ago(v.vendorCreatedAt ?? v.firstSeenAt)} ago`].filter(Boolean);
    const busy = Boolean(this.busy) || !detail;
    return root
      .child(v_flex().flex_none().px(22).pt(18).pb(14).gap(10).border_b_1().border_color(t.border)
        .child(h_flex().gap(10).items_start()
          .child(div().pt(3).child(severity(t, v.severity)))
          .child(div().flex_1().min_w(0).text_size(16).font_semibold().child(v.title ?? ""))
          .child(div().mt(1).child(verdict(t, v.triageVerdict, { full: true }) ?? div())))
        .child(div().text_size(12).text_color(t.dim).child(facts.join(" · ")))
        .child(h_flex().gap(8).pt(2).flex_wrap()
          .when(Boolean(fix), (el) => el.child(button(t, "go-fix", fixSpace ? "Go to fix" : "Open the fix", (_e, cx) => {
            cx.spawn(async () => {
              if (!(await goToFix(fix))) notify({ title: "The fix's worktree is gone", body: fix.worktree, level: "warning" });
            });
          }, { primary: true })))
          .when(!fix, (el) => el.child(button(t, "fix", this.busy === "Fix" ? "Starting…" : "Fix locally", (_e, cx) => this.fix(cx), {
            primary: true, disabled: busy || !v.repository,
            tip: v.repository ? `A worktree of ${v.repository} and an agent working on it${assignee ? "" : ". Assigns the finding to you"}` : "This finding names no repository",
          })))
          .when(Boolean(this.pr) && !attached, (el) => el.child(button(t, "attach", `Attach #${this.pr.number}`, (_e, cx) => this.attach(cx), { disabled: busy, tip: "Attach the fix's pull request to the finding" })))
          .child(mine
            ? button(t, "unassign", "Unassign me", (_e, cx) => this.assign(null, cx), { disabled: busy })
            : button(t, "assign", "Assign to me", (_e, cx) => this.assign(this.me, cx), { disabled: busy || !this.me, tip: this.me ? `Assign to ${this.me}` : `Add "email" to the config` }))
          .child(button(t, "triage", triaging ? "Triage running…" : "Request triage", (_e, cx) => this.triage(cx), { disabled: busy || triaging, tip: "Our agent checks the code again and gives a new verdict in ~15 minutes" }))
          .child(button(t, "open", "Open in SecurityHog", (_e, cx) => cx.open_url(v.url))))
        .when(Boolean(this.step), (el) => el.child(div().text_size(12).text_color(t.working).child(this.step))))
      .child(div().id("finding-body").flex_1().min_h(0).px(22).py(16).overflow_y_scrollbar()
        .when(Boolean(detail), (el) => el.child(div().max_w(820).child(TextView.markdown(`finding-${v.id}-${this.version}`, body(detail)).selectable(true))))
        .when(!detail && !this.error, (el) => el.child(div().text_size(12).text_color(t.dim).child("Loading the finding…")))
        .when(Boolean(this.error), (el) => el.child(div().pt(12).text_size(12).text_color(t.blocked).child(this.error.message))));
  }
}
