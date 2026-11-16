// Triage: the inbox, one report at a time, by keyboard. Starting, claiming and
// releasing happen at once, as jobs the sidebar does (flows.js), so they finish
// even when this view closes. The verdicts that take a report away (dismiss,
// snooze, not mine) are only marked, and reach PostHog when the marks are
// reviewed and applied. Marks are kept, so a round can be left and resumed.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView, ScrollHandle } from "gpui-base";
import { theme, props, closeOverlay, shared, setShared, run } from "herdr";
import { ph } from "./ph.js";
import { taskOfReport } from "./store.js";
import { openPr, heldByOther, addJob, jobOf, sendVerdict, DISMISS, LEAVE } from "./flows.js";
import { priority, ago, prNumber } from "./ui.js";

const close = () => closeOverlay(props().overlay);
const words = (text) => (text ?? "").replace(/_/g, " ");
const OPEN = "in_progress,pending_input,ready";
const mine = () => shared("ph-inbox.mine") ?? [];

const KIND = {
  start: { glyph: "▶", color: "accent", say: () => "Starting…" },
  claim: { glyph: "●", color: "accent", say: () => "Claiming…" },
  release: { glyph: "○", color: "muted", say: () => "Releasing your claim…" },
  dismiss: { glyph: "✕", color: "blocked", say: (m) => `Dismiss: ${m.label} (d again to undo)` },
  snooze: { glyph: "z", color: "ansi3", say: () => "Snooze until it recurs (z again to undo)" },
  leave: { glyph: "↩", color: "muted", say: (m) => `Not mine: ${m.label} (n again to undo)` },
};
const ORDER = ["dismiss", "snooze", "leave"];
// Which reports a round goes through.
const FILTERS = [
  ["all", "All", () => true],
  ["claimed", "Claimed by me", (r) => mine().includes(r.id)],
  ["suggested", "Suggested to me", (r) => !mine().includes(r.id)],
];

