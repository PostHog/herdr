import { div } from "gpui-kit";

// Visualizer behind the merged rows: two live simulations (STATUS+CI and CC+MERGE columns) driven by
// Math.random. Each runs a random scene with a random palette and parameters, then swaps to another.
function hsl(h, sat = 90, light = 62) {
  h = ((h % 360) + 360) % 360; sat /= 100; light /= 100;
  const k = (n) => (n + h / 30) % 12, a = sat * Math.min(light, 1 - light);
  const f = (n) => Math.round(255 * (light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, "0");
  return `#${f(0)}${f(8)}${f(4)}`;
}
const R = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
const PALETTES = {
  rainbow: null, neon: ["#ff00ff", "#00ffff", "#ffff00", "#ff0080", "#00ff80"], vaporwave: ["#ff71ce", "#01cdfe", "#05ffa1", "#b967ff", "#fffb96"],
  sunset: ["#ff6ad5", "#c774e8", "#ad8cff", "#8795e8", "#94d0ff"], lava: ["#ff4e00", "#ff7b00", "#ffb000", "#ff2e63", "#ffd166"],
  ocean: ["#00f5d4", "#00bbf9", "#9b5de5", "#f15bb5", "#caf0f8"], aurora: ["#3dfc8a", "#2ec4b6", "#7b2cbf", "#c77dff", "#80ffdb"],
  pastel: ["#ffadad", "#ffd6a5", "#fdffb6", "#caffbf", "#9bf6ff", "#a0c4ff", "#bdb2ff", "#ffc6ff"], cyberpunk: ["#f700ff", "#00f0ff", "#fffb00", "#ff3864", "#2de2e6"],
  candy: ["#ff9cee", "#ffcce5", "#b28dff", "#aff8db", "#ffabab"], ice: ["#caf0f8", "#90e0ef", "#00b4d8", "#0077b6", "#ffffff"],
  reggae: ["#e63946", "#f4d35e", "#2a9d8f", "#ffbe0b"], grape: ["#7b2cbf", "#c77dff", "#e0aaff", "#ff6d00", "#3c096c"],
  fire: ["#fff3b0", "#ffd23f", "#ff9f1c", "#ff4040", "#9e0031"], matrix: ["#00ff41", "#008f11", "#39ff14", "#7dff9a"],
};
function palette() {
  const name = pickOne(Object.keys(PALETTES)), list = PALETTES[name], base = R(360), spread = R(10, 60), drift = R(-60, 60);
  // color(x, time): x is any number (index, height...), time shifts hues for rainbow.
  return { name, color: list ? (x) => list[((Math.floor(x) % list.length) + list.length) % list.length] : (x, time = 0) => hsl(base + x * spread + time * drift) };
}

const SCENES = {
  // Particles riding a shifting flow field, leaving trails.
  flow: {
    init: (w, h) => ({ k1: R(0.02, 0.09), k2: R(0.02, 0.09), s1: R(0.2, 1), s2: R(0.2, 1), speed: R(15, 45),
      ps: Array.from({ length: Math.round(Math.min(70, (w * h) / 450)) }, (_, i) => ({ x: R(w), y: R(h), c: i, trail: [] })) }),
    step: (st, w, h, dt, time) => {
      for (const p of st.ps) {
        const a = (Math.sin(p.x * st.k1 + time * st.s1) + Math.cos(p.y * st.k2 - time * st.s2)) * Math.PI;
        p.trail.unshift([p.x, p.y]); p.trail.length = Math.min(p.trail.length, 6);
        p.x += Math.cos(a) * st.speed * dt; p.y += Math.sin(a) * st.speed * dt;
        if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) { p.x = R(w); p.y = R(h); p.trail = []; }
      }
    },
    draw: (st, pal, time) => st.ps.flatMap((p) => [[p.x, p.y], ...p.trail].map(([x, y], k) =>
      div().absolute().left(x).top(y).size(k ? 2 : 3).rounded(2).bg(pal.color(p.c, time)).opacity(1 - k / 7))),
  },
  // Spectrum analyser: bars chasing random "audio" with beat kicks and falling peaks.
  spectrum: {
    init: (w) => { const n = Math.max(4, Math.floor(w / R(4, 8))); return { n, v: Array(n).fill(0), target: Array(n).fill(0), peak: Array(n).fill(0), beat: 0, mirror: Math.random() < 0.5 }; },
    step: (st, w, h, dt) => {
      st.beat -= dt;
      const kick = st.beat <= 0;
      if (kick) st.beat = R(0.25, 0.6);
      for (let i = 0; i < st.n; i++) {
        const low = 1 - i / st.n;
        if (kick || Math.random() < 0.15) st.target[i] = Math.min(1, R(0.1, 0.5) + (kick ? low * R(0.3, 0.7) : 0));
        st.v[i] += (st.target[i] - st.v[i]) * Math.min(1, dt * 12);
        st.target[i] *= 1 - dt * 2.5;
        st.peak[i] = Math.max(st.v[i], st.peak[i] - dt * 0.6);
      }
    },
    draw: (st, pal, time, w, h) => {
      const bw = w / st.n;
      return Array.from({ length: st.n }, (_, i) => {
        const j = st.mirror ? Math.abs(i - (st.n - 1) / 2) * 2 : i, v = st.v[Math.min(st.n - 1, Math.round(j))], pk = st.peak[Math.min(st.n - 1, Math.round(j))];
        return [div().absolute().left(i * bw).top(h * (1 - v)).w(Math.max(1, bw - 1)).h(h * v).bg(pal.color(v * 6, time)).opacity(0.85),
          div().absolute().left(i * bw).top(Math.max(0, h * (1 - pk) - 2)).w(Math.max(1, bw - 1)).h(2).bg("#ffffff").opacity(0.7)];
      }).flat();
    },
  },
  // Warp speed: stars streaming out from a wandering centre.
  warp: {
    init: () => ({ cx: 0.5, cy: 0.5, stars: Array.from({ length: 70 }, () => ({ a: R(Math.PI * 2), d: R(1), v: R(0.2, 1), c: R(10) })) }),
    step: (st, w, h, dt, time) => {
      st.cx = 0.5 + Math.sin(time * 0.3) * 0.2; st.cy = 0.5 + Math.cos(time * 0.4) * 0.2;
      for (const s of st.stars) { s.d += s.v * dt * (0.3 + s.d * 2); if (s.d > 1.2) { s.d = R(0.02); s.a = R(Math.PI * 2); s.c = R(10); } }
    },
    draw: (st, pal, time, w, h) => st.stars.map((s) => {
      const r = Math.max(w, h) * s.d, size = 1 + s.d * 3;
      return div().absolute().left(st.cx * w + Math.cos(s.a) * r).top(st.cy * h + Math.sin(s.a) * r * 0.8).size(size).rounded(size).bg(pal.color(s.c, time)).opacity(Math.min(1, s.d * 3));
    }),
  },
  // Glowing orbs bouncing around and overlapping.
  orbs: {
    init: (w, h) => ({ os: Array.from({ length: Math.floor(R(6, 14)) }, (_, i) => ({ x: R(w), y: R(h), vx: R(-40, 40), vy: R(-40, 40), r: R(4, 16), c: i })) }),
    step: (st, w, h, dt) => {
      for (const o of st.os) {
        o.x += o.vx * dt; o.y += o.vy * dt;
        if (o.x < 0 || o.x > w - o.r) o.vx *= -1;
        if (o.y < 0 || o.y > h - o.r) o.vy *= -1;
        o.x = Math.max(0, Math.min(w - o.r, o.x)); o.y = Math.max(0, Math.min(h - o.r, o.y));
      }
    },
    draw: (st, pal, time) => st.os.map((o) => div().absolute().left(o.x).top(o.y).size(o.r).rounded(o.r).bg(pal.color(o.c, time)).opacity(0.55)),
  },
  // Rain with splashes.
  rain: {
    init: (w, h) => ({ drops: Array.from({ length: Math.round(w / 6) }, () => ({ x: R(w), y: R(-h, h), v: R(60, 160), len: R(4, 12), c: R(10) })), splash: [] }),
    step: (st, w, h, dt) => {
      for (const d of st.drops) {
        d.y += d.v * dt;
        if (d.y > h) {
          for (let k = 0; k < 4; k++) st.splash.push({ x: d.x, y: h - 2, vx: R(-30, 30), vy: R(-50, -15), life: 1, c: d.c });
          d.y = R(-20, -5); d.x = R(w);
        }
      }
      for (const p of st.splash) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 160 * dt; p.life -= dt * 2.5; }
      st.splash = st.splash.filter((p) => p.life > 0).slice(-60);
    },
    draw: (st, pal, time) => [
      ...st.drops.map((d) => div().absolute().left(d.x).top(d.y).w(1.5).h(d.len).rounded(1).bg(pal.color(d.c, time)).opacity(0.8)),
      ...st.splash.map((p) => div().absolute().left(p.x).top(p.y).size(2).rounded(1).bg(pal.color(p.c, time)).opacity(p.life)),
    ],
  },
  // Fireworks: rockets rise and burst under gravity.
  fireworks: {
    init: () => ({ rockets: [], sparks: [], next: 0 }),
    step: (st, w, h, dt) => {
      st.next -= dt;
      if (st.next <= 0) { st.next = R(0.2, 0.9); st.rockets.push({ x: R(w * 0.1, w * 0.9), y: h, vy: R(-h * 1.4, -h * 0.8), fuse: R(0.4, 0.9), c: R(10) }); }
      for (const r of st.rockets) {
        r.y += r.vy * dt; r.fuse -= dt;
        if (r.fuse <= 0) {
          const n = Math.floor(R(14, 28)), sp = R(30, 70);
          for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2 + R(0.2); st.sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp * R(0.6, 1), vy: Math.sin(a) * sp * R(0.6, 1), life: 1, c: r.c + R(2) }); }
        }
      }
      st.rockets = st.rockets.filter((r) => r.fuse > 0);
      for (const p of st.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 50 * dt; p.vx *= 1 - dt; p.life -= dt * 0.8; }
      st.sparks = st.sparks.filter((p) => p.life > 0).slice(-220);
    },
    draw: (st, pal, time) => [
      ...st.rockets.map((r) => div().absolute().left(r.x).top(r.y).size(2).bg("#ffffff")),
      ...st.sparks.map((p) => div().absolute().left(p.x).top(p.y).size(2).rounded(1).bg(pal.color(p.c, time)).opacity(p.life)),
    ],
  },
  // Game of Life with inherited colours; reseeds when it settles.
  life: {
    init: (w, h) => {
      const cell = Math.floor(R(5, 9)), cols = Math.max(2, Math.floor(w / cell)), rows = Math.max(2, Math.floor(h / cell));
      const seed = () => Array.from({ length: cols * rows }, () => (Math.random() < 0.3 ? 1 + Math.floor(R(5)) : 0));
      return { cell, cols, rows, g: seed(), seed, tick: 0, every: R(0.08, 0.2), stale: 0 };
    },
    step: (st, w, h, dt) => {
      st.tick += dt;
      if (st.tick < st.every) return;
      st.tick = 0;
      const { cols, rows, g } = st, next = new Array(g.length).fill(0);
      let alive = 0, changed = 0;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        let n = 0; const seen = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const v = g[((y + dy + rows) % rows) * cols + ((x + dx + cols) % cols)];
          if (v) { n++; seen.push(v); }
        }
        const i = y * cols + x, cur = g[i];
        next[i] = cur ? (n === 2 || n === 3 ? cur : 0) : n === 3 ? seen[Math.floor(R(seen.length))] : 0;
        if (next[i]) alive++;
        if (!!next[i] !== !!cur) changed++;
      }
      st.g = next;
      st.stale = changed < 3 ? st.stale + 1 : 0;
      if (alive < cols * rows * 0.04 || st.stale > 8) st.g = st.seed();
    },
    draw: (st, pal, time) => st.g.flatMap((v, i) => (v ? [div().absolute().left((i % st.cols) * st.cell).top(Math.floor(i / st.cols) * st.cell)
      .size(st.cell - 1).rounded(1).bg(pal.color(v * 2, time))] : [])),
  },
  // Random walkers carving glowing paths.
  walkers: {
    init: (w, h) => ({ step: Math.floor(R(2, 5)), ws: Array.from({ length: Math.floor(R(4, 9)) }, (_, i) => ({ x: R(w), y: R(h), dir: Math.floor(R(4)), c: i * 2, trail: [] })), acc: 0 }),
    step: (st, w, h, dt) => {
      st.acc += dt;
      while (st.acc > 0.03) {
        st.acc -= 0.03;
        for (const k of st.ws) {
          if (Math.random() < 0.25) k.dir = (k.dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
          k.x += [st.step, 0, -st.step, 0][k.dir]; k.y += [0, st.step, 0, -st.step][k.dir];
          k.x = (k.x + w) % w; k.y = (k.y + h) % h;
          k.trail.unshift([k.x, k.y]); k.trail.length = Math.min(k.trail.length, 28);
        }
      }
    },
    draw: (st, pal, time) => st.ws.flatMap((k) => k.trail.map(([x, y], i) =>
      div().absolute().left(x).top(y).size(i ? 2 : 3).bg(pal.color(k.c + i / 10, time)).opacity(1 - i / 28))),
  },
  // Plasma: a grid tinted by drifting interference waves.
  plasma: {
    init: (w, h) => ({ cell: Math.floor(R(7, 12)), a: R(0.05, 0.25), b: R(0.05, 0.25), c: R(0.03, 0.15), s: R(0.5, 2) }),
    step: () => {},
    draw: (st, pal, time, w, h) => {
      const out = [];
      for (let y = 0; y < h; y += st.cell) for (let x = 0; x < w; x += st.cell) {
        const v = Math.sin(x * st.a + time * st.s) + Math.sin(y * st.b - time * st.s * 0.7) + Math.sin((x + y) * st.c + time);
        out.push(div().absolute().left(x).top(y).size(st.cell).bg(pal.color((v + 3) * 1.5, time)).opacity(0.75));
      }
      return out;
    },
  },
};

// One simulation: a scene that runs 9-17s, fades out, and hands over to a new random scene and palette.
export function newSim(w, h, count) {
  const name = pickOne(Object.keys(SCENES)), scene = SCENES[name];
  return { name, scene, pal: palette(), state: scene.init(w, h), w, h, age: 0, ttl: R(9, 17), time: R(1000), number: count + 1 };
}
export function stepSim(sim, w, h, dt) {
  if (!sim || sim.w !== w || sim.h !== h || sim.age > sim.ttl) return newSim(w, h, sim ? sim.number : 0);
  sim.age += dt; sim.time += dt;
  sim.scene.step(sim.state, w, h, dt, sim.time);
  return sim;
}
export function drawSim(sim, dim) {
  if (!sim) return [];
  const fade = Math.max(0, Math.min(1, sim.age / 0.6, (sim.ttl - sim.age) / 0.6));
  return [
    div().absolute().inset_0().opacity(fade).children(sim.scene.draw(sim.state, sim.pal, sim.time, sim.w, sim.h)),
  ];
}
