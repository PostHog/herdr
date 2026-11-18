// What each creature in the pond looks like and where it sits.
// Pure functions only; main.js reads the agents, gists and to-do records.

// A small stable hash, so a creature keeps its spot, drift speed and leaf
// colour for as long as its terminal lives.
export function hash(text) {
  let h = 5381;
  for (const ch of String(text)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h;
}

// Agent status (blocked / done / working / idle) plus "a to-do prep is ready"
// becomes one mood. Needing you wins over everything; a finished prep wins over
// plain resting so the sparkle shows.
export function mood(status, prepReady) {
  if (status === "blocked") return "needs";
  if (status === "working") return "working";
  if (prepReady) return "ready";
  if (status === "done") return "news";
  return "resting";
}

// How each mood draws: body colour (a theme name), eyes, and motion.
// drift: px either side, horizontally; bob: px up and down; periods in ms.
export const MOODS = {
  needs:   { body: "blocked", eyes: "• •", drift: 0, bob: 4, bobMs: 900,  halo: true,  cheeks: true },
  working: { body: "working", eyes: "• •", drift: 7, bob: 1.5, bobMs: 2600, halo: false, cheeks: false },
  ready:   { body: "done",    eyes: "^ ^", drift: 0, bob: 1, bobMs: 3200, halo: false, cheeks: true, sparkle: true },
  news:    { body: "done",    eyes: "^ ^", drift: 0, bob: 1, bobMs: 3200, halo: false, cheeks: false },
  resting: { body: "idle",    eyes: "– –", drift: 0, bob: 0, bobMs: 0,    halo: false, cheeks: false, zzz: true },
};

// Leaf colours, picked per space so a space's creatures share one.
export const LEAVES = ["ansi2", "ansi10", "ansi6", "ansi3", "ansi5", "ansi13"];
export const leafFor = (space) => LEAVES[hash(space) % LEAVES.length];

// Grid spots with a little jitter, so the meadow looks scattered but
// creatures never overlap and don't jump around when one comes or goes
// (a creature only moves when ones before it in the list close).
export const CELL_W = 56;
export const CELL_H = 58;
export function place(addresses, width) {
  const cols = Math.max(1, Math.floor(width / CELL_W));
  const cellW = width / cols;
  const spots = addresses.map((a, i) => {
    const h = hash(a);
    const col = i % cols, row = Math.floor(i / cols);
    const jx = ((h % 13) - 6) * Math.min(1, (cellW - 40) / 24);
    const jy = (((h >> 4) % 9) - 4);
    return { x: Math.round(col * cellW + (cellW - 40) / 2 + jx), y: Math.round(row * CELL_H + 10 + jy) };
  });
  const rows = Math.max(1, Math.ceil(addresses.length / cols));
  return { spots, cols, height: rows * CELL_H + 8 };
}

// Drift period varies per creature so they don't move in step.
export const driftMs = (address) => 5200 + (hash(address) % 9) * 450;

// "2 need you · 5 working · 2 resting"
export function summary(moods) {
  const n = (m) => moods.filter((x) => x === m).length;
  const parts = [];
  if (n("needs")) parts.push(`${n("needs")} need${n("needs") === 1 ? "s" : ""} you`);
  if (n("ready")) parts.push(`${n("ready")} prep ready`);
  if (n("working")) parts.push(`${n("working")} working`);
  if (n("news")) parts.push(`${n("news")} finished`);
  if (n("resting")) parts.push(`${n("resting")} resting`);
  return parts.join(" · ");
}

// To-do helper records (todo-prep/<slug>.json) with a handover .md next to
// them → the set of terminals whose prep is ready.
export function readyTerminals(records) {
  return new Set(records.filter((r) => r && r.terminal && r.ready && r.status !== "skip").map((r) => r.terminal));
}
