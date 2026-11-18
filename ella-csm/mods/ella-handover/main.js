// A to-do helper's handover (or any markdown file) as a read-only page.
// Props: { file }. Re-reads when the file's folder changes.

import { View, div } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { theme, props, readTextFile, watchFolder } from "herdr";

export default class Handover extends View {
  init(_props, cx) {
    this.file = props()?.file ?? null;
    this.text = null;
    this.reload(cx);
    const dir = this.file?.replace(/\/[^/]*$/, "");
    if (dir) cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(dir); } catch { return; }
        this.reload(cx);
      }
    });
  }

  reload(cx) {
    if (!this.file) return;
    cx.spawn(async (cx) => {
      this.text = await readTextFile(this.file).catch(() => null);
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const body = this.text === null
      ? div().text_color(t.dim).child(this.file ? `Can't read ${this.file}` : "No file given")
      : div().text_size(13).text_color(t.foreground).child(TextView.markdown("handover-md", this.text).selectable(true));
    return v_flex().size_full().bg(t.canvas).p(18).overflow_y_scrollbar()
      .child(v_flex().w_full().max_w(760).child(body));
  }
}
