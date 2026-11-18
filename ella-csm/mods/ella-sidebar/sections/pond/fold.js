// Folding sidebar sections (Spaces, Accounts, Agents, Pond, To-do in layouts/ella.json).
// Each open section keeps a fixed height you set by dragging its divider; the
// lowest open section fills whatever's left. A folded section shrinks to its
// header. The same file is copied into ella-spaces, accounts, ella-agents, pond and todo
// (mods can't import each other); tests/sidebar-fold.test.mjs fails if they drift.
// Pure apart from the herdr functions passed in, so node can test it.

export const SECTIONS = [
  { id: "spaces", folded: 31, open: 130 },
  { id: "accounts", folded: 31, open: 220 },
  { id: "agents", folded: 41, open: 280 },
  { id: "pond", folded: 34, open: 260 },
  { id: "todo", folded: 34, open: 300 },
];

export function findNode(tree, id) {
  if (!tree) return null;
  if (tree.id === id) return tree;
  for (const c of tree.children ?? []) {
    const n = findNode(c, id);
    if (n) return n;
  }
  return null;
}

// Sizes for every section, given which are folded and the remembered heights.
export function plan(folded, heights) {
  const open = SECTIONS.filter((s) => !folded[s.id]);
  const filler = open.length ? open[open.length - 1].id : null;
  return SECTIONS.map((s) =>
    folded[s.id] ? { id: s.id, px: s.folded }
    : s.id === filler ? { id: s.id, weight: 1 }
    : { id: s.id, px: heights[s.id] ?? s.open });
}

// The height a section shows now. A dragged size lives in Herdr's click state
// (layouts/.state/<layout>.json), not in layout(), so that wins.
export function currentPx(id, tree, state) {
  const clicked = state?.nodes?.[id]?.size;
  if (clicked) return clicked.px ?? null;
  return findNode(tree, id)?.size?.px ?? null;
}

// Remember the heights of open, fixed sections as they are now (so a drag
// sticks), flip one section, and resize them all.
export async function toggle(id, { layout, shared, setShared, run, readTextFile, appHome }) {
  const folded = { ...(shared("sidebar.folded") ?? {}) };
  const heights = { ...(shared("sidebar.heights") ?? {}) };
  const tree = layout();
  let state = null;
  try { state = JSON.parse(await readTextFile(`${appHome()}/layouts/.state/${shared("layout")}.json`)); } catch { state = null; }
  for (const s of SECTIONS) {
    const px = currentPx(s.id, tree, state);
    if (!folded[s.id] && px && px > s.folded + 4) heights[s.id] = Math.round(px);
  }
  folded[id] = !folded[id];
  setShared("sidebar.heights", heights);
  setShared("sidebar.folded", folded);
  // In the scrolling sidebar (mods/ella-sidebar) the sections aren't layout nodes:
  // it reads sidebar.folded/heights itself, so only resize the ones that exist.
  for (const p of plan(folded, heights)) {
    if (!findNode(tree, p.id)) continue;
    run("layout.resize", p.px ? { id: p.id, px: p.px } : { id: p.id, weight: p.weight });
  }
}

export const isFolded = (id, shared) => Boolean(shared("sidebar.folded")?.[id]);
