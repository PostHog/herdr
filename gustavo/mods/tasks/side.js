// Sessions side by side. The layout's "main" row holds the shown tab ("main-tab") and, beside it,
// one column per session pinned there: a session-head header over a layout terminal block showing
// that session's terminal. The session stays in its own tab and task; this is only a view of it.
// Pins live in the layout file itself (never layout.set, which rewrites the whole tree), so they
// survive restarts and the user can resize them by dragging the dividers.

import { layout, shared, appHome, readTextFile, writeTextFile, terminals, notify, exec } from "herdr";

export const MAIN_ROW = "main"; // the row in the main-stack's Work view
export const MAIN_TAB = "main-tab"; // the block showing the shown tab, inside that row
export const SIDE_DRAG = "tasks.sideDrag"; // { addr, name, tab, space, at }: a session dragged out of the sidebar
export const UNPINNING = "tasks.unpinning"; // the terminal tasks.unpin takes out (set by session-head)
const PREFIX = "side-";

const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null));
// A column's terminal: its terminal block's, or its header's props (Herdr drops the terminal block
// from the file once that terminal ends, leaving the header alone).
const termOf = (node) => {
  const kids = node?.id?.startsWith(PREFIX) ? node.children ?? [] : [];
  return kids.find((c) => c.content?.terminal)?.content?.terminal ?? kids.find((c) => c.content?.props?.terminal)?.content?.props?.terminal ?? null;
};

// The main row's columns in order: { main: true } for the shown tab, { addr } for each pinned session.
export function columns() {
  const row = findNode(layout(), MAIN_ROW);
  return (row?.children ?? []).map((c) => (c.id === MAIN_TAB ? { main: true } : { addr: termOf(c) })).filter((c) => c.main || c.addr);
}

export const pinned = () => new Set(columns().filter((c) => c.addr).map((c) => c.addr));

function column(addr, size = { weight: 1 }) {
  const id = PREFIX + addr.replace(/[^A-Za-z0-9]/g, "-");
  // The same frame as the tab block's panes (see "main-tab" in the layout).
  return {
    id, type: "column", size,
    background: "#111720", border: { width: 1, color: "border" }, radius: 10, focus: { border: { width: 1, color: "accent" } },
    children: [
      { id: `${id}-head`, type: "block", size: { px: 30 }, content: { mod: "session-head", props: { terminal: addr } } },
      { id: `${id}-term`, type: "block", content: { terminal: addr } },
    ],
  };
}

// Applies change(children) to the main row in the layout file; it returns false to leave it alone.
async function editRow(change) {
  const path = `${appHome()}/layouts/${shared("layout")}.json`;
  const before = await readTextFile(path);
  const tree = JSON.parse(before);
  const row = findNode(tree, MAIN_ROW);
  if (row?.type !== "row") throw new Error(`The layout has no "${MAIN_ROW}" row to put sessions side by side in.`);
  if (change(row.children) === false) return;
  await writeTextFile(path, JSON.stringify(tree, null, 2) + "\n", before);
}

// Shows the session in terminal `addr` at `index` among the main row's columns (moving it if it's there).
export async function pin(addr, index) {
  await editRow((kids) => {
    const at = kids.findIndex((c) => termOf(c) === addr);
    if (at >= 0) {
      kids.splice(at, 1);
      if (at < index) index--;
    }
    kids.splice(Math.max(0, Math.min(index, kids.length)), 0, column(addr));
  });
}

export async function unpin(addrs) {
  const gone = new Set(addrs);
  await editRow((kids) => {
    const keep = kids.filter((c) => !gone.has(termOf(c)));
    if (keep.length === kids.length) return false;
    kids.splice(0, kids.length, ...keep);
  });
}

// Keeps the columns in step with their terminals, in the layout file (the loaded layout already
// leaves out a block whose terminal is gone, and Herdr then drops it from the file too): a column
// whose terminal ended goes; one whose terminal is back (after a reboot, the same address) gets
// its terminal block again. Only this computer's: another machine's terminals disappear while
// Herdr can't reach it. hc has the last word, so a list still loading at start empties nothing.
export async function prune() {
  const path = `${appHome()}/layouts/${shared("layout")}.json`;
  const row = findNode(JSON.parse(await readTextFile(path)), MAIN_ROW);
  const live = new Set(terminals().filter((x) => x.state === "live").map((x) => x.address));
  const dead = new Set();
  const bare = new Set();
  for (const c of row?.children ?? []) {
    const addr = termOf(c);
    if (!addr || addr.includes("/")) continue;
    let alive = live.has(addr);
    if (!alive) {
      const r = await exec("hc", ["get", addr, "--json"]).catch(() => null);
      alive = r?.code === 0 && JSON.parse(r.stdout).state === "live";
    }
    if (!alive) dead.add(addr);
    else if (!c.children.some((k) => k.content?.terminal)) bare.add(addr);
  }
  if (!dead.size && !bare.size) return;
  try {
    await editRow((kids) => {
      const keep = kids.filter((c) => !dead.has(termOf(c))).map((c) => (bare.has(termOf(c)) ? column(termOf(c), c.size) : c));
      kids.splice(0, kids.length, ...keep);
    });
  } catch (e) {
    notify({ title: "Couldn't update the sessions shown side by side", body: String(e?.message ?? e), level: "error" });
  }
}
