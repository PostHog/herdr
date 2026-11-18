// A meadow in the sidebar with one small creature per agent.
//   working  → sky-blue, drifts slowly side to side
//   resting  → grey, sits still, eyes shut, a little "z"
//   needs you → pink, bobs, with a pulsing pink glow and blush
//   finished while you weren't looking → green, happy eyes
//   to-do prep ready (todo-prep/<slug>.md written) → green with a sparkle
// Leaf colour is per space, so a space's creatures match.
// Hover: the caption shows where it lives and the pane-gist sentence for
// Claude panes (`pane-gist --cached`, refreshed by launchd every 2 min).
// Click: jump to that pane. All motion is native (.loop / .frames), no timers.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, home, agents, run, exec, readTextFile, watchFolder, settings, layout, shared, setShared, nextCommand, appHome } from "herdr";
import { toggle, isFolded } from "./fold.js";
const FOLD_ID = "pond";
const FOLD_DEPS = { layout, shared, setShared, run, readTextFile, appHome };
import { mood, MOODS, leafFor, place, driftMs, summary, readyTerminals, hash } from "./look.js";

const EYES = "#26302e"; // dark ink for eyes on every body colour, light or dark theme
// Sizes we draw are scaled by the app zoom; sizes reported back are not.
// No line_clamp in gpui-kit: cut long gists so the caption stays about three lines.
const clip = (text, n) => (text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text);
const unzoom = (px) => px / (Number(settings()?.zoom) || 1);