export class Triage {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.reports = [];
    this.index = 0;
    this.filter = "all";
    // report id -> { kind, reason, label, state }; shared, since each copy of the mod has its own localStorage
    this.marks = { ...(shared("ph-inbox.triage") ?? {}) };
    this.wasMine = new Set(mine()); // their rows still name you as the assignee after a release
    this.choosing = null; // { kind, options } while a reason is being picked
    this.mode = "browse"; // browse | review | applying | done
    this.note = null;
    this.failed = [];
    this.applied = 0;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        // Your claims too: a claimed report can be missing from "for you".
        const [list, own] = await Promise.all([
          ph("inbox-reports-list", { view: "for_you", sort: "personal", limit: 100, include_source_metadata: false }),
          ph("inbox-reports-list", { assignee: "mine", status: OPEN, limit: 200, include_source_metadata: false }),
        ]);
        const have = new Set((list.results ?? []).map((r) => r.id));
        this.reports = [...(list.results ?? []), ...(own.results ?? []).filter((r) => !have.has(r.id))];
        const ids = (own.results ?? []).map((r) => r.id);
        ids.forEach((id) => this.wasMine.add(id));
        if (JSON.stringify(ids) !== JSON.stringify(mine())) setShared("ph-inbox.mine", ids);
        const here = new Set(this.reports.map((r) => r.id));
        for (const id of Object.keys(this.marks)) if (!here.has(id) || !ORDER.includes(this.marks[id].kind)) delete this.marks[id];
      } catch (e) {
        this.note = e.message;
      }
      this.loading = false;
      cx.notify();
    });
    this.handle.focus();
  }

  // The round's reports: the chosen filter's, without the ones already in Tasks.
  shown() {
    const test = FILTERS.find((f) => f[0] === this.filter)[2];
    return this.reports.filter((r) => test(r) && !taskOfReport(r.id));
  }

  // What is happening to a report (a job) or is marked to happen.
  verdict(r) {
    const job = jobOf(r.id);
    return job ? { kind: job.kind } : this.marks[r.id];
  }

  held(r) {
    return this.wasMine.has(r.id) ? null : heldByOther(r, mine());
  }

  marked() {
    return this.reports.filter((r) => this.marks[r.id]).sort((a, b) => ORDER.indexOf(this.marks[a.id].kind) - ORDER.indexOf(this.marks[b.id].kind));
  }

  move(by) {
    this.index = Math.min(this.shown().length - 1, Math.max(0, this.index + by));
    this.scroll.scroll_to_item(this.index);
    this.note = null;
  }

  // Marks the report and moves on; the same verdict again takes the mark off.
  mark(r, mark) {
    const off = this.marks[r.id]?.kind === mark.kind;
    if (off) delete this.marks[r.id];
    else this.marks[r.id] = mark;
    setShared("ph-inbox.triage", this.marks);
    this.choosing = null;
    if (!off) this.move(1);
  }

  // Starts, claims or releases the report now, behind the round.
  job(kind, r) {
    if (jobOf(r.id)) return (this.note = "This report is still busy.");
    const held = this.held(r);
    if (held) return (this.note = `${held} holds this report. Open it in PostHog to take it over.`);
    if (this.marks[r.id]) {
      delete this.marks[r.id];
      setShared("ph-inbox.triage", this.marks);
    }
    addJob(kind, r);
    this.move(1);
  }

  act(name, cx) {
    const r = this.shown()[this.index];
    this.note = null;
    if (this.mode === "applying") return;
    if (this.mode === "review") {
      if (name === "confirm") this.apply(cx);
      else if (name === "back") this.mode = "browse";
    } else if (this.mode === "done") {
      if (this.reports.length && (name === "confirm" || name === "back")) this.mode = "browse";
      else close();
    } else if (this.choosing) {
      const option = this.choosing.options[Number(name) - 1];
      if (option && r) this.mark(r, { kind: this.choosing.kind, reason: option[0], label: option[1], state: option[2] });
      else if (name === "back") this.choosing = null;
    } else if (name === "down") this.move(1);
    else if (name === "up") this.move(-1);
    else if (name === "back") close();
    else if (name === "filter" || FILTERS.some((f) => f[0] === name)) {
      this.filter = name === "filter" ? FILTERS[(FILTERS.findIndex((f) => f[0] === this.filter) + 1) % FILTERS.length][0] : name;
      this.index = 0;
      this.scroll.scroll_to_item(0);
    } else if (name === "confirm") {
      if (this.marked().length) this.mode = "review";
      else this.note = "Nothing is marked to dismiss, snooze or leave.";
    } else if (!r) return;
    else if (name === "start") this.job("start", r);
    else if (name === "claim") this.job(mine().includes(r.id) ? "release" : "claim", r);
    else if (name === "dismiss" || name === "leave") {
      if (this.marks[r.id]?.kind === name) this.mark(r, { kind: name });
      else this.choosing = { kind: name, options: name === "dismiss" ? DISMISS : LEAVE };
    } else if (name === "snooze") this.mark(r, { kind: "snooze" });
    else if (name === "open") cx.open_url(r._posthogUrl);
    cx.notify();
  }

  key(e, cx) {
    const m = e.modifiers;
    if (m.platform || m.control || m.alt) return;
    const name = {
      j: "down", down: "down", space: "down", k: "up", up: "up", escape: "back", enter: "confirm", tab: "filter",
      s: "start", c: "claim", d: "dismiss", n: "leave", z: "snooze", o: "open",
    }[e.key] ?? (/^[1-9]$/.test(e.key) ? e.key : null);
    if (!name) return;
    cx.stop_propagation();
    this.act(name, cx);
  }

  apply(cx) {
    const todo = this.marked();
    Object.assign(this, { mode: "applying", failed: [], applied: 0 });
    cx.spawn(async (cx) => {
      for (const [i, r] of todo.entries()) {
        this.note = `${i + 1} of ${todo.length}: ${r.title}`;
        cx.notify();
        try {
          await sendVerdict(r.id, this.marks[r.id]);
          this.applied++;
          delete this.marks[r.id];
          this.reports = this.reports.filter((x) => x.id !== r.id);
        } catch (e) {
          this.failed.push({ title: r.title, error: e.message ?? String(e) });
        }
        setShared("ph-inbox.triage", this.marks);
      }
      Object.assign(this, { mode: "done", note: null, index: 0 });
      run("ph-inbox.refresh");
      cx.notify();
    });
  }

  // A key and what it does; clicking it does the same.
  hint(t, key, text, name) {
    return h_flex().id(`hint-${name}`).flex_none().gap(6).items_center().h(24).pl(4).pr(8).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.act(name, cx))
      .child(div().flex_none().min_w(18).h(18).px(4).rounded(4).border_1().border_color(t.input).bg(t.raised)
        .flex().items_center().justify_center().text_size(10.5).font_semibold().text_color(t.muted).child(key))
      .child(div().text_size(12).text_color(t.muted).child(text));
  }

  glyph(t, m, size = 16) {
    const k = m ? KIND[m.kind] : null;
    return div().w(size).flex_none().text_size(11).font_bold().text_color(k ? t[k.color] : t.dim).child(k?.glyph ?? "");
  }

  list(t, shown) {
    return v_flex().id("triage-list").w(310).flex_none().min_h(0).p(6).gap(1).border_r_1().border_color(t.border)
      .overflow_y_scrollbar().track_scroll(this.scroll)
      .children(shown.map((r, i) => h_flex().id(`triage-${r.id}`).h(30).px(6).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
        .when(i === this.index, (el) => el.bg(t.selected))
        .when(i !== this.index, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { if (this.mode === "browse") { this.index = i; this.choosing = null; this.note = null; cx.notify(); } })
        .child(this.glyph(t, this.verdict(r), 12))
        .child(priority(t, r.priority))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(this.verdict(r) ? t.dim : t.foreground).child(r.title))
        .when(mine().includes(r.id), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("yours")))));
  }

  card(t, r) {
    const m = this.verdict(r);
    const fix = (r.ranking?.predictions ?? []).find((p) => p.outcome === "fix");
    const pr = prNumber(openPr(r));
    const held = this.held(r);
    const claim = mine().includes(r.id) ? "claimed by you" : held ? `claimed by ${held}` : "unclaimed";
    const facts = [
      words(r.status), claim, pr ? `#${pr} open` : null, r.scout_name,
      r.signal_count ? `${r.signal_count} signals` : null, fix ? `${Math.round(fix.probability * 100)}% likely you'd fix it` : null,
      r.updated_at ? `updated ${ago(r.updated_at)}` : null,
    ].filter(Boolean);
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(v_flex().flex_none().px(22).pt(16).pb(12).gap(8).border_b_1().border_color(t.border)
        .child(h_flex().gap(10).items_start()
          .child(div().pt(3).child(priority(t, r.priority)))
          .child(div().flex_1().min_w(0).text_size(16).font_semibold().child(r.title ?? "")))
        .child(div().text_size(12).text_color(t.dim).child(facts.join(" · ")))
        .when(Boolean(r.personal_reason), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(r.personal_reason)))
        .when(Boolean(m), (el) => el.child(h_flex().gap(6).items_center().text_size(12.5).text_color(t[KIND[m.kind].color])
          .child(this.glyph(t, m, 12)).child(KIND[m.kind].say(m)))))
      .child(div().id("triage-body").flex_1().min_h(0).px(22).py(14).overflow_y_scrollbar()
        .child(div().max_w(760).child(TextView.markdown(`triage-${r.id}`, r.summary ?? "").selectable(true))));
  }

  // What applying will do, before it does it.
  review(t) {
    const todo = this.marked();
    const closes = todo.filter((r) => this.marks[r.id].kind === "dismiss" && openPr(r));
    return v_flex().id("triage-review").flex_1().min_w(0).min_h(0).px(22).py(16).overflow_y_scrollbar()
      .child(div().text_size(16).font_semibold().child(`Apply ${todo.length} ${todo.length === 1 ? "verdict" : "verdicts"}`))
      .when(closes.length > 0, (el) => el.child(div().pt(6).text_size(12).text_color(t.ansi3)
        .child(`Dismissing closes ${closes.length === 1 ? "an open pull request" : `${closes.length} open pull requests`}: ${closes.map((r) => `#${prNumber(openPr(r))}`).join(", ")}.`)))
      .child(v_flex().pt(12).gap(1).children(todo.map((r) => {
        const m = this.marks[r.id];
        return h_flex().h(30).gap(8).flex_none().items_center()
          .child(this.glyph(t, m, 12))
          .child(div().w(190).flex_none().truncate().text_size(12).text_color(t[KIND[m.kind].color]).child(KIND[m.kind].say(m).replace(/ \(.*$/, "")))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(r.title));
      })));
  }

  done(t) {
    return v_flex().id("triage-done").flex_1().min_w(0).min_h(0).px(22).py(16).overflow_y_scrollbar()
      .child(div().text_size(16).font_semibold().child(`${this.applied} applied${this.failed.length ? `, ${this.failed.length} failed` : ""}`))
      .when(!this.failed.length, (el) => el.child(div().pt(6).text_size(12).text_color(t.dim).child(this.reports.length ? `${this.reports.length} reports are left.` : "The inbox is empty.")))
      .children(this.failed.map((f) => v_flex().pt(12).gap(2)
        .child(div().text_size(12.5).child(f.title))
        .child(div().text_size(12).text_color(t.blocked).child(f.error))));
  }

  footer(t, r) {
    const bar = (...hints) => h_flex().flex_1().min_w(0).gap(4).items_center().flex_wrap().children(hints);
    if (this.mode === "applying") return bar(div().px(4).text_size(12).text_color(t.dim).truncate().child(this.note ?? "Working…"));
    if (this.mode === "review") return bar(this.hint(t, "↵", "Apply", "confirm"), this.hint(t, "esc", "Back", "back"));
    if (this.mode === "done") return bar(this.hint(t, "↵", this.reports.length ? "Keep going" : "Close", "confirm"));
    if (this.choosing) {
      return bar(div().px(4).text_size(12).text_color(t.dim).child(this.choosing.kind === "dismiss" ? "Dismiss because" : "Not mine because"),
        ...this.choosing.options.map((o, i) => this.hint(t, String(i + 1), o[1], String(i + 1))), this.hint(t, "esc", "Cancel", "back"));
    }
    const n = this.marked().length;
    return bar(this.hint(t, "s", "Start now", "start"), this.hint(t, "c", r && mine().includes(r.id) ? "Release claim" : "Claim", "claim"),
      this.hint(t, "d", "Dismiss", "dismiss"), this.hint(t, "z", "Snooze", "snooze"), this.hint(t, "n", "Not mine", "leave"),
      this.hint(t, "j/k", "Move", "down"), this.hint(t, "tab", "Filter", "filter"), this.hint(t, "o", "PostHog", "open"),
      div().flex_1(), ...(n ? [this.hint(t, "↵", `Review ${n}`, "confirm")] : []));
  }

  render() {
    const t = theme();
    const shown = this.shown();
    this.index = Math.max(0, Math.min(this.index, shown.length - 1));
    const r = shown[this.index];
    const counts = ORDER.map((kind) => [kind, Object.values(this.marks).filter((m) => m.kind === kind).length]).filter(([, n]) => n);
    const filters = FILTERS.map(([key, text, test]) => {
      const on = key === this.filter;
      return h_flex().id(`filter-${key}`).flex_none().h(24).px(9).gap(5).items_center().rounded(6).cursor_pointer().text_size(12)
        .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { if (this.mode === "browse") this.act(key, cx); })
        .child(text).child(div().text_color(t.dim).child(String(this.reports.filter((x) => test(x) && !taskOfReport(x.id)).length)));
    });
    const right = this.mode === "review" || this.mode === "applying" ? this.review(t) : this.mode === "done" ? this.done(t)
      : r ? this.card(t, r)
      : v_flex().flex_1().items_center().justify_center().text_color(t.dim).child(this.loading ? "Loading the inbox…" : this.note ?? "Nothing here is waiting for you.");
    return v_flex().id("triage").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(40).px(14).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().flex_none().pr(2).text_size(13.5).font_semibold().child("Triage"))
        .children(filters)
        .child(div().flex_1().text_size(12).text_color(t.dim).child(this.loading ? "Loading…" : shown.length ? `${this.index + 1} of ${shown.length}` : ""))
        .children(counts.map(([kind, n]) => h_flex().flex_none().gap(4).items_center().text_size(12).text_color(t[KIND[kind].color])
          .child(div().font_bold().text_size(11).child(KIND[kind].glyph)).child(String(n))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().flex_1().min_h(0).items_stretch().child(this.list(t, shown)).child(right))
      .child(h_flex().flex_none().min_h(40).px(10).py(6).gap(8).items_center().border_t_1().border_color(t.border)
        .child(this.footer(t, r))
        .when(Boolean(this.note) && this.mode === "browse", (el) => el.child(div().flex_none().max_w(420).truncate().text_size(12).text_color(t.ansi3).child(this.note))));
  }
}
