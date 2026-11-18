import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addMinimised, liveMinimised, removeMinimised } from "../mods/ella-minimised/minimised.js";

test("adds newest first, never twice", () => {
  let l = addMinimised([], { terminal: "t1" });
  l = addMinimised(l, { terminal: "t2" });
  l = addMinimised(l, { terminal: "t1", name: "again" });
  assert.deepEqual(l.map((m) => m.terminal), ["t1", "t2"]);
  assert.equal(l[0].name, "again");
});

test("only live terminals count", () => {
  const l = [{ terminal: "t1" }, { terminal: "t2" }, { terminal: "t3" }];
  const terms = [{ address: "t1", state: "live" }, { address: "t2", state: "finished" }];
  assert.deepEqual(liveMinimised(l, terms).map((m) => m.terminal), ["t1"]);
  assert.deepEqual(liveMinimised(null, terms), []);
});

test("remove", () => {
  assert.deepEqual(removeMinimised([{ terminal: "t1" }, { terminal: "t2" }], "t1"), [{ terminal: "t2" }]);
});

test("copies match", () => {
  const a = readFileSync(new URL("../mods/ella-minimised/minimised.js", import.meta.url), "utf8");
  for (const m of ["ella-pane", "ella-tabs"])
    assert.equal(readFileSync(new URL(`../mods/${m}/minimised.js`, import.meta.url), "utf8"), a, m);
});
