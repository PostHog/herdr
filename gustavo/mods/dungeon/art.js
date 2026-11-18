// Server Dungeon pixel art, drawn in code.
//
// Sprites are pixel buffers in "art pixels". The isometric grid is 16x8 art pixels per tile and
// heights are given in half-pixels (Q = 2): twice the detail of the first prototype, so outlines
// and details are one art pixel thin. bake.mjs writes each buffer at the screen's physical size.

export const Q = 2; // art pixels per prototype pixel
export const TW = 8 * Q, TH = 4 * Q; // half a tile's width and height on screen
export const K = "#151515", K2 = "#23251D";

/* ---------- colors ---------- */
const rgbCache = new Map();
export function rgb(h) {
  let v = rgbCache.get(h);
  if (v) return v;
  const s = h.slice(1);
  v = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), s.length > 6 ? parseInt(s.slice(6, 8), 16) : 255];
  rgbCache.set(h, v);
  return v;
}
const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const mixCache = new Map();
export function mix(a, b, t) {
  const k = a + b + t;
  let v = mixCache.get(k);
  if (v) return v;
  const A = rgb(a), B = rgb(b);
  v = hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t) + a.slice(7); // keeps a's alpha
  mixCache.set(k, v);
  return v;
}
export const dim = (c) => mix(c, "#12151f", 0.6);
// A color at `alpha` (0..1), for soft glows: in a few steps, so they keep a pixel-art look.
export const glowAt = (c, alpha) => c.slice(0, 7) + Math.round(Math.max(0, Math.min(1, Math.round(alpha * 4) / 4)) * 200).toString(16).padStart(2, "0");

/* ---------- deterministic noise ---------- */
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const h2 = (a, b) => { let h = Math.imul((a * 374761393 + b * 668265263) | 0, 1274126177); h ^= h >>> 13; h = Math.imul(h, 1103515245); return ((h >>> 0) % 1000) / 1000; };

/* ---------- pixel buffer ----------
 * Art code draws in art pixels (w x h). The buffer itself holds r x r fine pixels per art pixel
 * (PB.res, set by bake.mjs for the size the sprite is shown at): shapes, faces and outlines are
 * traced at the fine resolution, so big sprites keep small pixels instead of stretching. A single
 * set() still covers a whole art pixel. */
export class PB {
  constructor(w, h) {
    const r = PB.res;
    this.w = w; this.h = h; this.r = r; this.W = w * r; this.H = h * r;
    this.p = new Array(this.W * this.H).fill(0);
  }
  // One fine pixel.
  fill(X, Y, c) { if (X < 0 || Y < 0 || X >= this.W || Y >= this.H) return; this.p[Y * this.W + X] = c; }
  set(x, y, c) {
    const r = this.r, X = Math.floor(x * r), Y = Math.floor(y * r);
    for (let j = 0; j < r; j++) for (let i = 0; i < r; i++) this.fill(X + i, Y + j, c);
  }
  rect(x, y, w, h, c) {
    const r = this.r;
    for (let Y = Math.round(y * r); Y < Math.round((y + h) * r); Y++) for (let X = Math.round(x * r); X < Math.round((x + w) * r); X++) this.fill(X, Y, c);
  }
  ell(cx, cy, rx, ry, c) { this.ellFn(cx, cy, rx, ry, () => c); }
  // Fills where fn(u, v, x, y) returns a color, within an ellipse; (u, v) in [-1, 1], (x, y) the art pixel.
  ellFn(cx, cy, rx, ry, fn) {
    const r = this.r;
    for (let Y = Math.floor((cy - ry - 1) * r); Y <= (cy + ry + 1) * r; Y++) for (let X = Math.floor((cx - rx - 1) * r); X <= (cx + rx + 1) * r; X++) {
      const u = ((X + 0.5) / r - cx) / rx, v = ((Y + 0.5) / r - cy) / ry;
      if (u * u + v * v <= 1) { const c = fn(u, v, Math.floor(X / r), Math.floor(Y / r)); if (c) this.fill(X, Y, c); }
    }
  }
  tri(ax, ay, bx, by, cx, cy, c) {
    const r = this.r;
    const x0 = Math.floor(Math.min(ax, bx, cx) * r), x1 = Math.ceil(Math.max(ax, bx, cx) * r), y0 = Math.floor(Math.min(ay, by, cy) * r), y1 = Math.ceil(Math.max(ay, by, cy) * r);
    const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
    for (let Y = y0; Y <= y1; Y++) for (let X = x0; X <= x1; X++) {
      const px = (X + 0.5) / r, py = (Y + 0.5) / r;
      const d1 = s(px, py, ax, ay, bx, by), d2 = s(px, py, bx, by, cx, cy), d3 = s(px, py, cx, cy, ax, ay);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) this.fill(X, Y, c);
    }
  }
  line(x0, y0, x1, y1, c, w = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2 * this.r));
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      if (w <= 1) this.set(x, y, c); else this.ell(x, y, w / 2, w / 2, c);
    }
  }
  px(list, c) { for (const [x, y] of list) this.set(x, y, c); }
  // A one-fine-pixel line around everything drawn.
  outline(c = K) {
    const at = (X, Y) => X >= 0 && Y >= 0 && X < this.W && Y < this.H && this.p[Y * this.W + X];
    const add = [];
    for (let Y = 0; Y < this.H; Y++) for (let X = 0; X < this.W; X++) {
      if (this.p[Y * this.W + X]) continue;
      if (at(X - 1, Y) || at(X + 1, Y) || at(X, Y - 1) || at(X, Y + 1)) add.push(Y * this.W + X);
    }
    for (const i of add) this.p[i] = c;
    return this;
  }
  map(f) { for (let i = 0; i < this.p.length; i++) if (this.p[i]) this.p[i] = f(this.p[i]); return this; }
  empty() { return this.p.every((c) => !c); }
}
PB.res = 1;

