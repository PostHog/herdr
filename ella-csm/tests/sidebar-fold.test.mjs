// node ~/.config/herdr-app/tests/sidebar-fold.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plan, currentPx, toggle, SECTIONS } from "../mods/ella-todo/fold.js";
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("  ok  ", name); };
const size = (p, id) => p.find((x) => x.id === id);

await t("all open: fixed heights, to-do fills the rest", () => {
  const p = plan({}, { spaces: 150 });
  assert.deepEqual(size(p, "spaces"), { id: "spaces", px: 150 });
  assert.deepEqual(size(p, "agents"), { id: "agents", px: 280 });
  assert.deepEqual(size(p, "todo"), { id: "todo", weight: 1 });
});
await t("folded sections shrink to their header", () => {
  const p = plan({ spaces: true, pond: true }, {});
  assert.equal(size(p, "spaces").px, 31); assert.equal(size(p, "pond").px, 34);
});
await t("to-do folded: the lowest open section fills instead", () => {
  const p = plan({ todo: true }, {});
  assert.deepEqual(size(p, "pond"), { id: "pond", weight: 1 }); assert.equal(size(p, "todo").px, 34);
});
await t("everything folded: nothing fills", () => {
  const all = Object.fromEntries(SECTIONS.map((s) => [s.id, true]));
  assert.ok(plan(all, {}).every((x) => x.px));
});
await t("a dragged size (click state) beats the layout file", () => {
  const tree = { id: "root", children: [{ id: "agents", size: { px: 280 } }] };
  assert.equal(currentPx("agents", tree, { nodes: { agents: { size: { px: 240 } } } }), 240);
  assert.equal(currentPx("agents", tree, null), 280);
});
await t("toggle remembers dragged heights and resizes every section", async () => {
  const store = { layout: "ella", "sidebar.folded": {}, "sidebar.heights": {} };
  const runs = [];
  await toggle("pond", {
    layout: () => ({ id: "root", children: SECTIONS.map((s) => ({ id: s.id, size: { px: s.open } })) }),
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; },
    run: (c, a) => runs.push([c, a]),
    readTextFile: async () => JSON.stringify({ nodes: { agents: { size: { px: 222 } } } }), appHome: () => "/x",
  });
  assert.equal(store["sidebar.heights"].agents, 222);
  assert.equal(store["sidebar.folded"].pond, true);
  assert.equal(runs.length, SECTIONS.length);
  assert.deepEqual(runs.find(([, a]) => a.id === "pond")[1], { id: "pond", px: 34 });
});
await t("every copy of fold.js is the same", () => {
  const home = new URL("../mods/", import.meta.url);
  const ref = readFileSync(new URL("ella-todo/fold.js", home), "utf8");
  for (const m of ["ella-spaces", "ella-accounts", "ella-agents", "ella-pond"]) assert.equal(readFileSync(new URL(`${m}/fold.js`, home), "utf8"), ref, m);
});
console.log(`${n} passed`);
