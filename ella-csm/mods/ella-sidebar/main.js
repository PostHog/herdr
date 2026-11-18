// The sidebar's sections (Spaces, Accounts, Agents, Pond, To-do) as one panel that
// scrolls as a whole. Each section is still its own mod's code, run here as a nested
// view through the links in sections/ (so edits to mods/todo etc. show up here too).
// Fold a section from its header as before; drag the strip under an open section to
// set its height. Heights and folds live in shared "sidebar.heights" / "sidebar.folded",
// the same keys fold.js uses, so the old one-block-per-section layout still works.

import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, shared, setShared, settings } from "herdr";
import Spaces from "./sections/ella-spaces/main.js";
import Accounts from "./sections/accounts/main.js";
import Agents from "./sections/ella-agents/main.js";
import Pond from "./sections/pond/main.js";
import Todo from "./sections/todo/main.js";
import { SECTIONS } from "./sections/todo/fold.js";
import { heightOf, dragTo, GRIP } from "./sizes.js";

// The sections paint square backgrounds; inset them so the corners stay inside the
// card's rounded ones (radius 12: a 4px inset clears the curve).
const INSET = 4;
const SCROLL_GUTTER = 12;
const CLASSES = { spaces: Spaces, accounts: Accounts, agents: Agents, pond: Pond, todo: Todo };

export default class Sidebar extends View {
  init(_props, cx) {
    this.views = Object.fromEntries(SECTIONS.map((s) => [s.id, cx.new(CLASSES[s.id])]));
    this.drag = null; // { id, y0, h0, h }
    this.over = null; // the grip under the pointer
    // Shared state changing redraws neither this panel nor the nested sections, so a
    // fold could leave the card and the section's header disagreeing. Watch the two
    // keys and redraw the panel and every section when they change.
    this.seen = this.sizes();
    cx.timer.every(150, (cx) => {
      const now = this.sizes();
      if (now === this.seen) return;
      this.seen = now;
      cx.notify();
      for (const v of Object.values(this.views)) cx.notify(v);
    });
  }

  sizes() {
    return JSON.stringify([shared("sidebar.folded") ?? {}, shared("sidebar.heights") ?? {}]);
  }

  endDrag(cx) {
    if (!this.drag) return;
    const { id, h } = this.drag;
    this.drag = null;
    setShared("sidebar.heights", { ...(shared("sidebar.heights") ?? {}), [id]: h });
    cx.notify();
  }

  render() {
    const t = theme();
    const folded = shared("sidebar.folded") ?? {};
    const heights = shared("sidebar.heights") ?? {};
    const zoom = settings()?.zoom ?? 1;
    const cards = [];
    for (const s of SECTIONS) {
      const open = !folded[s.id];
      const h = (this.drag?.id === s.id ? this.drag.h : heightOf(s, folded, heights)) + (folded[s.id] ? INSET * 2 : 0);
      cards.push(div().id(`sec-${s.id}`).flex_none().w_full().h(h).rounded(12).overflow_hidden()
        .bg(t.chrome).border_1().border_color(t.border).shadow_md().p(INSET)
        // Inside an open section the wheel scrolls only that section's list; over a
        // folded one or the gaps it reaches this panel and scrolls the whole sidebar.
        .when(open, (el) => el.on_scroll_wheel((_e, cx) => cx.stop_propagation()))
        .child(this.views[s.id]));
      // The strip under a section: drag it to resize (open sections only).
      const hot = open && (this.over === s.id || this.drag?.id === s.id);
      cards.push(div().id(`grip-${s.id}`).flex_none().w_full().h(GRIP).flex().items_center().justify_center()
        .when(open, (el) => el.cursor_row_resize()
          .on_hover((on, cx) => { this.over = on ? s.id : this.over === s.id ? null : this.over; cx.notify(); })
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.drag = { id: s.id, y0: e.position.y, h0: h, h }; cx.notify(); }))
        .child(div().w(36).h(4).rounded(2).bg(hot ? t.accent : "#00000000")));
    }
    // pr: a gutter for this panel's scrollbar, clear of the sections' own.
    return v_flex().id("sidebar-scroll").size_full().pr(SCROLL_GUTTER).overflow_y_scrollbar()
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        const h = dragTo(this.drag, e.position.y, zoom);
        if (h !== this.drag.h) { this.drag.h = h; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .children(cards);
  }
}
