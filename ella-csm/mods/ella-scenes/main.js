// Scenes: a popup of painted backgrounds, each with a matching colour theme. Click one
// to switch both. Opened with cmd-shift-y (keys.json) or `mod.open ella-scenes`. Esc closes.
//
// The background lives in the shown layout's file, and Herdr's own layouts (main,
// terminals, win98) are read-only, so on one of those the first pick clones it as
// "<name>-scenes" (Herdr switches to the clone) and sets the background there.
// The theme is applied now and saved as settings.json's dark theme, so it survives
// a restart. Other mods can colour themselves from shared "style.buttons".
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, props, closeOverlay, theme, settings, shared, setShared, run, notify, readTextFile, writeTextFile } from "herdr";

const SHIPPED = ["main", "terminals", "win98"];

export default class Scenes extends View {
  init(_props, cx) {
    this.scenes = [];
    this.busy = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try { this.scenes = JSON.parse(await readTextFile(`${appHome()}/mods/ella-scenes/scenes.json`)); } catch { this.scenes = []; }
      cx.notify();
    });
  }

  // The shown layout's file, cloning a shipped layout first.
  async layoutFile(cx) {
    let name = shared("layout") ?? "main";
    if (SHIPPED.includes(name)) {
      const as = `${name}-scenes`;
      if (!(await readTextFile(`${appHome()}/layouts/${as}.json`).catch(() => null))) run("layout.clone", { name, as });
      else run("layout.switch", { name: as });
      notify({ title: "Scenes", body: `Herdr's own layouts can't change, so this is now your copy, "${as}". ctrl-shift-l switches layouts.` });
      for (let i = 0; i < 20 && shared("layout") !== as; i++) await new Promise((r) => cx.timer.after(150, r));
      name = as;
    }
    return `${appHome()}/layouts/${name}.json`;
  }

  // Rewrites a JSON file, retrying if something else saved it in between.
  async edit(path, change) {
    for (let i = 0; i < 3; i++) {
      const text = await readTextFile(path);
      const data = JSON.parse(text);
      change(data);
      if (await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", text).then(() => true).catch(() => false)) return;
    }
    throw new Error(`couldn't save ${path}`);
  }

  pick(sc, cx) {
    if (this.busy) return;
    this.busy = sc.id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.edit(await this.layoutFile(cx), (l) => { l.background = { image: sc.image, fit: "cover" }; });
        await this.edit(`${appHome()}/settings.json`, (s) => {
          s.theme = typeof s.theme === "object" && s.theme ? { ...s.theme, dark: sc.theme } : { dark: sc.theme };
        });
        run("app.theme", { name: sc.theme });
        setShared("style.buttons", sc.buttons ?? null);
      } catch (e) {
        notify({ title: "Couldn't switch scene", body: String(e?.message ?? e), level: "warning" });
      }
      this.busy = null;
      cx.notify();
    });
  }

  card(sc, t, current) {
    const on = sc.theme === current;
    return v_flex().id(`scene-${sc.id}`).w(224).gap(6).p(6).rounded(10).cursor_pointer()
      .border_2().border_color(on ? t.accent : "#00000000").hover((s) => s.bg(t.hover))
      .when(this.busy === sc.id, (el) => el.opacity(0.5))
      .on_click((_e, cx) => this.pick(sc, cx))
      .child(div().w(212).h(119).rounded(7).overflow_hidden().child(image(sc.thumb).size_full()))
      .child(h_flex().gap(6).items_center().px(2)
        .child(h_flex().children(sc.swatch.map((c) => div().size(8).bg(c))).rounded(2).overflow_hidden())
        .child(div().text_size(12.5).text_color(on ? t.foreground : t.muted).child(sc.label)));
  }

  render() {
    const t = theme();
    const th = settings()?.theme;
    const current = typeof th === "string" ? th : th?.dark;
    return v_flex().id("scenes").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); } })
      .w_full().h(540).p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Scenes"))
        .child(div().text_size(11).text_color(t.dim).child("click to switch · Esc")))
      .child(div().id("scenes-grid").flex_1().min_h(0).overflow_y_scrollbar().flex().flex_wrap().gap(8)
        .children(this.scenes.map((sc) => this.card(sc, t, current))));
  }
}
