// cmd-a: the focused pane fills its column and every other pane shrinks to its header.
// cmd-s: only the panes above it shrink; the focused pane takes their space, the ones below keep their size.
// cmd-shift-s: the same for the panes below it.
// cmd-shift-a: the open panes (and the focused one) the same height; panes shrunk to their header stay so.
// The same key again within 5 seconds, on the same pane, puts the sizes back.
// Herdr can't report pane heights, so they're worked out from each terminal's visible rows (and the
// sizes set here last, which are exact), and the move is eased by resizing in small steps.
// Assumes the tab's panes are stacked in one column.
import { spaces, panes, run, settings, hc } from "herdr";

const HEADER = 30, PAD = 10.6, FRAMES = 12, FRAME_MS = 16, UNDO_MS = 5000;
const ease = (x) => 1 - Math.pow(1 - x, 3);
const known = {};
let busy = false, last = null;

async function rows(p) {
  if (p.scroll?.len) return p.scroll.len;
  if (!p.terminal) return 10;
  const r = await hc(["get", p.terminal]).catch(() => null);
  try { return JSON.parse(r?.stdout ?? "").rows ?? 10; } catch { return 10; }
}

function rowPx() {
  const s = settings();
  return Number(s.font_size ?? 14) * Number(s.terminal_line_height ?? 1) * 1.328;
}

async function measure(column) {
  const cell = rowPx();
  return Promise.all(column.map(async (p) => {
    const r = await rows(p), k = known[p.pane];
    if (k && k.rows === r) return k.px;
    return r <= 1 ? HEADER : HEADER + PAD + (r + 0.5) * cell;
  }));
}

// Eases every pane but `filler` from `from` to `to` px; `filler` takes whatever is left.
async function animate(cx, column, filler, from, to) {
  run("layout.resize", { id: column[filler].pane, weight: 1 });
  for (let f = 1; f <= FRAMES; f++) {
    const k = ease(f / FRAMES);
    column.forEach((p, i) => { if (i !== filler) run("layout.resize", { id: p.pane, px: Math.round(from[i] + (to[i] - from[i]) * k) }); });
    await cx.sleep(FRAME_MS);
  }
  // Hand every open pane a share in proportion to where it ended, so a drag afterwards works as on any
  // layout. Panes shrunk to their header stay fixed at it, so the column getting shorter (cmd-b opening
  // the panel above it) takes the space from the open panes, not from the headers.
  const total = from.reduce((a, b) => a + b, 0);
  const rest = total - to.reduce((sum, v, i) => (i === filler ? sum : sum + v), 0);
  column.forEach((p, i) => run("layout.resize", i !== filler && to[i] <= HEADER + 5
    ? { id: p.pane, px: HEADER }
    : { id: p.pane, weight: Math.max(1, i === filler ? rest : to[i]) }));
  await cx.sleep(250);
  const after = await Promise.all(column.map(rows));
  column.forEach((p, i) => { known[p.pane] = { px: Math.round(i === filler ? rest : to[i]), rows: after[i] }; });
}

export function fitPanes(mode, cx) {
  if (busy) return;
  busy = true;
  cx.spawn(async (cx) => { try { await fit(mode, cx); } finally { busy = false; } });
}

async function fit(mode, cx) {
  const tab = spaces().find((s) => s.active)?.tabs?.find((t) => t.active)?.id;
  const column = panes().filter((p) => p.tab === tab);
  const at = column.findIndex((p) => p.focused);
  if (at < 0 || column.length < 2 || column[at].zoomed) return;
  const from = await measure(column);
  const ids = column.map((p) => p.pane).join();

  if (last && last.mode === mode && last.ids === ids && last.filler === column[at].pane && Date.now() - last.at < UNDO_MS) {
    const back = last;
    last = null;
    const filler = Math.max(0, column.findIndex((p) => p.pane === back.filler));
    await animate(cx, column, filler, from, back.sizes);
    return;
  }

  const total = from.reduce((a, b) => a + b, 0);
  const collapsed = (i) => i !== at && from[i] <= HEADER + 5;
  const open = column.filter((_, i) => !collapsed(i)).length;
  const shared = (total - from.reduce((sum, v, i) => (collapsed(i) ? sum + v : sum), 0)) / open;
  const to = mode === "even" ? from.map((v, i) => (collapsed(i) ? v : shared))
    : from.map((v, i) => (i === at ? v : mode === "only" || (mode === "above" ? i < at : i > at) ? HEADER : v));
  await animate(cx, column, at, from, to);
  last = { mode, ids, at: Date.now(), sizes: from, filler: column[at].pane };
}