/* ---------- isometric faces (fine-pixel-centre sampling, no anti-aliasing) ----------
 * Tile coordinates (a, b) and heights z are in prototype units; (ox, oy) is where tile (0, 0)
 * sits, in art pixels. A face's callback gets its two parameters, whether the pixel is on the
 * face's edge (one fine pixel wide), and the art pixel it falls in (for dithers and patterns). */
function face(pb, x0, y0, x1, y1, param, inside, fn) {
  const r = pb.r, d = 1 / r;
  for (let Y = Math.floor((Math.floor(y0) - 1) * r); Y <= (Math.ceil(y1) + 2) * r; Y++) for (let X = Math.floor((Math.floor(x0) - 1) * r); X <= (Math.ceil(x1) + 2) * r; X++) {
    // param() samples at x + 0.5: shift so it lands on this fine pixel's centre.
    const x = (X + 0.5) / r - 0.5, y = (Y + 0.5) / r - 0.5;
    const q = param(x, y);
    if (!inside(q)) continue;
    const e = !inside(param(x - d, y)) || !inside(param(x + d, y)) || !inside(param(x, y - d)) || !inside(param(x, y + d));
    const c = fn(q[0], q[1], e, Math.floor(X / r), Math.floor(Y / r));
    if (c) pb.fill(X, Y, c);
  }
}
// Top face at height h: a in [a0, a1), b in [b0, b1).
export function fZ(pb, ox, oy, h, a0, a1, b0, b1, fn) {
  const xs = [a0 - b0, a0 - b1, a1 - b0, a1 - b1].map((v) => ox + v * TW), ys = [a0 + b0, a1 + b1].map((v) => oy + v * TH - h * Q);
  face(pb, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys),
    (x, y) => { const a = (x + 0.5 - ox) / TW, b = (y + 0.5 - oy + h * Q) / TH; return [(a + b) / 2, (b - a) / 2]; },
    (q) => q[0] >= a0 && q[0] < a1 && q[1] >= b0 && q[1] < b1, fn);
}
// The plane a = c, facing down-right: params (b, z).
export function fX(pb, ox, oy, c, b0, b1, z0, z1, fn) {
  face(pb, ox + (c - b1) * TW, oy + (c + b0) * TH - z1 * Q, ox + (c - b0) * TW, oy + (c + b1) * TH - z0 * Q,
    (x, y) => { const b = c - (x + 0.5 - ox) / TW; return [b, (oy + (c + b) * TH - (y + 0.5)) / Q]; },
    (q) => q[0] >= b0 && q[0] < b1 && q[1] >= z0 && q[1] < z1, fn);
}
// The plane b = c, facing down-left: params (a, z).
export function fY(pb, ox, oy, c, a0, a1, z0, z1, fn) {
  face(pb, ox + (a0 - c) * TW, oy + (a0 + c) * TH - z1 * Q, ox + (a1 - c) * TW, oy + (a1 + c) * TH - z0 * Q,
    (x, y) => { const a = (x + 0.5 - ox) / TW + c; return [a, (oy + (a + c) * TH - (y + 0.5)) / Q]; },
    (q) => q[0] >= a0 && q[0] < a1 && q[1] >= z0 && q[1] < z1, fn);
}
export const solid = (c, ec) => (u, v, e) => (e ? ec || mix(c, K, 0.45) : c);
export function box(pb, ox, oy, a0, a1, b0, b1, z0, z1, cols) {
  const f = (v) => (typeof v === "function" ? v : solid(v));
  fY(pb, ox, oy, b1, a0, a1, z0, z1, f(cols.front));
  fX(pb, ox, oy, a1, b0, b1, z0, z1, f(cols.side));
  fZ(pb, ox, oy, z1, a0, a1, b0, b1, f(cols.top));
}

