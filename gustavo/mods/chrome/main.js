import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// The right sidebar (the "hogli" column: Flags numbers, hogli): to its rail and back, the same way.
// Its button is in the column's footer block, "right-foot".
// Shared "right.width" is the width it goes back to; hogli's rail reads it too.
const RIGHT = "hogli";
const narrowRight = () => (find(layout(), RIGHT)?.size?.px ?? Infinity) < 160;
function toggleRight() {
  const width = find(layout(), RIGHT)?.size?.px;
  if (!narrowRight()) {
    setShared("right.width", width);
    run("layout.hide", { id: "hogli-term" }); // the shell block never shows on the rail
  }
  run("layout.resize", { id: RIGHT, px: narrowRight() ? (shared("right.width") ?? 480) : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    // The right sidebar's footer: its fold button, at the bottom like the left one's Settings.
    if (props()?.right) {
      const folded = narrowRight();
      return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(folded ? 0 : 8).items_center()
        .when(folded, el => el.justify_center()).when(!folded, el => el.justify_end())
        .child(this.button("right-toggle", svg("mods/chrome/panel-right.svg").size(15), toggleRight)
          .tooltip(folded ? "Show the right sidebar" : "Hide the right sidebar"));
    }
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        // Gustavo's Settings (mods/settings): Herdr's, with the app's colors and the terminals' apart.
        .child(row("settings", "settings", "Settings", false, () => run("mod.open", { name: "settings" }))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))));
        // No "Add machine": the only other machines here are devboxes, which the tasks panel lists.
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
