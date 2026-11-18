// node ~/.config/herdr-app/tests/pond.test.mjs
import assert from "node:assert/strict";
import { mood, MOODS, place, summary, readyTerminals, leafFor, LEAVES, CELL_H } from "../mods/ella-pond/look.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  ", name); };

t("needing you wins over a ready prep", () => { assert.equal(mood("blocked", true), "needs"); });
t("working stays working even with a prep file", () => { assert.equal(mood("working", true), "working"); });
t("idle with a prep ready sparkles", () => { assert.equal(mood("idle", true), "ready"); assert.ok(MOODS.ready.sparkle); });
t("done while away is news, plain idle is resting", () => { assert.equal(mood("done", false), "news"); assert.equal(mood("idle", false), "resting"); });
t("only working creatures drift; only needs-you glows", () => {
  for (const [k, m] of Object.entries(MOODS)) { assert.equal(m.drift > 0, k === "working"); assert.equal(m.halo, k === "needs"); }
});
t("nine creatures fit in three rows at sidebar width", () => {
  const { spots, cols, height } = place(Array.from({ length: 9 }, (_, i) => `t${i}`), 212);
  assert.equal(cols, 3); assert.equal(height, 3 * CELL_H + 8);
  for (const s of spots) { assert.ok(s.x >= 0 && s.x + 40 <= 212, `x ${s.x}`); }
});
t("spots don't overlap", () => {
  const { spots } = place(Array.from({ length: 12 }, (_, i) => `t${i}x`), 212);
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
    const a = spots[i], b = spots[j];
    assert.ok(Math.abs(a.x - b.x) >= 40 || Math.abs(a.y - b.y) >= 48, `${i} vs ${j}`);
  }
});
t("a creature keeps its spot when one after it closes", () => {
  const a = place(["t1", "t2", "t3"], 212).spots, b = place(["t1", "t2"], 212).spots;
  assert.deepEqual(a.slice(0, 2), b);
});
t("summary reads plainly", () => {
  assert.equal(summary(["needs", "working", "working", "resting"]), "1 needs you · 2 working · 1 resting");
  assert.equal(summary(["needs", "needs", "ready"]), "2 need you · 1 prep ready");
});
t("ready terminals need a handover and a terminal", () => {
  const s = readyTerminals([{ terminal: "t1", ready: true }, { terminal: "t2", ready: false }, { ready: true }, { terminal: "t3", ready: true, status: "skip" }, null]);
  assert.deepEqual([...s], ["t1"]);
});
t("leaf colour is stable per space", () => { assert.equal(leafFor("sp1"), leafFor("sp1")); assert.ok(LEAVES.includes(leafFor("sp2"))); });
console.log(`${n} passed`);
