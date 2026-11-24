// Herdr's `workspace-status` bar, plus a hint for each key bound to a mod this repo installed
// (`mod.open:<mod>` or one of its commands, `<mod>.<command>`), so the shortcuts pieces add
// show beside the palette's.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, readTextFile, appHome } from "herdr";

const MANIFEST = ".posthog-herdr-files";
const REFRESH_MS = 5000;

function keyLabel(keys) {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const parts = keys.endsWith("--") ? [...keys.slice(0, -2).split("-"), "-"] : keys.split("-");
  return parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
}

// The mod a binding belongs to, and how to run it.
function target(action) {
  if (action.startsWith("mod.open:")) {
    const name = action.slice("mod.open:".length);
    return { mod: name, go: () => run("mod.open", { name }) };
  }
  const dot = action.indexOf(".");
  return dot > 0 ? { mod: action.slice(0, dot), go: () => run(action) } : null;
}

export default class SpaceTreeStatus extends View {
  init(_props, cx) {
    this.titles = {}; // mod -> its mod.json title, for mods this repo installed
    cx.timer.every(REFRESH_MS, (cx) => this.load(cx));
    this.load(cx);
  }

  // Installing or removing a piece changes the manifest, so it is read again now and then.
  load(cx) {
    cx.spawn(async (cx) => {
      const manifest = (await readTextFile(`${appHome()}/${MANIFEST}`).catch(() => null)) ?? "";
      const mods = [...new Set(manifest.split("\n").map((line) => line.split("\t")[1]?.match(/^mods\/([^/]+)\/mod\.json$/)?.[1]).filter(Boolean))];
      const titles = {};
      for (const mod of mods) {
        try { titles[mod] = JSON.parse((await readTextFile(`${appHome()}/mods/${mod}/mod.json`)) ?? "{}").title ?? mod; } catch { titles[mod] = mod; }
      }
      if (JSON.stringify(titles) !== JSON.stringify(this.titles)) { this.titles = titles; cx.notify(); }
    });
  }

  shortcuts() {
    return keys()
      .filter((k) => k.section === "global")
      .map((k) => ({ ...k, ...target(k.action) }))
      .filter((k) => k.mod && this.titles[k.mod]);
  }

  // The palette key as actually bound; without a binding the hint still says "commands".
  paletteHint() {
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    return b ? `${keyLabel(b.keys)}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().flex_none().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const hint = (id, text, go) => div().id(id).flex_none().text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.muted)).on_click(go).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().flex_none().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} ${list.length === 1 ? "agent" : "agents"}`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} ${needs === 1 ? "needs" : "need"} you`))))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().justify_end().gap(16)
        .children(this.shortcuts().map((k) => hint(`key-${k.keys}`, `${keyLabel(k.keys)}  ${this.titles[k.mod]}`, k.go)))
        .child(hint("palette", this.paletteHint(), () => run("app.palette"))));
  }
}
