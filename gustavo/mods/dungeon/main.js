// Server Dungeon: the tasks as rooms of a data-center dungeon, in pixel art, one card per task.
//
// Each task (a Herdr space) is a card with a room; each Claude session in it is one of PostHog's
// hoggies: hard at work, shouting for you (red room with a locked door, the question under it),
// celebrating (ready for review) or asleep (lights off). A problem on the task's PRs (failing checks,
// conflicts, changes asked) makes its racks smoke. Each card says its status in words; the ones that
// need you come first.
// In your support hero weeks a band on top lists the tickets that wait on the team.
// Click a card to go to that task's session. Lives in the main area's view stack (layout block
// "dungeon"), switched to from the tasks mod's Work / Inbox / Grafana / Dungeon bar.
//
// The art is drawn ahead of time (bake.mjs → sprites/, sprites.js): this only places images.

import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, checking, exec, run, setShared, shared, spaces } from "herdr";
import SPRITES, { HOGGIE_SIZES } from "./sprites.js";
import { ORDER, roomSprites, SCALES, SCENE, taskStatus } from "./room.js";

const VIEWS = "main-stack"; // the layout stack this view lives in; "main" is the Work view
const NOT_TASKS = ["tasks.devboxSpace", "tasks.looseSpace"]; // spaces the tasks mod keeps apart, besides tasks.setup
const PRS = "tasks.prs"; // { [spaceId]: { [prKey]: url } }, kept by the tasks mod
const PRINFO = "tasks.prinfo"; // { [prKey]: what GitHub says about it }, kept by the tasks mod
const ASKING = "tasks.asking"; // { [terminal address]: question }: sessions that ended their turn asking you, kept by the tasks mod
const DISMISSED = "tasks.dismissed"; // { [terminal address]: seq }: ones put aside in the Inbox until they change
const HERO = "tasks.hero"; // { shifts: [{ name, me, start, end }] }: the support hero rotation, kept by the tasks mod
const SUPPORT = "tasks.support"; // { at, items: [ticket], setup? }: the team's open support tickets, kept by the tasks mod
const REVEAL = "tasks.reveal"; // tells the tasks sidebar to unfold a task and select a session
const MONO = "JetBrains Mono";
const PAD = 16, GAP = 12;
const TOP_H = 64, BAND_H = 120; // the top bar's height, and the support band's (with its gap)

// Fixed game palette: the dungeon looks the same in light and dark themes.
const C = {
  void: "#1C1D19", ink: "#151515", ink2: "#23251D", card: "#2B2D26", paper: "#EEEFE9", paper2: "#D2D3CC", muted: "#8A8C82", dim: "#5A5C55",
  orange: "#F54E00", yellow: "#F9BD2B", red: "#F04F58", blue: "#1D4AFF", white: "#FFFFFF", green: "#5BE37D", text: "#E8E9E2",
};
// What each status is called and its colors, on the cards and the counts alike.
const STATUS = {
  blocked: { word: "Needs you", bg: C.red, fg: C.white },
  done: { word: "Ready", bg: C.green, fg: C.ink },
  working: { word: "Working", bg: C.blue, fg: C.white },
  idle: { word: "Idle", bg: "#3A3C36", fg: "#C9CAC1" },
};

