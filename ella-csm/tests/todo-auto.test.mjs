// node ~/.config/herdr-app/tests/todo-auto.test.mjs
import assert from "node:assert/strict";
import { autoLine, closedToday, tsFromLink, markClosedRead } from "../mods/ella-todo/auto.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  ", name); };

t("no auto state, no line", () => { assert.equal(autoLine({ status: "running" }), null); assert.equal(autoLine(null), null); });
t("checking shows as working", () => { assert.deepEqual(autoLine({ auto: { state: "checking" } }), { kind: "working", text: "double-checking" }); });
t("kept shows why", () => { assert.equal(autoLine({ auto: { state: "keep", why: "Codex says action" } }).text, "kept open: Codex says action"); });
t("closed shows nothing (it's in the closed list)", () => { assert.equal(autoLine({ auto: { state: "closed" } }), null); });
t("closed today only, newest first", () => {
  const raw = JSON.stringify([{ at: "2026-11-17T10:00:00", text: "old" }, { at: "2026-11-18T09:00:00", text: "a" }, { at: "2026-11-18T11:00:00", text: "b" }]);
  assert.deepEqual(closedToday(raw, "2026-11-18").map((i) => i.text), ["b", "a"]);
});
t("bad file → empty", () => { assert.deepEqual(closedToday("nope", "2026-11-18"), []); assert.deepEqual(closedToday(null, "2026-11-18"), []); });
t("slack link → ts", () => { assert.equal(tsFromLink("https://posthog.slack.com/archives/C00000NEWS0/p1794997688116579"), "1794997688.116579"); });
t("marks closed posts read, same object when nothing new", () => {
  const closed = [{ slack: "https://x.slack.com/archives/C1/p1794997688116579" }];
  const read = markClosedRead({}, closed);
  assert.deepEqual(read, { "1794997688.116579": 1 });
  assert.equal(markClosedRead(read, closed), read);
});
console.log(`${n} passed`);
