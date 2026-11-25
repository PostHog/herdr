// The liquid lens from squirrel-reopen, sized to fit: a slow field behind the popup, like ink turning in
// water, at a few percent opacity so text stays easy to read, and hairlines that carry a pulse of light.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

const CELL = 12, TAU = Math.PI * 2;
const hexByte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
export const tint = (n, t, alpha, lift = 0) => "#" + [0, 0.33, 0.67].map((d) => hexByte(0.5 + lift + (0.5 - lift) * Math.cos(TAU * (n * 0.9 + t * 0.05 + d)))).join("") + hexByte(alpha);
function swirl(x, y, t, W, H) {
  const wx = x + 18 * Math.sin(y * 0.021 + t * 1.3), wy = y + 18 * Math.cos(x * 0.018 - t * 1.1);
  const vortex = (cx, cy, turns, k) => {
    const dx = wx - cx, dy = wy - cy, r = Math.hypot(dx, dy);
    return Math.sin(Math.atan2(dy, dx) * turns + 2.4 * Math.exp(-r / 150) * Math.sin(t * 0.5) * turns + r * k - t * 2);
  };
  const v = vortex(W / 2 + 120 * Math.cos(t * 0.7), H / 2 + 90 * Math.sin(t * 0.9), 3, 0.035)
    + vortex(W / 2 - 120 * Math.cos(t * 0.7), H / 2 - 90 * Math.sin(t * 0.9), 2, -0.03)
    + 0.6 * Math.sin((wx + wy) * 0.012 + t);
  return (v / 2.6 + 1) / 2;
}
const smoothstep = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

export function lensLayer(t, W, H) {
  const rows = [];
  for (let y = 0; y < H; y += CELL) {
    const cells = [];
    for (let x = 0; x < W; x += CELL) {
      const n = swirl(x + CELL / 2, y + CELL / 2, t, W, H);
      cells.push(div().w(CELL).h(CELL).flex_none().bg(tint(n, t, 0.035 + 0.075 * smoothstep(0.35, 0.95, n))));
    }
    rows.push(h_flex().children(cells));
  }
  return div().absolute().top(0).left(0).w(W).h(H).children(rows);
}

const SEGMENTS = 36;
export function lensThread(y, i, t, W) {
  const pulse = (((t * 0.35 + i * 0.23) % 1.4) - 0.2) * W;
  return h_flex().h(1).mx(9).flex_none().children(Array.from({ length: SEGMENTS }, (_, k) => {
    const x = ((k + 0.5) / SEGMENTS) * (W - 18) + 9, glow = Math.exp(-(((x - pulse) / 40) ** 2));
    return div().h_full().flex_1().bg(tint(swirl(x, y, t, W, 400), t, 0.2 + 0.5 * glow, 0.15 * glow));
  }));
}
