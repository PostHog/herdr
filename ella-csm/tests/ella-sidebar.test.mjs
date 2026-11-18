// node ~/.config/herdr-app/tests/ella-sidebar.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { heightOf, dragTo, MIN } from "../mods/ella-sidebar/sizes.js";
import { SECTIONS } from "../mods/ella-todo/fold.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  ", name); };
const spaces = SECTIONS.find((s) => s.id === "spaces");

t("folded: header height; open: remembered height, else the default", () => {
  assert.equal(heightOf(spaces, { spaces: true }, { spaces: 400 }), spaces.folded);
  assert.equal(heightOf(spaces, {}, { spaces: 400 }), 400);
  assert.equal(heightOf(spaces, {}, {}), spaces.open);
});
t("never shorter than MIN", () => assert.equal(heightOf(spaces, {}, { spaces: 10 }), MIN));
t("dragging follows the pointer, unzoomed", () => {
  assert.equal(dragTo({ h0: 200, y0: 100 }, 155, 1.1), 250);
  assert.equal(dragTo({ h0: 200, y0: 100 }, -200, 1), MIN);
});
t("every section's code here matches its mod (run mods/ella-sidebar/sync.sh if not)", () => {
  const mods = new URL("../mods/", import.meta.url);
  const SRC = {"ella-spaces": "ella-spaces", "accounts": "ella-accounts", "ella-agents": "ella-agents", "pond": "ella-pond", "todo": "ella-todo"};
  for (const m of ["ella-spaces", "accounts", "ella-agents", "pond", "todo"]) {
    const src = readdirSync(new URL(`${SRC[m]}/`, mods)).filter((f) => f.endsWith(".js")).sort();
    const here = readdirSync(new URL(`ella-sidebar/sections/${m}/`, mods)).filter((f) => f.endsWith(".js")).sort();
    assert.deepEqual(here, src, `${m}: same files`);
    for (const f of src) assert.equal(readFileSync(new URL(`ella-sidebar/sections/${m}/${f}`, mods), "utf8"), readFileSync(new URL(`${SRC[m]}/${f}`, mods), "utf8"), `${m}/${f}`);
  }
});
console.log(`${n} passed`);
