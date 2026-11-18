// To-do list in the sidebar, kept in ~/morning-launch/todo.md (a markdown
// checklist Claude can read and edit too). Unticked items carry over by
// themselves; ticked ones stay, struck through, for the rest of the day, then
// move to todo-done.md. /plan-tomorrow reads the open ones.
// Every new open item goes to ~/morning-launch/todo-agent, which checks whether
// it's agent work and, if so, starts a helper in the shared "to-do helpers"
// space; its status shows under the item.
// Above the list, "heard in meetings" shows commitments ~/morning-launch/heard/heard.py found in
// Granola transcripts (see heard.js): tick to add one to the list, swipe or × to dismiss.
// An item that came from Slack gets a "slack ↗" chip opening that message: from a
// <!-- slack:… --> comment on its line, a pasted link, or ~/morning-launch/todo-slack, which
// searches Slack once per item (one at a time) and records the answer in todo-links/<slug>.json.
// Alert to-dos get a second line from ~/morning-launch/alert-check (double-checking / kept open: why),
// and items it closed by itself are listed at the bottom for the day (see auto.js); their Slack posts
// are marked read in the alerts list.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, home, readTextFile, writeTextFile, watchFolder, exec, agents, run, layout, shared, setShared, nextCommand, appHome } from "herdr";
import { toggle as toggleFold, isFolded } from "./fold.js";
const FOLD_ID = "todo";
const FOLD_DEPS = { layout, shared, setShared, run, readTextFile, appHome };
import { parse, serialize, add, toggle, remove, rollover, slug, slackLink } from "./list.js";
import { pending, todoText, source, swipe, SWIPE_AT } from "./heard.js";
import { autoLine, closedToday, markClosedRead } from "./auto.js";

