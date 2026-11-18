import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, home, notify, readTextFile, writeTextFile, settings, shared, setShared } from "herdr";

// Metabase light: green when both hogli logins work, pink when one has run out
// (click opens a tab that logs in again), grey while unknown. Checked every 15 min.
const MB_EVERY = 15 * 60 * 1000;
// Style swatches: one per mods/ella-scenes/scenes.json entry.
// Click one to switch the background and colours together (~/.local/bin/herdr-style).
const STYLES_FILE = ".config/herdr-app/mods/ella-scenes/scenes.json";
// The ✦ toggle after them plays the style's animated loop: while backgrounds/current.json
// says animated, swap the layout's background image to the next frame every `interval` ms.
const ANIMATION_WORKS = false;
const CURRENT_FILE = ".config/herdr-app/ella-style.json";
const LAYOUT_FILE = ".config/herdr-app/layouts/ella.json";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.mb = null;
    this.styles = [];
    this.current = null; // { id, animated }
    this.picking = null;
    this.frame = 0;
    this.playing = false;
    this.loadStyles(cx);
    cx.timer.every(4000, (cx) => this.loadStyles(cx)); // also catches `herdr-style` run from a terminal
    this.checkMb(cx);
    cx.timer.every(MB_EVERY, (cx) => this.checkMb(cx));
  }

  checkMb(cx) {
    cx.spawn(async (cx) => {
      const r = await exec(`${home()}/.local/bin/mb-status`, [], { timeout: 70000 }).catch(() => null);
      let next = null;
      try { next = r && r.code === 0 ? JSON.parse(r.stdout) : null; } catch { next = null; }
      const out = (s) => Object.keys(s ?? {}).filter((k) => s[k] === "out");
      if (next && out(next).length && !out(this.mb).length)
        notify({ title: "Metabase login ran out", body: `${out(next).join(" + ").toUpperCase()}: click the Metabase dot in the status bar to log in again`, level: "warning" });
      this.mb = next;
      cx.notify();
    });
  }

  loadStyles(cx) {
    cx.spawn(async (cx) => {
      try { this.styles = JSON.parse(await readTextFile(`${home()}/${STYLES_FILE}`)) ?? []; } catch { this.styles = []; }
      try { this.current = JSON.parse(await readTextFile(`${home()}/${CURRENT_FILE}`)); } catch { this.current = null; }
      // The pane headers (mods/ella-pane) colour their buttons from this.
      const buttons = this.styles.find((x) => x.id === (this.current?.id ?? "sunset"))?.buttons ?? null;
      if (JSON.stringify(buttons) !== JSON.stringify(shared("style.buttons") ?? null)) setShared("style.buttons", buttons);
      cx.notify();
      this.play(cx);
    });
  }

  // Runs herdr-style with these arguments, then re-reads what's chosen.
  style(args, key, cx) {
    if (this.picking) return;
    this.picking = key;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(`${home()}/.local/bin/herdr-style`, args, { timeout: 30000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "couldn't switch style", body: (r.stderr || r.stdout || "").trim().split("\n").pop(), level: "warning" });
      this.picking = null;
      this.frame = 0;
      this.loadStyles(cx);
    });
  }

  pick(style, cx) { this.style([style.id], style.id, cx); }

  // One loop at a time: each step shows the next frame, then waits the style's interval.
  // It stops by itself when the style is switched to static.
  play(cx) {
    if (this.playing || !this.current?.animated) return;
    this.playing = true;
    const step = (cx) => {
      const st = this.styles.find((x) => x.id === this.current?.id);
      if (!this.current?.animated || !st?.frames?.length) { this.playing = false; return; }
      cx.spawn(async (cx) => {
        const path = `${home()}/${LAYOUT_FILE}`;
        const text = await readTextFile(path).catch(() => null);
        if (text) {
          const next = (this.frame + 1) % st.frames.length;
          const swapped = text.replace(/("background":\s*\{[^}]*"image":\s*)"[^"]*"/, `$1"${st.frames[next]}"`);
          if (swapped !== text && (await writeTextFile(path, swapped, text).then(() => true).catch(() => false))) this.frame = next;
        }
        cx.timer.after(st.interval ?? 600, step);
      });
    };
    step(cx);
  }

  // Each swatch is a little three-band dot: sky, highlight, hills. The current one has a ring.
  swatches(t) {
    // settings().theme is the shown theme's name (or the light/dark pair, as in settings.json).
    const th = settings()?.theme;
    const current = typeof th === "string" ? th : th?.dark;
    const cur = this.styles.find((x) => x.id === this.current?.id);
    const moving = Boolean(this.current?.animated);
    const toggle = div().id("style-animate").ml(4).px(7).h(18).rounded(9).flex().items_center().cursor_pointer()
      .text_size(11).border_1().border_color(moving ? t.accent : t.border)
      .text_color(moving ? t.accent : t.dim).hover((s) => s.text_color(t.foreground))
      .tooltip(moving ? "animated: click for a still background" : "still: click to animate")
      .when(this.picking === "animate", (el) => el.opacity(0.5))
      .on_click((_e, cx) => this.style([moving ? "--static" : "--animated"], "animate", cx))
      .child(moving ? "✦ animated" : "✧ still");
    return h_flex().gap(6).items_center().children(this.styles.map((st) => {
      const on = st.theme === current;
      return div().id(`style-${st.id}`).size(16).rounded(8).p(2).cursor_pointer().tooltip(st.label)
        .border_1().border_color(on ? t.accent : "#00000000").hover((s) => s.border_color(t.muted))
        .when(this.picking === st.id, (el) => el.opacity(0.5))
        .on_click((_e, cx) => this.pick(st, cx))
        .child(div().size_full().flex().flex_col()
          .children(st.swatch.map((c, i) => div().w_full().flex_1().bg(c)
            .when(i === 0, (el) => el.rounded_t(6)).when(i === st.swatch.length - 1, (el) => el.rounded_b(6)))));
    // The toggle is hidden: Herdr blanks the background for a frame while each new image
    // loads, so swapping frames flashes (17 Nov 2026). Set ANIMATION_WORKS once Herdr can
    // play an animated background or keep the old image until the new one is ready.
    })).when(ANIMATION_WORKS && Boolean(cur?.frames?.length), (el) => el.child(toggle));
  }

  mbLogin(cx) {
    const out = Object.keys(this.mb ?? {}).filter((k) => this.mb[k] !== "ok");
    if (!out.length) { this.checkMb(cx); return; }
    const cmd = out.map((r) => `hogli metabase:login --region ${r} --browser dia`).join(" && ") +
      "; echo; echo 'all done, you can close this tab'; read -s -k";
    run("tab.new", { name: "metabase login", argv: ["zsh", "-ilc", cmd] });
    cx.timer.after(90000, (cx) => this.checkMb(cx));
  }

  metabase(t) {
    const s = this.mb;
    const out = s ? Object.keys(s).filter((k) => s[k] === "out") : [];
    const unknown = !s || Object.values(s).some((v) => v === "unknown");
    const color = out.length ? t.blocked : unknown ? t.dim : t.done;
    const text = out.length ? `Metabase · log in (${out.join(", ")})` : unknown ? "Metabase · ?" : "Metabase";
    return h_flex().id("mb").gap(6).items_center().cursor_pointer().hover((st) => st.text_color(t.foreground))
      .on_click((_e, cx) => this.mbLogin(cx))
      .child(div().size(7).rounded(4).bg(color))
      .child(div().text_color(out.length ? t.blocked : t.muted).child(text));
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(this.swatches(t))
      .child(this.metabase(t))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
