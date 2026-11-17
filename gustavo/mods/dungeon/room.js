// One task's room, as its card shows it: the pixel-art room (drawn ahead of time by bake.mjs into
// sprites/: CATALOG, at each of SCALES) and, on its floor, a PostHog hoggie per session showing what
// it's doing. The hoggies are PostHog's own illustrations (https://brand.posthog.com/hoggies), kept
// in hoggies/ as PNGs; HOGGIES says which ones stand for each status.

import * as A from "./art.js";

const { TW, TH } = A;
export const SCALES = [3, 2, 1]; // logical px per art px, biggest first: the view picks the biggest that fits
export const SCENE = { w: 192, h: 146 }; // a room's picture, art pixels
const BX = 96, BY = 54; // where the room's floor tile (0, 0) sits in it
export const ORDER = ["blocked", "done", "working", "idle"];
const SEED = 7; // one look for every room
const DARK = 0.6; // idle rooms have their lights off: how far their colors go to black

// Hoggies by status; a room's sessions take them in turn, starting at a place that differs per task.
export const HOGGIES = {
  blocked: ["megaphone", "stop", "town-crier", "soapbox"],
  done: ["success", "party", "star", "stamp-approved"],
  working: ["workmaxxing", "dj", "desk-wizard", "highlighter"],
  idle: ["sleepy", "asleep", "banana"],
};

// The most urgent of a task's session statuses.
export const taskStatus = (t) => ORDER.find((s) => t.sessions.some((x) => x.status === s)) ?? "idle";

const dark = (draw) => () => draw().map((c) => A.mix(c, A.K, DARK));

// Every room sprite there is: key → draw(). Icons are only drawn at scale 1 (ICONS).
export const CATALOG = {};
for (const st of ORDER) {
  const back = (layer) => () => A.roomBack({ status: st, seed: SEED, openL: false, openR: false })[layer];
  const floor = () => A.roomFloor({ status: st, seed: SEED });
  CATALOG[`back-${st}`] = st === "idle" ? dark(back("base")) : back("base");
  CATALOG[`floor-${st}`] = st === "idle" ? dark(floor) : floor;
  if (st !== "idle") for (const l of ["la", "lb", "glow"]) CATALOG[`back-${st}-${l}`] = back(l);
}
CATALOG.red = A.floorOverlay;
CATALOG.smoke = A.smoke;
export const ICONS = {};
for (const k of ["blocked", "done", "working", "idle", "problem", "support"]) ICONS[`icon-${k}`] = () => A.icon(k);

// Where the hoggies stand (floor tiles) and the box each fits in ([width, height], art pixels), by how many there are.
const SPOTS = { 1: [[2.5, 2.5]], 2: [[1.8, 3.1], [3.2, 1.9]], 3: [[1.6, 3.2], [3.3, 1.7], [3.4, 3.4]] };
const BOX = { 1: [96, 84], 2: [74, 66], 3: [62, 56] };

// The room, back to front: { key, x, y, anim? } for its sprites and { hoggie, x, y, w, h } for its
// hoggies (x, y: where its feet stand; w x h: the box it fits in), in art pixels within SCENE. `k` varies the hoggies from task to task.
// anim: [{ prop: "top" | "left" | "opacity", by | from/to, period }]: "by" moves that many art pixels.
export function roomSprites(task, k = 0) {
  const st = taskStatus(task);
  const out = [];
  const add = (key, x, y, z, anim) => out.push({ key, x, y, z, anim });
  const P = (a, b) => [BX + (a - b) * TW, BY + (a + b) * TH];
  const zOf = (y) => Math.round(y * 2) + 2000;
  add(`floor-${st}`, BX - A.FLOOR.ox, BY - A.FLOOR.oy, 0);
  if (st === "blocked") add("red", BX - A.FLOOR.ox, BY - A.FLOOR.oy, 1, [{ prop: "opacity", from: 0.1, to: 0.9, period: 1100 }]);
  const bx = BX - A.ROOM_BACK.ox, by = BY - A.ROOM_BACK.oy, zb = zOf(BY);
  add(`back-${st}`, bx, by, zb);
  if (st !== "idle") {
    const fast = st === "blocked";
    add(`back-${st}-la`, bx, by, zb + 1, [{ prop: "opacity", from: 1, to: 0, period: fast ? 320 : 900 }]);
    add(`back-${st}-lb`, bx, by, zb + 1, [{ prop: "opacity", from: 0, to: 1, period: fast ? 320 : 1370 }]);
    add(`back-${st}-glow`, bx, by, zb + 2, [{ prop: "opacity", from: 0.15, to: 1, period: fast ? 550 : 2600 }]);
  }
  // A problem on the task's PRs (failing checks, conflicts, changes asked): its racks smoke.
  if (task.problem) [[0.6, 1.4], [1.4, 0.6]].forEach(([a, b], i) => {
    const [X, Y] = P(a, b);
    add("smoke", X - 6, Y - A.WH * A.Q - 8, 94000 + i, [{ prop: "top", by: -14, period: 1800 + i * 400 }, { prop: "opacity", from: 1, to: 0.1, period: 1800 + i * 400 }]);
  });
  // The hoggies: the sessions that need you first, at most three.
  const shown = [...task.sessions].sort((p, q) => ORDER.indexOf(p.status) - ORDER.indexOf(q.status)).slice(0, 3);
  const used = {};
  shown.forEach((x, i) => {
    const pool = HOGGIES[x.status], n = used[x.status] = (used[x.status] ?? -1) + 1;
    const [X, Y] = P(...SPOTS[shown.length][i]);
    const [w, h] = BOX[shown.length];
    out.push({ hoggie: pool[(k + n) % pool.length], x: X, y: Y, w, h, z: zOf(Y) });
  });
  return out.sort((p, q) => p.z - q.z);
}
