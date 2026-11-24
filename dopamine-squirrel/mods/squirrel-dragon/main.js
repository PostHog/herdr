// A dragon in the chosen account's colour swoops in, breathes fire across the window and sets off an
// explosion that spells the account name. squirrel-account opens it, full-window, after a pick.
import { View, div, image } from "gpui-kit";
import { props, closeOverlay } from "herdr";

const DURATION = 2.3, ART_W = 420, ART_H = 260, MOUTH = { x: 398, y: 124 };
const STREAM = 340, BURST = 260;

// Fire colours by age: white-hot, yellow, the account's light and mid tones, deep tone, smoke.
const PALETTES = [
  ["#ffffff", "#fef9c3", "#fde047", "#bbf7d0", "#4ade80", "#16a34a", "#14532d", "#1f2421"],
  ["#ffffff", "#fef9c3", "#fdba74", "#f5d0fe", "#c084fc", "#9333ea", "#581c87", "#221a26"],
];

const hexByte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
const ease = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
// A fixed pseudo-random sequence, so every frame agrees on each particle without storing state.
const rnd = (i, k) => { const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return s - Math.floor(s); };

export default class SquirrelDragon extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.name = String(p.name ?? "claude").toUpperCase();
    this.palette = PALETTES[Math.abs(Number(p.index) || 0) % PALETTES.length];
    this.art = `mods/squirrel-dragon/dragon-${Math.abs(Number(p.index) || 0) % 2}.svg`;
    const vs = globalThis.window?.viewport_size?.();
    this.size = vs?.width ? { width: vs.width, height: vs.height } : { width: 1400, height: 900 };
    this.start = Date.now();
    cx.spawn(async (cx) => {
      while ((Date.now() - this.start) / 1000 < DURATION) { await cx.sleep(16); cx.notify(); }
      closeOverlay(props().overlay);
    });
  }

  // Where the dragon is at time s: in from the left, hovering while it breathes, then off up and right.
  dragon(s) {
    const { width, height } = this.size, w = Math.max(320, Math.min(760, width * 0.5)), scale = w / ART_W;
    const restX = width * 0.04, restY = height * 0.26 - ART_H * scale * 0.5;
    let x = restX, y = restY + Math.sin(s * 7) * 8;
    if (s < 0.4) x = -w + (restX + w) * ease(s / 0.4);
    if (s > 1.55) { const k = (s - 1.55) / 0.6; x = restX + k * k * width * 1.1; y -= k * k * height * 0.6; }
    return { x, y, w, scale };
  }

  mouth(s) {
    const d = this.dragon(s);
    return { x: d.x + MOUTH.x * d.scale, y: d.y + MOUTH.y * d.scale };
  }

  color(age, alpha) {
    const pal = this.palette, i = Math.min(pal.length - 1, Math.floor(age * pal.length));
    return pal[i] + hexByte(alpha);
  }

  render() {
    const { width, height } = this.size;
    const s = (Date.now() - this.start) / 1000;
    const out = [];
    const boom = { x: width * 0.64, y: height * 0.6 }, BOOM_AT = 0.72;

    // Flash: the whole window lights up in the account colour at the blast.
    const flash = s > BOOM_AT ? Math.max(0, 1 - (s - BOOM_AT) / 0.45) : 0;
    if (flash > 0) out.push(div().absolute().left(0).top(0).w(width).h(height).bg(this.palette[4] + hexByte(0.32 * flash)));

    // Shockwave rings.
    for (const [delay, thick] of [[0, 10], [0.12, 5], [0.24, 3]]) {
      const k = (s - BOOM_AT - delay) / 0.9;
      if (k <= 0 || k >= 1) continue;
      const r = ease(k) * Math.hypot(width, height) * 0.55;
      out.push(div().absolute().left(boom.x - r).top(boom.y - r).size(r * 2).rounded(r)
        .border(thick).border_color(this.palette[k < 0.3 ? 2 : 4] + hexByte(0.9 * (1 - k))));
    }

    // Fire breath: a turbulent cone from the mouth toward the blast.
    for (let i = 0; i < STREAM; i++) {
      const born = 0.3 + (i / STREAM) * 1.2, life = 0.45 + rnd(i, 1) * 0.45, age = (s - born) / life;
      if (age <= 0 || age >= 1) continue;
      const m = this.mouth(born), dx = boom.x - m.x, dy = boom.y - m.y, dist = Math.hypot(dx, dy) || 1;
      const spread = (rnd(i, 2) - 0.5) * 0.8, travel = dist * (0.75 + rnd(i, 3) * 0.55) * ease(age * 1.3);
      const ang = Math.atan2(dy, dx) + spread;
      const wob = Math.sin(age * 9 + i) * 18 * age;
      const x = m.x + Math.cos(ang) * travel - Math.sin(ang) * wob;
      const y = m.y + Math.sin(ang) * travel + Math.cos(ang) * wob - age * age * 40;
      const size = 18 + age * (70 + rnd(i, 4) * 100);
      out.push(div().absolute().left(x - size / 2).top(y - size / 2).size(size).rounded(size / 2)
        .bg(this.color(age, age < 0.75 ? 0.95 : 0.95 * (1 - age) / 0.25)));
    }

    // The blast: embers flung out in every direction, then pulled down.
    for (let i = 0; i < BURST; i++) {
      const born = BOOM_AT + rnd(i, 5) * 0.12, life = 0.7 + rnd(i, 6) * 0.8, age = (s - born) / life;
      if (age <= 0 || age >= 1) continue;
      const ang = rnd(i, 7) * Math.PI * 2, speed = (0.25 + rnd(i, 8) * 0.75) * Math.max(width, height) * 0.55;
      const t = age * life;
      const x = boom.x + Math.cos(ang) * speed * ease(age) ;
      const y = boom.y + Math.sin(ang) * speed * ease(age) + 260 * t * t;
      const size = (i % 5 === 0 ? 26 : 9) * (1 - age * 0.6) + 3;
      out.push(div().absolute().left(x - size / 2).top(y - size / 2).size(size).rounded(i % 3 === 0 ? 2 : size / 2)
        .bg(this.color(age, 1 - age * age)));
    }

    // The account name, burnt into the middle of the blast.
    const tk = (s - BOOM_AT - 0.05) / 1.3;
    if (tk > 0 && tk < 1) {
      const sizePx = Math.min(width * 0.16, 190) * (0.7 + 0.3 * ease(tk * 3)), a = tk < 0.7 ? 1 : (1 - tk) / 0.3;
      const label = (dx, dy, color) => div().absolute().left(dx).top(boom.y - sizePx * 0.65 + dy).w(width).flex().justify_center()
        .text_size(sizePx).font_black().text_color(color).child(this.name);
      out.push(label(boom.x - width / 2 + 6, 6, this.palette[6] + hexByte(0.9 * a)));
      out.push(label(boom.x - width / 2 - 3, -3, this.palette[3] + hexByte(0.75 * a)));
      out.push(label(boom.x - width / 2, 0, this.palette[1] + hexByte(a)));
    }

    // The dragon on top, so the fire comes out of its mouth.
    const d = this.dragon(s), fade = s > 1.55 ? Math.max(0, 1 - (s - 1.55) / 0.6) : 1;
    out.push(image(this.art).absolute().left(d.x).top(d.y).w(d.w).h(ART_H * d.scale).opacity(fade));

    // The window shakes for a moment at the blast.
    const quake = s > BOOM_AT && s < BOOM_AT + 0.45 ? 22 * (1 - (s - BOOM_AT) / 0.45) : 0;
    const jx = quake * (rnd(Math.floor(s * 60), 9) - 0.5) * 2, jy = quake * (rnd(Math.floor(s * 60), 10) - 0.5) * 2;
    return div().id("dragon").size_full().relative().overflow_hidden()
      .on_size_change((size) => { this.size = size; })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => closeOverlay(props().overlay))
      .child(div().absolute().left(jx).top(jy).w(width).h(height).children(out));
  }
}
