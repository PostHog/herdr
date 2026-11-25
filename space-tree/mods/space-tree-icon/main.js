// The icon picker for a space: its default (GitHub avatar or first letter), or one of
// Lucide's icons, drawn on the space's color, searched by name and Lucide's tags. The
// choice goes in the shared map "space-tree.icons" (space id -> icon name), which the space tree reads.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { props, closeOverlay, theme, spaces, shared, setShared } from "herdr";
import { FEATURED, iconPath, loadLucide } from "./lucide.js";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const COLUMNS = 12;
const TILE = 32;
const GAP = 4;
function choices(tags, query) {
  if (!tags) return [null];
  const names = [...FEATURED, ...Object.keys(tags).filter((name) => !FEATURED.includes(name)).sort()];
  const q = query.trim().toLowerCase();
  if (!q) return [null, ...names];
  return names.filter((name) => name.includes(q) || (tags[name] ?? []).some((tag) => tag.split(/[\s-]/).some((word) => word.startsWith(q))));
}

export default class SpaceTreeIcon extends View {
  init(_props, cx) {
    this.query = "";
    this.tags = null;
    this.error = null;
    this.at = 0;
    cx.spawn(async (cx) => {
      try {
        this.tags = await loadLucide();
        const current = (shared("space-tree.icons") ?? {})[props()?.space] ?? null;
        this.at = Math.max(0, choices(this.tags, this.query).indexOf(current));
        this.scroll.scroll_to_item(Math.floor(this.at / COLUMNS), "center");
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
    this.input = InputState.new({ value: "", placeholder: "Search icons" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
    this.input.on("submit", () => this.pick(choices(this.tags, this.query)[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.column = 0;
    this.scroll = VirtualListScrollHandle.new();
  }

  pick(name) {
    const id = props()?.space;
    if (!id || name === undefined) return;
    const { [id]: _old, ...rest } = shared("space-tree.icons") ?? {};
    setShared("space-tree.icons", name ? { ...rest, [id]: name } : rest);
    closeOverlay(props()?.overlay);
  }

  move(step) {
    const n = choices(this.tags, this.query).length;
    this.at = Math.min(n - 1, Math.max(0, this.at + step));
    this.scroll.scroll_to_item(Math.floor(this.at / COLUMNS));
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.id === props()?.space);
    const color = (shared("space.colors") ?? {})[space?.id];
    const fill = color?.startsWith("#") ? color : (MARK[color] ?? t[color] ?? t.accent);
    const current = (shared("space-tree.icons") ?? {})[space?.id] ?? null;
    const avatar = (shared("space-tree.avatars") ?? {})[space?.id] ?? null;
    const tile = (name, i) => h_flex()
      .size(TILE)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(7)
      .border(2)
      .border_color(i === this.at ? t.accent : name === current ? t.border : "#00000000")
      .hover((s) => s.bg(t.hover))
      .child(!name && avatar
        ? image(avatar).size(22).rounded(6)
        : h_flex().size(22).rounded(6).bg(fill).items_center().justify_center().text_color("#ffffff")
          .child(name ? svg(iconPath(name)).size(14) : div().text_size(12).font_bold().child([...(space?.name ?? "?")][0].toUpperCase())));
    const rows = [];
    const list = choices(this.tags, this.query);
    for (let i = 0; i < list.length; i += COLUMNS) rows.push(list.slice(i, i + COLUMNS));
    return v_flex()
      .id("space-tree-icon")
      .track_focus(this.handle)
      .size_full()
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props()?.overlay);
        else if (e.key === "up" || e.key === "down") { this.move(e.key === "down" ? COLUMNS : -COLUMNS); cx.notify(); }
        else if (e.key === "tab") { this.move(e.modifiers?.shift ? -1 : 1); cx.notify(); }
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(13).font_semibold().child(`Icon for ${space?.name ?? "this space"}`))
      .child(Input.new(this.input).h(32).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(list.length
        // The list reports only which row was clicked, so the column comes from where the press landed.
        ? div().flex_1().min_h(0).relative()
          .on_mouse_down("left", (e) => { this.column = Math.min(COLUMNS - 1, Math.floor(e.local_position.x / (TILE + GAP))); })
          .child(v_virtual_list("icon-grid", rows.length, TILE + GAP, (r) => String(r),
            (range) => rows.slice(range.start, range.end).map((row, k) => h_flex().gap(GAP).children(row.map((name, c) => tile(name, (range.start + k) * COLUMNS + c)))))
            .size_full()
            .track_scroll(this.scroll)
            .on_item_click((key) => this.pick(rows[Number(key)]?.[this.column])))
          .child(Scrollbar.vertical("icon-grid").absolute().inset_0())
        : div().pt(8).text_size(12).text_color(t.dim).child(`No icon matches "${this.query.trim()}"`))
      .when(!this.tags, (el) => el.child(div().text_size(12).text_color(this.error ? t.blocked : t.dim).child(this.error ?? "Downloading Lucide's icons…")))
      .child(div().h(16).text_size(11.5).text_color(t.dim).child(list.length ? (list[this.at] ?? (avatar ? "GitHub avatar" : "First letter")) : ""));
  }
}