export default class Pond extends View {
  init(_props, cx) {
    this.width = 240;
    this.meadowW = 220;
    // "<mod>.fold" (keys or herdr-app do) folds or unfolds this section.
    cx.spawn(async () => { for (;;) { if ((await nextCommand()) === "fold") toggle(FOLD_ID, FOLD_DEPS); } });
    this.hover = null;
    this.gists = {};
    this.ready = new Set();
    this.prepDir = `${home()}/morning-launch/todo-prep`;
    this.loadPrep(cx);
    this.loadGists(cx);
    cx.timer.every(120000, (cx) => this.loadGists(cx));
    cx.timer.every(60000, (cx) => this.loadPrep(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(this.prepDir); } catch { return; }
        this.loadPrep(cx);
      }
    });
  }

  // Which to-do helpers have written their handover.
  loadPrep(cx) {
    cx.spawn(async (cx) => {
      // exec, not fs.readdir: fs needs a per-mod read grant, which the scrolling sidebar (ella-sidebar) lacks.
      const ls = await exec("/bin/ls", [this.prepDir]).catch(() => null);
      const names = ls?.code === 0 ? ls.stdout.split("\n").filter(Boolean) : [];
      const recs = [];
      for (const n of names.filter((n) => n.endsWith(".json"))) {
        try {
          const rec = JSON.parse(await readTextFile(`${this.prepDir}/${n}`));
          rec.ready = names.includes(n.replace(/\.json$/, ".md"));
          recs.push(rec);
        } catch { /* half-written record; next pass */ }
      }
      this.ready = readyTerminals(recs);
      cx.notify();
    });
  }

  loadGists(cx) {
    cx.spawn(async (cx) => {
      for (const a of agents().filter((a) => a.app === "claude-code")) await this.loadGist(a.address);
      cx.notify();
    });
  }

  async loadGist(address) {
    const r = await exec("zsh", [`${home()}/.local/bin/pane-gist`, "--cached", address], { timeout: 5000 }).catch(() => null);
    if (r?.code === 0 && r.stdout.trim()) this.gists[address] = r.stdout.trim();
  }

  jump(a) {
    run("space.select", { id: a.space });
    run("pane.focus", { terminal: a.address });
  }

  creature(a, spot, t) {
    const m = mood(a.status, this.ready.has(a.address));
    const look = MOODS[m];
    const body = t[look.body];
    const hovered = this.hover === a.address;
    const id = a.address;

    const face = v_flex().absolute().left(0).top(11).w(30).h(25).rounded(13).bg(body)
      .items_center().justify_center()
      .when(hovered || a.focused, (el) => el.border(1.5).border_color(hovered ? t.foreground : t.accent))
      .child(div().text_size(9).font_bold().text_color(EYES).child(look.eyes))
      .when(look.cheeks, (el) => el.child(h_flex().gap(12).mt(-1)
        .child(div().w(5).h(3).rounded(2).bg(t.ansi9 + "aa"))
        .child(div().w(5).h(3).rounded(2).bg(t.ansi9 + "aa"))));

    let bobber = div().id(`bob-${id}`).absolute().left(5).top(0).w(30).h(38)
      .child(svg("mods/ella-pond/sprout.svg").absolute().left(9).top(0).size(12).text_color(t[leafFor(a.space)]))
      .child(face)
      .when(Boolean(look.sparkle), (el) => el.child(div().id(`spk-${id}`).absolute().left(27).top(0).text_size(11).text_color(t.ansi11).frames(["✦", "✧", "⋆", "✧"], 420)))
      .when(Boolean(look.zzz), (el) => el.child(div().id(`z-${id}`).absolute().left(28).top(1).text_size(8).text_color(t.dim).frames(["z", "z", "zz", "zzz", "", ""], 900)));
    if (look.bob) bobber = bobber.loop("top", { from: 0, to: -look.bob, period: look.bobMs });

    let drifter = div().id(`drift-${id}`).absolute().left(0).top(0).w(40).h(48)
      .child(div().absolute().left(11).top(40).w(18).h(4).rounded(2).bg(t.canvas + "77"))
      .when(look.halo, (el) => el.child(div().id(`halo-${id}`).absolute().left(-1).top(5).w(42).h(38).rounded(21).bg(t.blocked + "44")
        .loop("opacity", { from: 0.25, to: 1, period: 1400 })))
      .child(bobber);
    if (look.drift) drifter = drifter.loop("left", { from: -look.drift, to: look.drift, period: driftMs(id) });

    return div().id(`c-${id}`).absolute().left(spot.x).top(spot.y).w(40).h(48).cursor_pointer()
      .on_hover((h, cx) => {
        this.hover = h ? id : this.hover === id ? null : this.hover;
        if (h && a.app === "claude-code" && !this.gists[id]) this.loadGist(id).then(() => cx.notify());
        cx.notify();
      })
      .on_click((_e, cx) => { cx.stop_propagation(); this.jump(a); })
      .child(drifter);
  }

  // Grass and a lily pad behind the creatures, placed from the meadow size.
  scenery(t, w, h) {
    const tufts = [];
    const n = Math.max(3, Math.floor(w / 46));
    for (let i = 0; i < n; i++) {
      const s = hash(`tuft${i}`);
      tufts.push(svg("mods/ella-pond/grass.svg").absolute()
        .left(Math.round((i + 0.5) * (w / n) - 9 + ((s % 15) - 7)))
        .top(Math.round(h - 16 - (s % 3) * Math.min(18, h / 4)))
        .w(18).h(12).text_color(t.ansi2 + "55"));
    }
    return [
      div().absolute().left(w - 64).top(h - 10).w(50).h(6).rounded(3).bg(t.ansi4 + "1f"),
      div().absolute().left(w - 42).top(h - 9).w(9).h(4).rounded(2).bg(t.ansi2 + "44"),
      ...tufts,
    ];
  }

  caption(list, moods, t) {
    const a = list.find((x) => x.address === this.hover);
    if (!a) {
      return div().px(4).text_size(11).text_color(t.dim).child(list.length ? summary(moods) : "no agents in the pond right now");
    }
    const where = [a.space_name, a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : null].filter(Boolean).join(" · ");
    const line = this.gists[a.address] ?? (a.app === "claude-code" ? "reading this session…" : a.title);
    return v_flex().px(4).gap(2)
      .child(div().text_size(11.5).font_medium().text_color(t.foreground).truncate().child(where || a.program?.name || a.address))
      .child(div().text_size(11).text_color(t.muted).max_h(62).overflow_hidden().child(clip(line ?? "", 120)));
  }

  // Sidebar folded to a rail: one dot per agent, coloured by mood.
  rail(list, t) {
    return v_flex().size_full().bg(t.chrome).items_center().gap(6).pt(10).overflow_y_scrollbar()
      .children(list.map((a) => {
        const m = mood(a.status, this.ready.has(a.address));
        let dot = div().id(`r-${a.address}`).size(10).rounded(5).bg(t[MOODS[m].body]).cursor_pointer()
          .on_click((_e, cx) => { cx.stop_propagation(); this.jump(a); });
        if (m === "needs") dot = dot.loop("opacity", { from: 0.35, to: 1, period: 1200 });
        return dot;
      }));
  }

  render(cx) {
    const t = theme();
    const list = agents();
    if (this.width < 160) {
      return div().id("root").size_full().on_size_change((s, cx) => { this.width = unzoom(s.width); cx.notify(); }).child(this.rail(list, t));
    }
    const moods = list.map((a) => mood(a.status, this.ready.has(a.address)));
    const w = this.meadowW;
    const { spots, height } = place(list.map((a) => a.address), w - 8);
    const h = Math.max(height, 72);
    const needs = moods.filter((m) => m === "needs").length;
    const folded = isFolded(FOLD_ID, shared);

    return v_flex().id("root").size_full().bg(t.chrome).px(10).pt(10).pb(6).gap(6)
      .on_size_change((s, cx) => { this.width = unzoom(s.width); cx.notify(); })
      .child(h_flex().px(8).items_center()
        .child(h_flex().id("fold-pond").flex_1().gap(5).items_center().text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click(() => toggle(FOLD_ID, FOLD_DEPS))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11)).child("Pond"))
        .when(needs > 0, (el) => el.child(div().text_size(11).font_semibold().text_color(t.blocked).child(`${needs} need${needs === 1 ? "s" : ""} you`))))
      .when(!folded, (el) => el.child(v_flex().id("meadow-scroll").flex_1().min_h(0).w_full().gap(8).overflow_y_scrollbar()
        .child(div().id("meadow").relative().w_full().h(h).rounded(10)
          .bg(t.background).border_1().border_color(t.border)
          .on_size_change((s, cx) => { const mw = unzoom(s.width); if (Math.abs(mw - this.meadowW) > 1) { this.meadowW = mw; cx.notify(); } })
          .children(this.scenery(t, w, h))
          .children(list.map((a, i) => this.creature(a, { x: spots[i].x + 4, y: spots[i].y }, t))))
        .child(div().flex_none().min_h(30).child(this.caption(list, moods, t)))));
  }
}