/* ---------- 5x7 pixel font ---------- */
const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00110", "00100", "00000", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};
export function text(pb, x, y, str, c, k = 1) {
  let cx = x;
  for (const ch of str) {
    const g = FONT[ch] ?? FONT[" "];
    g.forEach((row, j) => [...row].forEach((bit, i) => { if (bit === "1") pb.rect(cx + i * k, y + j * k, k, k, c); }));
    cx += 6 * k;
  }
}

/* ---------- effects ---------- */
// A puff of smoke, for racks with a problem.
export function smoke() {
  const pb = new PB(12, 11);
  pb.ellFn(6, 5.5, 5, 4.6, (u, v) => (u + v < -0.5 ? "#A9AAA1" : v > 0.4 ? "#6A6B64" : "#7E7F77"));
  return pb;
}

/* ---------- rooms ---------- */
export const WH = 18, RH = 15; // wall and rack heights (prototype units)
export const D0 = 3.25, D1 = 4.5, DC = 3.875; // the locked door's span on the back-right wall
const LED = { working: ["#5BE37D", "#6E9BFF", "#5BE37D"], blocked: ["#FF4D57", "#FFB020", "#FF4D57"], done: ["#FFD24A", "#5BE37D", "#FFD24A"], idle: [] };
export const ROOM_BACK = { w: 96 * Q, h: (WH + 28) * Q, ox: 48 * Q, oy: (WH + 6) * Q };

