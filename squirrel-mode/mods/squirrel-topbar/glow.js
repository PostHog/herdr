import { div } from "gpui-kit";

// The top bar's glow: soft neon bands drifting left and right over the normal bar colour, fading
// between neighbouring hues. An inset keeps a rim of the regular colour around it.
const NEON = ["#ff00ff", "#00ffff", "#39ff14", "#ffff00", "#ff6ec7", "#7df9ff", "#fe019a", "#bc13fe", "#ff073a", "#0ff0fc", "#ccff00", "#ff9933"];
const SECONDS_PER_COLOUR = 7;
function neon(seconds) {
  const x = seconds / SECONDS_PER_COLOUR, i = ((Math.floor(x) % NEON.length) + NEON.length) % NEON.length, f = x - Math.floor(x), e = f * f * (3 - 2 * f);
  const rgb = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  const a = rgb(NEON[i]), b = rgb(NEON[(i + 1) % NEON.length]);
  return "#" + a.map((v, k) => Math.round(v + (b[k] - v) * e).toString(16).padStart(2, "0")).join("");
}
const SLICES = 24;
export function glow(width, height) {
  const t = Date.now() / 1000, bands = 5;
  return div().absolute().top(3).bottom(3).left(3).right(3).rounded(8).overflow_hidden()
    .children(Array.from({ length: bands }, (_, i) => {
      // Each band sits a little further along the colour cycle than its neighbour, and sways at its own pace.
      // A band is thin slices whose alpha follows a bell curve, which reads as a soft gradient.
      const colour = neon(t + i * 1.4), bw = width * (0.32 + 0.08 * Math.sin(t * 0.21 + i * 1.7));
      const centre = width * ((i + 0.5) / bands) + Math.sin(t * (0.13 + i * 0.03) + i * 2.1) * width * 0.12;
      const peak = 0.16 + 0.08 * Math.sin(t * 0.4 + i * 1.3);
      return div().absolute().top(0).bottom(0).left(centre - bw / 2).w(bw).flex().children(Array.from({ length: SLICES }, (_, k) => {
        const a = Math.round(255 * peak * Math.sin((Math.PI * (k + 0.5)) / SLICES) ** 2).toString(16).padStart(2, "0");
        return div().h_full().flex_1().bg(colour + a);
      }));
    }));
}

