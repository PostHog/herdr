// Full-window confetti for a few seconds when the review queue empties. squirrel-panel opens it.
import { View, div } from "gpui-kit";
import { props, closeOverlay, theme } from "herdr";

const DURATION = 3000, PIECES = 160;

export default class Confetti extends View {
  init(_props, cx) {
    const t = theme();
    const colors = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6, t.accent];
    this.size = { width: 1200, height: 800 };
    this.start = Date.now();
    // Each piece bursts up from the bottom edge, then falls with gravity and flutters.
    this.pieces = Array.from({ length: PIECES }, (_, i) => ({
      x: Math.random(), vx: (Math.random() - 0.5) * 0.5, vy: 0.9 + Math.random() * 0.5,
      w: 8 + Math.random() * 8, h: 10 + Math.random() * 10, spin: 4 + Math.random() * 10, phase: Math.random() * 6,
      color: colors[i % colors.length], round: Math.random() < 0.3,
    }));
    cx.spawn(async (cx) => {
      while (Date.now() - this.start < DURATION) { await cx.sleep(16); cx.notify(); }
      closeOverlay(props().overlay);
    });
  }

  render() {
    const { width, height } = this.size;
    const s = (Date.now() - this.start) / 1000;
    const fade = Math.min(1, Math.max(0, (DURATION / 1000 - s) / 0.6));
    return div().id("confetti").size_full().relative()
      .on_size_change((size) => { this.size = size; })
      .on_click(() => closeOverlay(props().overlay))
      .children(this.pieces.map((p) => {
        const x = (p.x + p.vx * s) * width;
        const y = height - (p.vy * s - 0.45 * s * s) * height;
        const flip = Math.abs(Math.cos(p.phase + p.spin * s));
        return div().absolute().left(x).top(y).w(Math.max(1, p.w * flip)).h(p.h).bg(p.color)
          .rounded(p.round ? 8 : 1).opacity(fade);
      }));
  }
}