// The room's two back walls with their racks, plus LED and glow layers to blink and pulse.
// Opening: arches toward the neighbours behind (openL, openR); blocked rooms get the locked door.
export function roomBack({ status, seed, openL, openR }) {
  const { w: W, h: H, ox, oy } = ROOM_BACK;
  const pb = new PB(W, H), la = new PB(W, H), lb = new PB(W, H), glow = new PB(W, H);
  const blocked = status === "blocked";
  const rnd = rng(seed ^ 0x51ed);
  const stone = (lit) => (t, z, e) => {
    if (e) return K2;
    const row = Math.floor(z / 5), off = (row % 2) * 0.5, bt = t + off, bi = Math.floor(bt);
    if (z - row * 5 < 0.5 || bt - bi < 0.0625) return lit ? "#A7A89F" : "#8C8D85";
    if (z > WH - 0.5) return lit ? "#D0D1C8" : "#B4B5AC";
    const v = h2(row * 7 + bi, seed % 97);
    if (z - row * 5 > 4.4) return lit ? "#B4B5AC" : "#9A9B92"; // brick's shaded lower lip
    return v < 0.3 ? (lit ? "#B9BAB1" : "#9FA097") : lit ? "#C6C7BE" : "#ABACA3";
  };
  const arch = (t, z, t0, top) => {
    const a = top + 2 * Math.sin(Math.PI * (t - t0));
    if (z >= a) return null;
    if (z > a - 0.6 || t - t0 < 0.0625 || t0 + 1 - t <= 0.0625) return K2;
    return z < 2 ? "#34362F" : "#1F201C";
  };
  fX(pb, ox, oy, 0, 0, 5, 0, WH, (b, z, e) => {
    if (openL && b >= 2 && b < 3) { const c = arch(b, z, 2, 11); if (c) return c; }
    return stone(false)(b, z, e);
  });
  fY(pb, ox, oy, 0, 0, 5, 0, WH, (a, z, e) => {
    if (blocked && a >= D0 && a < D1) {
      const top = 12 + 2.5 * Math.sqrt(Math.max(0, 1 - ((a - DC) / 0.75) ** 2));
      if (z < top) {
        if (a - D0 < 0.07 || D1 - a <= 0.07 || z > top - 0.6) return "#3A3C44";
        // padlock
        if (a >= DC - 0.15 && a < DC + 0.2 && z >= 4 && z < 8) return z >= 5 && z < 6.5 && a >= DC - 0.03 && a < DC + 0.06 ? K : z > 7.5 ? "#FFE9A3" : "#F9BD2B";
        if (a >= DC - 0.1 && a < DC + 0.15 && z >= 8 && z < 9.6) return a < DC - 0.04 || a >= DC + 0.09 ? "#C9CCD3" : null;
        if ((z >= 2 && z < 2.6) || (z >= 9.6 && z < 10.2)) return "#4A4C55";
        const plank = Math.floor((a - D0) * 16);
        return plank % 4 === 0 ? "#6B2A22" : plank % 4 === 1 ? "#A34A36" : "#94402F";
      }
    }
    if (openR && a >= 2 && a < 3) { const c = arch(a, z, 2, 11); if (c) return c; }
    return stone(true)(a, z, e);
  });
  // wall tops and end caps
  fZ(pb, ox, oy, WH, -0.5, 0, -0.5, 5, solid("#DCDDD4", "#B9BAB1"));
  fZ(pb, ox, oy, WH, 0, 5, -0.5, 0, solid("#DCDDD4", "#B9BAB1"));
  fY(pb, ox, oy, 5, -0.5, 0, 0, WH, solid("#BDBEB5", K2));
  fX(pb, ox, oy, 5, -0.5, 0, 0, WH, solid("#999A91", K2));
  // server racks along the walls
  const leds = LED[status];
  const rackFront = (a0) => (t, z, e, x, y) => {
    if (e) return K2;
    const col = Math.floor((t - a0) * 16), row = Math.floor(z * Q);
    if (z > RH - 1.2) return "#4A4E5A";
    if (row % 4 === 0) return "#24262D";
    if (row % 4 === 1 && col >= 2 && col <= 5 && col % 2 === 0) {
      if (!leds.length) return rnd() < 0.06 ? "#8A6A1E" : "#1D2A22";
      const g = rnd(), c = leds[Math.floor(rnd() * leds.length)];
      if (g < 0.3) { la.set(x, y, c); return "#1D2A22"; }
      if (g < 0.6) { lb.set(x, y, c); return "#1D2A22"; }
      return g < 0.85 ? c : "#1D2A22";
    }
    if (row % 4 === 2 && col >= 8 && col <= 13) return "#62667A";
    if (row % 4 === 1 && col >= 8 && col <= 13) return (col + row) % 2 ? "#33363F" : "#2A2C34";
    return "#3A3D47";
  };
  const rackTop = solid("#5A5E6B", "#3A3D47");
  const right = blocked ? [[0.75, 1.75], [2, 3]] : [[0.75, 1.75], [3.25, 4.25]];
  if (!openR && !blocked) right.push([2, 3]);
  const left = [[0.75, 1.75], [3.25, 4.25]];
  if (!openL) left.push([2, 3]);
  right.sort((p, q) => p[0] - q[0]).forEach(([a0, a1]) => box(pb, ox, oy, a0, a1, 0, 0.75, 0, RH, { front: rackFront(a0), side: solid("#2B2D35", K2), top: rackTop }));
  left.sort((p, q) => p[0] - q[0]).forEach(([b0, b1]) => {
    fX(pb, ox, oy, 0.75, b0, b1, 0, RH, rackFront(b0));
    fY(pb, ox, oy, b1, 0, 0.75, 0, RH, solid("#2F313A", K2));
    fZ(pb, ox, oy, RH, 0, 0.75, b0, b1, rackTop);
  });
  // status lamps where a dungeon would have torches
  const lamp = leds.length ? leds[0] : "#4A4C55";
  const lamps = blocked ? [[ox - 36 * Q, oy + 7 * Q]] : [[ox - 36 * Q, oy + 7 * Q], [ox + 36 * Q, oy + 7 * Q]];
  for (const [x, y] of lamps) {
    pb.rect(x - 2, y + 4, 5, 2, K2); pb.rect(x - 1, y + 6, 3, 2, K2);
    pb.ellFn(x + 0.5, y + 1, 3.2, 3.2, (u, v) => (u + v < -0.6 ? mix(lamp, "#FFFFFF", 0.6) : lamp));
    if (leds.length) glow.ellFn(x + 0.5, y + 1, 11, 11, (u, v) => { const d = Math.hypot(u, v); return d < 0.32 ? null : glowAt(lamp, 0.75 * (1 - d)); });
  }
  if (blocked) {
    // red halo around the locked door, on the wall and the floor in front of it
    fY(glow, ox, oy, 0, D0 - 0.5, 5, 0, 18, (a, z) => (a < D0 || a >= D1 || z > 14.5 ? glowAt("#F04F58", 0.5) : null));
    fZ(glow, ox, oy, 0, D0 - 0.25, 4.75, 0.75, 1.6, () => glowAt("#F04F58", 0.5));
  }
  pb.outline(K);
  if (status === "idle") pb.map(dim);
  return { base: pb, la, lb, glow };
}