// What's wrong with an open PR, most blocking first; null when nothing is.
function prProblem(i) {
  if (!i || i.missing || i.state !== "OPEN") return null;
  if (i.conflicts) return "Conflicts";
  if (i.checks?.fail) return "CI failing";
  if (i.decision === "CHANGES_REQUESTED") return "Changes requested";
  return null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// A session's terminal title without the spinner or status glyphs agents put in front.
const cleanTitle = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

export default class Dungeon extends View {
  init() {
    this.size = null;
    this.hover = null; // the hovered card's task id
    this.asks = {}; // blocked terminal address → the question on its screen
    this.reading = new Set();
  }

  // Tasks as the cards want them: every space that isn't setup, with one session per tab that runs an
  // agent; `k` is its place among the spaces (it picks the heroes' classes, so they stay as cards move).
  tasks() {
    const notTasks = new Set([...(shared("tasks.setup") ?? []), ...NOT_TASKS.map((k) => shared(k)).filter(Boolean)]);
    // A session that ended its turn asking you something needs you, though Herdr calls it done or idle.
    const asking = shared(ASKING) ?? {}, dismissed = shared(DISMISSED) ?? {};
    const ag = agents().map((a) => (a.status === "done" || a.status === "idle") && asking[a.address] && dismissed[a.address] !== a.seq
      ? { ...a, status: "blocked", asked: asking[a.address] } : a);
    const prs = shared(PRS) ?? {}, info = shared(PRINFO) ?? {};
    return spaces().filter((s) => !notTasks.has(s.id)).map((s, k) => ({
      id: s.id,
      k,
      name: s.name,
      prs: Object.keys(prs[s.id] ?? {}).length,
      problem: Object.keys(prs[s.id] ?? {}).map((key) => prProblem(info[key])).find(Boolean) ?? null,
      sessions: s.tabs.flatMap((tab) => {
        const mine = ag.filter((a) => a.tab === tab.id);
        if (!mine.length) return [];
        const status = ORDER.find((st) => mine.some((a) => a.status === st));
        const lead = mine.find((a) => a.status === status);
        return [{ id: tab.id, space: s.id, name: tab.named ? tab.name : cleanTitle(lead.title) || `Session ${tab.index}`, status, address: lead.address, asked: Boolean(lead.asked), ask: lead.asked ?? this.asks[lead.address] ?? "" }];
      }),
    }));
  }

  // Reads the question a newly blocked session shows (the lowest line that ends with "?"), once per block.
  readAsks(tasks, cx) {
    const blocked = tasks.flatMap((t) => t.sessions).filter((s) => s.status === "blocked" && !s.asked); // the tasks mod read the others
    const live = new Set(blocked.map((s) => s.address));
    for (const k of Object.keys(this.asks)) if (!live.has(k)) delete this.asks[k];
    for (const s of blocked) {
      if (s.address in this.asks || this.reading.has(s.address)) continue;
      this.reading.add(s.address);
      cx.spawn(async (cx) => {
        const r = await exec("hc", ["read", s.address, "--lines", "80"]).catch(() => null);
        const lines = (r?.stdout ?? "").split("\n").map((l) => l.replace(/^[\s│┃╭╰╮╯─━❯›>⎿⏺●•◆□☐✳*]+/u, "").trim()).reverse();
        const ask = lines.find((l) => l.length >= 10 && /\p{L}/u.test(l) && /\?(\s|\)|$)/.test(l) && !l.startsWith("?") && !/shortcuts/i.test(l)) ?? "";
        this.asks[s.address] = ask.length > 200 ? ask.slice(0, 199) + "…" : ask;
        this.reading.delete(s.address);
        cx.notify();
      });
    }
  }

  // Your support hero turn, from the rotation and tickets the tasks mod reads, or null the other weeks.
  support() {
    const now = Date.now();
    const shift = (shared(HERO)?.shifts ?? []).find((x) => x.start <= now && now < x.end);
    if (!shift?.me) return null;
    const state = shared(SUPPORT) ?? {};
    const items = state.items ?? [];
    // Waits on the team: new, or the customer wrote and nobody on the team read it (as the tasks mod counts).
    const waiting = items.filter((x) => x.status === "new" || x.unread > 0).sort((a, b) => b.updated - a.updated);
    return { waiting, open: items.length, until: shift.end, read: Boolean(state.at), setup: Boolean(state.setup) };
  }

  // Shows the task's most urgent session in the Work view.
  go(task) {
    const s = ORDER.map((st) => task.sessions.find((x) => x.status === st)).find(Boolean);
    run("layout.select", { stack: VIEWS, child: "main" });
    run("space.select", { id: task.id });
    if (!s) return;
    setShared(REVEAL, { space: task.id, tab: s.id, at: Date.now() });
    run("tab.select", { id: s.id });
    run("agent.focus", { terminal: s.address });
  }

  render(cx) {
    const root = v_flex().id("root").size_full().bg(C.void).font_family(MONO)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); });
    if (!this.size) return root;
    const tasks = this.tasks(), support = this.support();
    if (!checking()) this.readAsks(tasks, cx);
    // The ones that need you first; among the same status, a PR problem first, then as the sidebar has them.
    const cards = [...tasks].sort((a, b) => ORDER.indexOf(taskStatus(a)) - ORDER.indexOf(taskStatus(b))
      || Boolean(b.problem) - Boolean(a.problem) || a.k - b.k);
    const s = this.cardScale(cards, this.size.width - 2 * PAD, this.size.height - TOP_H - (support ? BAND_H : 0) - PAD);
    return root
      .child(this.topBar(tasks, support))
      .child(v_flex().id("dg-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(PAD).pb(PAD).gap(GAP)
        .when(Boolean(support), (el) => el.child(this.supportBand(support)))
        .child(h_flex().flex_wrap().gap(GAP).children(cards.map((t) => this.card(t, s))))
        .when(!tasks.length, (el) => el.child(v_flex().items_center().gap(6).py(48)
          .child(div().text_size(16).font_bold().text_color(C.yellow).child("The dungeon is empty"))
          .child(div().text_size(12).text_color(C.muted).child("Start a task and its heroes move in.")))));
  }

  // The biggest cards that all fit on screen; the smallest (scrolling) when none do.
  cardScale(cards, width, height) {
    const cardH = (t, s) => 70 + SCENE.h * s + 16 + 22 * t.sessions.filter((x) => x.status !== "blocked").length
      + 80 * t.sessions.filter((x) => x.status === "blocked").length;
    return SCALES.find((s) => {
      const perRow = Math.floor((width + GAP) / (SCENE.w * s + 4 + GAP));
      if (perRow < 1) return false;
      let total = 0;
      for (let i = 0; i < cards.length; i += perRow) total += Math.max(...cards.slice(i, i + perRow).map((t) => cardH(t, s))) + GAP;
      return total <= height;
    }) ?? SCALES[SCALES.length - 1];
  }

  // ---- pieces ----

  // A baked sprite (sprites.js) as an image, placed in art pixels at scale s, with its loops.
  sprite(sp, s) {
    const e = SPRITES[`${sp.key}@${s}`];
    if (!e) return null;
    const [path, dx, dy, w, h] = e;
    const x = (sp.x + dx) * s, y = (sp.y + dy) * s;
    let el = image(path).absolute().left(x).top(y).w(w * s).h(h * s);
    for (const a of sp.anim ?? []) {
      if (a.prop === "opacity") el = el.loop("opacity", { from: a.from, to: a.to, period: a.period });
      else el = el.loop(a.prop, { from: a.prop === "top" ? y : x, to: (a.prop === "top" ? y : x) + a.by * s, period: a.period });
    }
    return el;
  }

  // A hoggie (hoggies/<name>.png) as big as fits in maxW x maxH logical pixels, its feet at (x, y).
  hoggie(name, x, y, maxW, maxH, anim = []) {
    const [pw, ph] = HOGGIE_SIZES[name] ?? [1, 1];
    const k = Math.min(maxW / pw, maxH / ph), w = pw * k, h = ph * k;
    const top = y - h * 0.96; // its shadow reaches a little below its feet
    let el = image(`mods/dungeon/hoggies/${name}.png`).absolute().left(x - w / 2).top(top).w(w).h(h);
    for (const a of anim) el = el.loop("top", { from: top, to: top + a.by, period: a.period });
    return el;
  }

  icon(kind) {
    const box = div().flex_none().w(20).h(20).relative();
    const sp = this.sprite({ key: `icon-${kind}`, x: 0, y: 0 }, 1);
    return sp ? box.child(sp) : box;
  }

  chip(icon, word, bg, fg, pulse = false) {
    return h_flex().flex_none().gap(4).items_center().pl(3).pr(7).h(24).bg(bg).text_color(fg).border_2().border_color(C.ink)
      .text_size(11.5).font_bold().whitespace_nowrap()
      .when(pulse, (el) => el.loop("opacity", { from: 1, to: 0.55, period: 700 }))
      .when(Boolean(icon), (el) => el.child(this.icon(icon))).child(word.toUpperCase());
  }

  // The bar on top: the title and how many tasks are in each status (a zero fades).
  topBar(tasks, support) {
    const count = { blocked: 0, problem: 0, done: 0, working: 0, idle: 0 };
    for (const t of tasks) { count[taskStatus(t)]++; if (t.problem) count.problem++; }
    if (support?.waiting.length) count.blocked++;
    const stat = (k, label, bg, fg) => count[k] ? this.chip(k, `${count[k]} ${label}`, bg, fg, k === "blocked")
      : this.chip(null, `0 ${label}`, C.ink2, C.dim);
    const logo = this.hoggie("workmaxxing", 22, 42, 44, 42);
    return h_flex().flex_none().flex_wrap().gap(8).items_center().px(PAD).py(12)
      .child(h_flex().gap(6).items_center().mr(8)
        .child(div().relative().w(44).h(42).flex_none().child(logo))
        .child(v_flex()
          .child(div().text_size(17).font_bold().text_color(C.yellow).child("SERVER DUNGEON"))
          .child(div().text_size(10.5).text_color(C.muted).child(`${plural(tasks.length, "task")} · ${plural(tasks.reduce((n, t) => n + t.sessions.length, 0), "session")}`))))
      .child(stat("blocked", "need you", C.red, C.white))
      .child(stat("problem", "PR problems", C.orange, C.white))
      .child(stat("done", "ready", C.green, C.ink))
      .child(stat("working", "working", C.blue, C.white))
      .child(stat("idle", "idle", "#3A3C36", "#C9CAC1"));
  }

  // One task: its status and name, its room, and what it asks you or what its sessions are doing.
  card(t, s) {
    const st = taskStatus(t), S = STATUS[st], on = this.hover === t.id;
    const w = SCENE.w * s;
    const asking = t.sessions.filter((x) => x.status === "blocked");
    const others = t.sessions.filter((x) => x.status !== "blocked");
    const shown = others.slice(0, 4);
    return v_flex().id(`dg-card-${t.id}`).w(w + 4).flex_none().bg(C.card).border_2().border_color(on ? C.yellow : S.bg).cursor_pointer()
      .on_hover((h, cx) => { if (h) this.hover = t.id; else if (this.hover === t.id) this.hover = null; cx.notify(); })
      .on_click(() => this.go(t))
      .child(v_flex().gap(6).px(8).pt(8).pb(6)
        .child(h_flex().gap(6).items_center()
          .child(this.chip(st, S.word, S.bg, S.fg, st === "blocked"))
          .when(Boolean(t.problem), (el) => el.child(this.chip("problem", t.problem, C.orange, C.white)))
          .child(div().flex_1())
          .when(t.prs > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(C.muted).child(plural(t.prs, "PR")))))
        .child(div().text_size(13.5).font_bold().text_color(C.text).truncate().child(t.name)))
      .child(div().relative().w(w).h(SCENE.h * s).overflow_hidden().bg(C.void)
        .children(roomSprites(t, t.k).map((sp) => sp.hoggie
          ? this.hoggie(sp.hoggie, sp.x * s, sp.y * s, sp.w * s, sp.h * s, st === "blocked" ? [{ by: -3 * s, period: 700 }] : [])
          : this.sprite(sp, s)).filter(Boolean)))
      .child(v_flex().gap(6).p(8)
        .children(asking.map((x) => v_flex().gap(2).px(7).py(5).bg(C.yellow).border_2().border_color(C.ink).text_color(C.ink)
          .child(div().text_size(10.5).font_bold().truncate().child(x.name))
          .child(div().text_size(12).font_semibold().max_h(64).overflow_hidden().child(x.ask || "Waiting for your answer"))))
        .children(shown.map((x) => h_flex().gap(6).items_center()
          .child(div().flex_none().w(8).h(8).bg(STATUS[x.status].bg).border_1().border_color(C.ink))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(C.text).child(x.name))
          .child(div().flex_none().text_size(10.5).text_color(C.muted).child(STATUS[x.status].word.toLowerCase()))))
        .when(others.length > shown.length, (el) => el.child(div().text_size(10.5).text_color(C.muted).child(`${others.length - shown.length} more`)))
        .when(!t.sessions.length, (el) => el.child(div().text_size(11.5).text_color(C.muted).child("No sessions"))));
  }

  // Your support hero turn: you on duty, and the tickets that wait on the team (a click opens one).
  // The header opens the Inbox, where they're listed in full.
  supportBand(sup) {
    const n = sup.waiting.length;
    // On duty: a superhero; with mail waiting, the mailbox one.
    const hog = this.hoggie(n ? "mailbox" : "superhero", 34, 64, 68, 62, n ? [{ by: -4, period: 700 }] : []);
    const note = (text, color = C.muted) => div().py(4).text_size(12).text_color(color).child(text);
    const tickets = sup.setup ? [note("Connect PostHog in the sidebar's Support hero section to see the tickets.", C.red)]
      : !n ? [note(sup.read ? `Nothing waits on the team · ${plural(sup.open, "open ticket")}` : "Reading tickets…")]
      : sup.waiting.slice(0, 4).map((x) => h_flex().id(`dg-tk-${x.id}`).gap(8).items_center().px(6).py(4).bg(C.ink2).cursor_pointer()
        .hover((el) => el.bg("#3A2A2B"))
        .on_click(() => exec("open", [x.url]))
        .child(this.icon("support"))
        .child(div().flex_none().text_size(12).font_bold().text_color(C.yellow).child(`#${x.number}`))
        .child(div().flex_none().max_w(200).truncate().text_size(12).font_bold().text_color(C.text).child(x.customer || "Customer"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(C.muted).child(x.subject || x.last || "No subject"))
        .child(div().flex_none().px(5).border_1().border_color(C.ink).bg(C.red).text_color(C.white).text_size(10).font_bold()
          .child(x.status === "new" ? "NEW" : `${x.unread} UNREAD`)));
    return v_flex().flex_none().bg(C.card).border_2().border_color(n ? C.red : C.blue)
      .child(h_flex().id("dg-support").gap(8).items_center().px(8).py(6).cursor_pointer()
        .on_click(() => run("layout.select", { stack: VIEWS, child: "inbox" }))
        .child(this.chip("support", "Support hero", n ? C.red : C.blue, C.white, n > 0))
        .child(div().flex_1().text_size(11.5).text_color(C.muted).child(`You're on duty until ${DAYS[new Date(sup.until).getDay()]}`))
        .when(n > 4, (el) => el.child(div().text_size(11).text_color(C.muted).child(`${n - 4} more in the Inbox`))))
      .child(h_flex().gap(10).items_center().px(8).pb(8)
        .child(div().relative().flex_none().w(68).h(64).child(hog))
        .child(v_flex().flex_1().min_w(0).gap(4).children(tickets)));
  }
}
