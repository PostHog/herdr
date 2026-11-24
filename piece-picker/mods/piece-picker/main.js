import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, appHome, theme, props, closeOverlay, shared, layout, keys, window } from "herdr";
import { scan, summaryOf, enabledFrom, reportOf, layoutMods, placeOf } from "./pieces.js";

const SELF = "piece-picker";

export default class PiecePicker extends View {
  init(_props, cx) {
    this.repo = null;
    this.pieces = null;
    this.enabled = new Set();
    this.busy = null;
    this.message = null;
    this.shown = new Set();
    cx.spawn(async (cx) => {
      await this.read();
      cx.notify();
    });
  }

  async read() {
    try {
      const repo = (await readTextFile(`${appHome()}/.posthog-herdr-repo`))?.trim();
      if (!repo || (await readTextFile(`${repo}/install.sh`)) === null) {
        this.repo = null;
        this.pieces = [];
        const where = repo ? `No install.sh at ${repo}. ` : "";
        this.message = { level: "error", text: `${where}Run ./install.sh once in your herdr checkout, then open this again.` };
        return;
      }
      const found = await exec("find", [repo, "-mindepth", "2", "-maxdepth", "4", "-type", "f", "(", "-name", "RECIPE.md", "-o", "-path", "*/layouts/*.json", "-o", "-path", "*/mods/*/mod.json", ")"]);
      const list = scan(found.stdout, repo);
      const recipes = await Promise.all(list.map((p) => readTextFile(`${repo}/${p.name}/RECIPE.md`)));
      list.forEach((p, i) => (p.summary = summaryOf(recipes[i] ?? "")));
      this.enabled = enabledFrom(await readTextFile(`${appHome()}/.posthog-herdr-enabled`));
      this.shown = await this.shownMods();
      this.repo = repo;
      this.pieces = list;
    } catch (e) {
      this.pieces = this.pieces ?? [];
      this.message = { level: "error", text: String(e?.message ?? e) };
    }
  }

  // The mods the layout on screen places, and the mods those draw into it
  // (space-tree draws coder-devbox's globe, for one), found by their `mods/<name>/` paths.
  async shownMods() {
    const placed = layoutMods(layout());
    const shown = new Set(placed);
    for (const mod of placed) {
      const code = (await readTextFile(`${appHome()}/mods/${mod}/main.js`).catch(() => null)) ?? "";
      for (const m of code.matchAll(/mods\/([a-z0-9-]+)\//g)) shown.add(m[1]);
    }
    return shown;
  }

  install(label, args, cx) {
    if (this.busy || !this.repo) return;
    this.busy = label;
    this.message = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const env = [`HERDR_APP_HOME=${appHome()}`, "GIT_TERMINAL_PROMPT=0"];
        const result = await exec("env", [...env, `${this.repo}/install.sh`, ...args], { timeout: 600000 });
        this.message = reportOf(result, { keys: label !== "update" });
      } catch (e) {
        this.message = { level: "error", text: String(e?.message ?? e) };
      }
      await this.read();
      this.busy = null;
      cx.notify();
    });
  }

  toggle(piece, cx) {
    const on = this.enabled.has(piece.name);
    if (on && piece.layouts.includes(shared("layout"))) {
      this.message = { level: "error", text: `${piece.name} owns the layout on screen. Switch layouts first (cmd-shift-l).` };
      cx.notify();
      return;
    }
    this.install(piece.name, [on ? "disable" : "enable", piece.name, "--no-pull"], cx);
  }

  control(t, piece) {
    if (this.busy === piece.name) return svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.working).spin(900);
    const on = this.enabled.has(piece.name);
    const locked = piece.name === SELF;
    const idle = !this.busy && !locked;
    return div()
      .id(`pp-toggle-${piece.name}`)
      .w(36)
      .h(20)
      .rounded(10)
      .p(2)
      .flex()
      .bg(on ? t.accent : t.hover)
      .opacity(idle ? 1 : 0.5)
      .when(on, (el) => el.justify_end())
      .when(idle, (el) => el.cursor_pointer().on_click((_e, cx) => this.toggle(piece, cx)))
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
  }

  row(t, piece) {
    const about = piece.name === SELF ? "This menu. It stays on." : piece.summary;
    const place = placeOf(piece, { layout: shared("layout"), shown: this.shown, bindings: keys(), mac: window()?.platform === "macos" });
    return h_flex()
      .w_full()
      .gap(16)
      .py(10)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(14).text_color(t.foreground).child(piece.name))
          .child(div().text_size(12.5).text_color(t.dim).truncate().child(about))
          .child(div().text_size(12).text_color(place.here ? t.accent : t.muted).truncate().child(place.text)),
      )
      .child(div().flex_none().child(this.control(t, piece)));
  }

  button(t, id, label, onClick) {
    return div()
      .id(id)
      .px(12)
      .py(5)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .cursor_pointer()
      .text_size(13)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(label);
  }

  render(cx) {
    const t = theme();
    const color = { error: t.blocked, warn: t.ansi3 };
    return v_flex()
      .id("root")
      .w_full()
      .p(20)
      .gap(12)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            v_flex()
              .min_w(0)
              .gap(2)
              .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Herdr pieces"))
              .when(Boolean(this.repo), (el) => el.child(div().text_size(12).text_color(t.dim).truncate().child(this.repo))),
          )
          .child(
            this.busy === "update"
              ? svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.working).spin(900)
              : this.button(t, "pp-update", "Update", (_e, cx) => this.install("update", [], cx)),
          ),
      )
      .child(
        v_flex()
          .id("pp-list")
          .h(440)
          .overflow_y_scrollbar()
          .when(this.pieces === null, (el) => el.child(div().py(14).text_size(12.5).text_color(t.dim).child("Reading pieces…")))
          .children((this.pieces ?? []).map((p) => this.row(t, p))),
      )
      .when(Boolean(this.message), (el) =>
        el.child(div().text_size(12.5).line_height("18px").text_color(color[this.message.level] ?? t.dim).child(this.message.text)),
      )
      .child(
        h_flex()
          .justify_end()
          .child(this.button(t, "pp-done", "Done", () => closeOverlay(props().overlay))),
      );
  }
}