// The room's floor and the plinth under it. Blocked rooms redden in front of the door.
export const FLOOR = { w: 84 * Q, h: 48 * Q, ox: 42 * Q, oy: 2 * Q };
export function roomFloor({ status, seed }) {
  const { w, h, ox, oy } = FLOOR;
  const pb = new PB(w, h);
  const idle = status === "idle";
  const tint = (c) => (idle ? dim(c) : c);
  fZ(pb, ox, oy, 0, 0, 5, 0, 5, (a, b, e, x, y) => {
    const ia = Math.floor(a), ib = Math.floor(b), fa = a - ia, fb = b - ib;
    let c = (ia + ib) & 1 ? "#DADBD3" : "#E5E7E0";
    const vent = h2(ia + (seed % 13), ib) < 0.18;
    if (fa < 0.0625 || fb < 0.0625) c = "#B4B5AC";
    else if (fa < 0.12 || fb < 0.12) c = mix(c, "#FFFFFF", 0.35);
    else if (vent && fa > 0.25 && fa < 0.8 && fb > 0.25 && fb < 0.8) c = (x + y) % 3 === 0 ? "#8C8D85" : (x % 2 === 0 && y % 2 === 0 ? "#9FA097" : mix(c, "#9FA097", 0.3));
    if ((a < 1.05 || b < 1.05) && c !== "#B4B5AC") c = mix(c, "#8C8D85", 0.22);
    if (status === "blocked") { const d = Math.hypot(a - DC, b - 0.8); if (d < 1.3) c = mix(c, "#F04F58", 0.18); }
    return tint(c);
  });
  fY(pb, ox, oy, 5, 0, 5, -4, 0, (t, z, e) => tint(e ? "#4A4B45" : z > -0.6 ? "#C9CAC1" : Math.floor(t * 4) % 2 ? "#A3A49B" : "#ABACA3"));
  fX(pb, ox, oy, 5, 0, 5, -4, 0, (t, z, e) => tint(e ? "#4A4B45" : z > -0.6 ? "#9C9D94" : Math.floor(t * 4) % 2 ? "#7E7F77" : "#868780"));
  return pb;
}

// The red pulse over a blocked room's floor.
export function floorOverlay() {
  const { w, h, ox, oy } = FLOOR;
  const pb = new PB(w, h);
  fZ(pb, ox, oy, 0, 0, 5, 0, 5, (a, b, e) => glowAt("#F04F58", e ? 1 : 0.4));
  return pb;
}

// A bridge to the next room toward +a ("x") or +b ("y"), carrying network cables.

// HUD legend icons.
export function icon(kind) {
  const pb = new PB(20, 20);
  if (kind === "blocked") { pb.rect(3, 2, 14, 13, "#F04F58"); pb.rect(9, 4, 2, 6, "#FFFFFF"); pb.rect(9, 11, 2, 2, "#FFFFFF"); pb.tri(4, 14, 9, 14, 3, 18, "#F04F58"); }
  if (kind === "done") { pb.rect(2, 8, 16, 9, "#A86F3B"); pb.rect(2, 8, 16, 2, "#F9BD2B"); pb.rect(9, 8, 2, 9, "#F9BD2B"); pb.ell(10, 7, 6, 3, "#F9BD2B"); pb.set(8, 5, "#FFFFFF"); }
  if (kind === "working") { pb.line(4, 16, 15, 4, "#E5E7EC", 2); pb.line(3, 12, 8, 17, "#F9BD2B", 2); pb.set(15, 3, "#FFFFFF"); }
  if (kind === "idle") { text(pb, 2, 3, "Z", "#9FB4FF"); text(pb, 10, 9, "Z", "#9FB4FF"); }
  if (kind === "support") { pb.rect(2, 5, 16, 11, "#FFF6E0"); pb.line(2, 5, 10, 11, "#C9BC9C"); pb.line(18, 5, 10, 11, "#C9BC9C"); pb.ell(10, 11, 2.2, 2.2, "#F04F58"); }
  if (kind === "problem") { pb.tri(10, 2, 18, 17, 2, 17, "#F54E00"); pb.rect(9, 7, 2, 5, "#FFFFFF"); pb.rect(9, 13, 2, 2, "#FFFFFF"); }
  return pb.outline(K);
}