const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export default class Todo extends View {
  init(_props, cx) {
    // "<mod>.fold" (keys or herdr-app do) folds or unfolds this section.
    cx.spawn(async () => { for (;;) { if ((await nextCommand()) === "fold") toggleFold(FOLD_ID, FOLD_DEPS); } });
    this.dir = `${home()}/morning-launch`;
    this.file = `${this.dir}/todo.md`;
    this.archive = `${this.dir}/todo-done.md`;
    this.prepDir = `${this.dir}/todo-prep`;
    this.raw = null;
    this.items = [];
    this.prep = {};
    this.started = new Set();
    this.linkDir = `${this.dir}/todo-links`;
    this.links = {};
    this.looking = new Set();
    this.lookups = Promise.resolve();
    this.hover = null;
    this.input = InputState.new({ placeholder: "add a to-do…" });
    this.input.on("submit", (_e, cx) => {
      const text = this.input.value();
      this.input.set_value("");
      this.change(cx, (items) => add(items, text));
    });
    this.heardDir = `${this.dir}/heard`;
    this.heardBin = `${this.heardDir}/heard.py`;
    this.heard = [];
    this.autoClosed = [];
    this.decided = new Set();
    this.swipes = {};
    this.load(cx);
    cx.timer.every(60000, (cx) => this.load(cx));
    for (const dir of [this.dir, this.heardDir]) {
      cx.spawn(async (cx) => {
        for (;;) {
          try { await watchFolder(dir); } catch { return; }
          this.load(cx);
        }
      });
    }
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const raw = await readTextFile(this.file).catch(() => null);
      const items = parse(raw);
      const { keep, archived } = rollover(items, today());
      this.raw = raw;
      this.items = keep;
      if (archived.length) await this.save(keep, archived);
      await this.loadPrep(cx);
      this.heard = pending(await readTextFile(`${this.heardDir}/heard.json`).catch(() => null), this.decided);
      this.autoClosed = closedToday(await readTextFile(`${this.prepDir}/autoclosed.json`).catch(() => null), today());
      const read = shared("alerts.read") ?? {};
      const marked = markClosedRead(read, this.autoClosed);
      if (marked !== read) setShared("alerts.read", marked);
      cx.notify();
    });
  }

  // Tick: the to-do joins the list (loadPrep then starts todo-agent on it, as for any new item)
  // and heard.py records it and logs it on the account's CA note.
  acceptHeard(cx, card) {
    this.decided.add(card.id);
    this.heard = this.heard.filter((c) => c.id !== card.id);
    this.change(cx, (items) => add(items, todoText(card)));
    cx.spawn(async () => { await exec(this.heardBin, ["accept", card.id], { timeout: 30000 }).catch(() => null); });
  }

  dismissHeard(cx, card) {
    this.decided.add(card.id);
    this.heard = this.heard.filter((c) => c.id !== card.id);
    delete this.swipes[card.id];
    cx.notify();
    cx.spawn(async () => { await exec(this.heardBin, ["dismiss", card.id], { timeout: 30000 }).catch(() => null); });
  }

  heardCard(card, i, t) {
    const offset = this.swipes[card.id] ?? 0;
    const fading = Math.min(Math.abs(offset) / SWIPE_AT, 1);
    return v_flex().id(`heard-${i}`).gap(3).px(8).py(6).rounded(6).border_1().border_color(t.border).bg(t.background)
      .ml(offset).opacity(1 - fading * 0.6)
      .on_scroll_wheel((e, cx) => {
        const s = swipe(offset, e);
        if (s.dismiss) return this.dismissHeard(cx, card);
        if (s.offset !== offset) { this.swipes[card.id] = s.offset; cx.notify(); }
      })
      .child(h_flex().gap(8).items_center()
        .child(div().id(`heard-ok-${i}`).size(14).flex_none().rounded(7).border(1.5).border_color(t.input).cursor_pointer()
          .hover((s) => s.bg(t.done).border_color(t.done))
          .on_click((_e, cx) => { cx.stop_propagation(); this.acceptHeard(cx, card); }))
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(card.todo))
        .child(div().id(`heard-x-${i}`).px(4).rounded(4).text_size(12).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.blocked))
          .on_click((_e, cx) => { cx.stop_propagation(); this.dismissHeard(cx, card); })
          .child("×")))
      .child(div().id(`heard-q-${i}`).pl(22).text_size(11).text_color(t.dim).italic().cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); if (card.link) cx.open_url(card.link); })
        .child(`“${card.quote}” · ${card.time}`))
      .child(div().pl(22).text_size(10.5).text_color(t.muted).truncate().child(source(card)));
  }

  // Read each open item's helper record; start a helper for items that have none.
  async loadPrep(cx) {
    const prep = {};
    for (const item of this.items.filter((i) => !i.done)) {
      const key = slug(item.text);
      const raw = await readTextFile(`${this.prepDir}/${key}.json`).catch(() => null);
      let rec = null;
      try { rec = raw ? JSON.parse(raw) : null; } catch { rec = null; }
      if (!rec) {
        if (!this.started.has(key)) this.startHelper(cx, key, item.text);
        rec = { status: "checking" };
      } else if (rec.status === "running") {
        rec.ready = (await readTextFile(`${this.prepDir}/${key}.md`).catch(() => null)) !== null;
      }
      prep[key] = rec;
    }
    this.prep = prep;
    const links = {};
    for (const item of this.items) {
      const key = slug(item.text);
      const raw = await readTextFile(`${this.linkDir}/${key}.json`).catch(() => null);
      try { links[key] = raw ? JSON.parse(raw) : null; } catch { links[key] = null; }
      if (!links[key] && !item.done && !item.slack && !this.looking.has(key)) this.findSlack(cx, key, item.text);
    }
    this.links = links;
  }

  // One Slack search at a time, so a full list doesn't start a dozen Claude runs at once.
  findSlack(cx, key, text) {
    this.looking.add(key);
    this.lookups = this.lookups.then(() => exec(`${home()}/morning-launch/todo-slack`, [key, text], { timeout: 300000 }).catch(() => null));
    cx.spawn(async (cx) => { await this.lookups; this.load(cx); });
  }

  slackChip(item, i, t) {
    const url = slackLink(item, this.links[slug(item.text)]);
    if (!url) return null;
    return div().id(`todo-slack-${i}`).px(6).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.text_color(t.foreground).bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(url); })
      .child("slack ↗");
  }

  startHelper(cx, key, text) {
    this.started.add(key);
    cx.spawn(async (cx) => {
      await exec(`${home()}/morning-launch/todo-agent`, [key, text], { timeout: 600000 }).catch(() => null);
      this.load(cx);
    });
  }

  helper(item, i, t) {
    const rec = this.prep[slug(item.text)];
    if (!rec || rec.status === "skip") return null;
    if (rec.status === "checking") return div().text_size(11).text_color(t.dim).child("checking…");
    const a = agents().find((x) => x.address === rec.terminal);
    const [label, color] = rec.ready ? ["prep ready", t.done] : a?.status === "blocked" ? ["helper needs you", t.blocked] : ["prepping", t.working];
    return h_flex().id(`helper-${i}`).gap(5).items_center().text_size(11).text_color(color).cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (rec.space) run("space.select", { id: rec.space });
        if (rec.terminal) run("pane.focus", { terminal: rec.terminal });
      })
      .when(!rec.ready && a?.status !== "blocked", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(900)))
      .when(rec.ready, (el) => el.child("✦"))
      .child(label);
  }

  autoRow(item, i, t) {
    const line = autoLine(this.prep[slug(item.text)]);
    if (!line) return null;
    const color = line.kind === "kept" ? t.blocked : t.dim;
    return div().id(`todo-auto-${i}`).text_size(10.5).text_color(color).child(line.kind === "kept" ? `⚑ ${line.text}` : `${line.text}…`);
  }

  closedRow(c, i, t) {
    return v_flex().id(`todo-closed-${i}`).gap(2).px(8).py(4).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (c.handover) cx.open_url(`file://${c.handover}`); })
      .child(div().text_size(12).text_color(t.dim).line_through().child(c.text))
      .child(div().text_size(10.5).text_color(t.muted).child(`no action: ${c.reason}${c.ca?.note ? " · CA note logged" : ""}`))
      .when(Boolean(c.slack), (el) => el.child(div().id(`todo-closed-slack-${i}`).text_size(10.5).text_color(t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(c.slack); })
        .child("slack ↗")));
  }

  async save(items, archived = []) {
    const text = serialize(items);
    try {
      await writeTextFile(this.file, text, this.raw);
      this.raw = text;
    } catch {
      return false; // changed underneath us; the next load picks it up
    }
    if (archived.length) {
      const old = await readTextFile(this.archive).catch(() => null);
      const lines = archived.map((i) => `- [x] ${i.text}${i.slack ? ` <!-- slack:${i.slack} -->` : ""} <!-- done:${i.doneOn ?? "?"} -->`).join("\n");
      await writeTextFile(this.archive, `${old ?? "# done\n\n"}${lines}\n`, old).catch(() => null);
    }
    return true;
  }

  change(cx, fn) {
    this.items = fn(this.items);
    cx.notify();
    cx.spawn(async (cx) => { if (!(await this.save(this.items))) this.load(cx); });
  }

  row(item, i, t) {
    const hovered = this.hover === i;
    const box = item.done
      ? div().size(14).flex_none().rounded(7).bg(t.done).flex().items_center().justify_center().text_size(9).text_color(t.accent_foreground).child("✓")
      : div().size(14).flex_none().rounded(7).border(1.5).border_color(t.input);
    // Only the circle ticks an item off; clicking the text does nothing, so a stray
    // click can't mark something done. The padding gives the circle a bigger target.
    const tick = div().id(`todo-tick-${i}`).flex_none().p(3).m(-3).rounded(10).cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .on_click((_e, cx) => { cx.stop_propagation(); this.change(cx, (items) => toggle(items, i, today())); })
      .child(box);
    return h_flex().id(`todo-${i}`).gap(8).px(8).py(5).rounded(6).items_center()
      .hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { this.hover = h ? i : this.hover === i ? null : this.hover; cx.notify(); })
      .child(tick)
      .child(v_flex().flex_1().min_w(0).gap(2)
        // Clicking the text copies it; "copied" shows under it for a moment.
        .child(div().id(`todo-text-${i}`).cursor_pointer().text_size(12.5).text_color(item.done ? t.dim : t.foreground).when(item.done, (el) => el.line_through())
          .on_click((_e, cx) => {
            cx.write_to_clipboard(item.text);
            const mark = this.copied = {};
            this.copiedAt = i;
            cx.notify();
            cx.timer.after(1200, (cx) => { if (this.copied === mark) { this.copiedAt = null; cx.notify(); } });
          })
          .child(item.text))
        .when(this.copiedAt === i, (el) => el.child(div().text_size(10.5).text_color(t.done).child("copied")))
        .when(Boolean(this.slackChip(item, i, t)) || (!item.done && Boolean(this.helper(item, i, t))), (el) => el.child(h_flex().gap(8).items_center()
          .when(!item.done && Boolean(this.helper(item, i, t)), (r) => r.child(this.helper(item, i, t)))
          .when(Boolean(this.slackChip(item, i, t)), (r) => r.child(this.slackChip(item, i, t)))))
        .when(!item.done && Boolean(this.autoRow(item, i, t)), (el) => el.child(this.autoRow(item, i, t))))
      .when(hovered, (el) => el.child(
        div().id(`todo-x-${i}`).px(4).rounded(4).text_size(12).text_color(t.dim).hover((s) => s.text_color(t.blocked))
          .on_click((_e, cx) => { cx.stop_propagation(); this.hover = null; this.change(cx, (items) => remove(items, i)); })
          .child("×")));
  }

  render(cx) {
    const t = theme();
    const open = this.items.map((x, i) => [x, i]).filter(([x]) => !x.done);
    const done = this.items.map((x, i) => [x, i]).filter(([x]) => x.done);
    const folded = isFolded(FOLD_ID, shared);
    const head = h_flex().px(8).items_center()
      .child(h_flex().id("fold-todo").flex_1().gap(5).items_center().text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click(() => toggleFold(FOLD_ID, FOLD_DEPS))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11)).child("To-do"))
      .child(div().text_size(11).text_color(t.dim).child([open.length ? `${open.length} open` : "", this.heard.length ? `${this.heard.length} heard` : ""].filter(Boolean).join(" · ")));
    if (folded) return v_flex().size_full().bg(t.chrome).px(10).pt(10).child(head);
    return v_flex().size_full().bg(t.chrome).px(10).pt(10).gap(6).overflow_y_scrollbar()
      .child(head)
      .when(this.heard.length > 0, (el) => el
        .child(div().px(8).text_size(11).text_color(t.dim).child(`heard in meetings · ${this.heard.length}`))
        .children(this.heard.map((c, i) => this.heardCard(c, i, t))))
      .child(Input.new(this.input).h(30).px(8).rounded(7).border_1().border_color(t.border).bg(t.background).text_size(12.5).text_color(t.foreground))
      .children(open.map(([x, i]) => this.row(x, i, t)))
      .when(done.length > 0, (el) => el
        .child(div().px(8).pt(6).text_size(11).text_color(t.dim).child(`done today · ${done.length}`))
        .children(done.map(([x, i]) => this.row(x, i, t))))
      .when(this.autoClosed.length > 0, (el) => el
        .child(div().px(8).pt(6).text_size(11).text_color(t.dim).child(`closed by itself today · ${this.autoClosed.length}`))
        .children(this.autoClosed.map((c, i) => this.closedRow(c, i, t))));
  }
}
