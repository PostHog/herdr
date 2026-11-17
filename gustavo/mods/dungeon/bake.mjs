// Draws every sprite the dungeon shows (room.js CATALOG and ICONS) into sprites/, and writes
// sprites.js, the index main.js reads. Run it with Node after changing art.js or room.js:
//
//   node ~/.config/herdr-app/mods/dungeon/bake.mjs
//
// Herdr scales images with linear filtering, which blurs pixel art, so each sprite is written at the
// screen's physical size (art pixels x scale x 2 Retina pixels) and shown at its logical size. Big
// sprites are drawn finer (PB.res fine pixels per art pixel), up to 2, so their pixels stay small.

import { deflateSync } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PB, rgb } from "./art.js";
import { CATALOG, ICONS, SCALES } from "./room.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "sprites");
const FROM_HOME = "mods/dungeon/sprites"; // image() paths are relative to ~/.config/herdr-app
const DEVICE_PIXELS = 2;
const MAX_RES = 2;

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encode(w, h, rows) {
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// The smallest rectangle holding every drawn pixel, or null for an empty buffer.
function bounds(pb) {
  let x0 = pb.W, y0 = pb.H, x1 = -1, y1 = -1;
  for (let y = 0; y < pb.H; y++) for (let x = 0; x < pb.W; x++) if (pb.p[y * pb.W + x]) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Each fine pixel of the trimmed buffer as a px x px block, as PNG rows.
function rowsOf(pb, b, px) {
  const W = b.w * px, rows = Buffer.alloc((W * 4 + 1) * b.h * px);
  for (let y = 0; y < b.h; y++) {
    const line = Buffer.alloc(W * 4);
    for (let x = 0; x < b.w; x++) {
      const c = pb.p[(b.y0 + y) * pb.W + b.x0 + x];
      if (!c) continue;
      const v = rgb(c);
      for (let i = 0; i < px; i++) line.set(v, (x * px + i) * 4);
    }
    for (let j = 0; j < px; j++) line.copy(rows, (y * px + j) * (W * 4 + 1) + 1);
  }
  return rows;
}

// Fine pixels per art pixel (r) for k device pixels per art pixel, and device pixels per fine pixel.
function density(k) {
  let r = 1;
  for (let d = 2; d <= Math.min(k, MAX_RES); d++) if (k % d === 0 && k / d >= 2) r = d;
  return { r, px: k / r };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const index = {};
const bake = (key, draw, scale) => {
  const k = scale * DEVICE_PIXELS;
  if (!Number.isInteger(k)) throw new Error(`${key}: scale ${scale} isn't a whole number of device pixels`);
  const { r, px } = density(k);
  PB.res = r;
  const pb = draw();
  PB.res = 1;
  const b = bounds(pb);
  if (!b) return;
  const file = `${key}@${scale}.png`;
  writeFileSync(join(OUT, file), encode(b.w * px, b.h * px, rowsOf(pb, b, px)));
  index[`${key}@${scale}`] = [`${FROM_HOME}/${file}`, b.x0 / r, b.y0 / r, b.w / r, b.h / r];
};
for (const scale of SCALES) for (const [key, draw] of Object.entries(CATALOG)) bake(key, draw, scale);
for (const [key, draw] of Object.entries(ICONS)) bake(key, draw, 1);
// The hoggies' sizes (their PNG headers), so the view keeps each one's proportions.
const hoggies = {};
for (const f of readdirSync(join(HERE, "hoggies")).filter((f) => f.endsWith(".png")).sort()) {
  const head = readFileSync(join(HERE, "hoggies", f)).subarray(16, 24);
  hoggies[f.slice(0, -4)] = [head.readUInt32BE(0), head.readUInt32BE(4)];
}
const lines = (o) => JSON.stringify(o, null, 0).replace(/\],"/g, '],\n  "').replace(/^\{/, "{\n  ").replace(/\}$/, ",\n}");
writeFileSync(join(HERE, "sprites.js"), `// Written by bake.mjs. Don't edit by hand.

// "key@scale" → [image path, x, y, width, height], in art pixels from the sprite's own origin.
export default ${lines(index)};

// hoggie → [width, height] of hoggies/<hoggie>.png, in pixels.
export const HOGGIE_SIZES = ${lines(hoggies)};
`);
console.log(`${Object.keys(index).length} sprites in ${OUT} (${readdirSync(OUT).length} files)`);
