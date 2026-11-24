import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, summaryOf, reportOf, placeOf, layoutMods } from "../mods/piece-picker/pieces.js";

test("scan keeps top-level pieces with their layouts and mods, and skips nested recipes", () => {
  const out = ["/r/b/RECIPE.md", "/r/a/RECIPE.md", "/r/a/layouts/A-Wide.json", "/r/a/mods/a-bar/mod.json", "/r/a/docs/RECIPE.md", "/r/c/layouts/x.json", ""].join("\n");
  assert.deepEqual(scan(out, "/r"), [
    { name: "a", layouts: ["A-Wide"], mods: ["a-bar"] },
    { name: "b", layouts: [], mods: [] },
  ]);
});

test("placeOf says where a piece shows, checking its layout, then a block, then a key", () => {
  const bindings = [
    { section: "global", keys: "cmd-shift-u", action: "mod.open:lag" },
    { section: "global", keys: "cmd-shift-l", action: "layout.switch" },
  ];
  const shown = layoutMods({ children: [{ content: { mod: "tree" } }, { children: [{ content: { mod: "inbox" } }] }] });
  const where = (piece) => placeOf({ layouts: [], mods: [], ...piece }, { layout: "Tree", shown, bindings }).text;
  assert.equal(where({ layouts: ["Tree"], mods: ["tree"] }), "Your current layout");
  assert.equal(where({ layouts: ["Inbox"], mods: ["inbox"] }), "Shows in your layout");
  assert.equal(where({ mods: ["lag"] }), "Opens with ⌘⇧U");
  assert.equal(where({ layouts: ["Squirrel"], mods: ["squirrel"] }), "Adds a layout. Switch to it with ⌘⇧L");
  assert.equal(where({ mods: ["panel"] }), "Not in your layout. Its recipe says where to add it");
});

test("summaryOf takes the first sentence after headings and images, as install.sh does", () => {
  assert.equal(summaryOf("# Title\n\n![shot](p.png)\nOne thing. Then more.\n"), "One thing.");
});

test("reportOf gives moved files and the last stderr line on failure", () => {
  const stderr = "  moved your layouts/a.json to .posthog-herdr-backup/1/\n  noise\n\x1b[31mAnother install.sh is running (pid 7). Try again when it ends.\x1b[0m\n";
  const r = reportOf({ code: 1, stdout: "", stderr });
  assert.deepEqual(r, {
    level: "error",
    text: "moved your layouts/a.json to .posthog-herdr-backup/1/\nAnother install.sh is running (pid 7). Try again when it ends.",
  });
});

test("reportOf surfaces key binding warnings and new pieces on success, and nothing otherwise", () => {
  const warn = reportOf({ code: 0, stdout: "x\n  up to date\nNew: y Enable it with ./install.sh enable y\n", stderr: "  x/keys.json has key bindings.\n" });
  assert.equal(warn.level, "warn");
  assert.match(warn.text, /keys\.json/);
  assert.match(warn.text, /^New: y/m);
  assert.equal(reportOf({ code: 0, stdout: "x\n  up to date\n", stderr: "" }), null);
  assert.equal(reportOf({ code: 0, stdout: "x\n", stderr: "  x/keys.json has key bindings.\n" }, { keys: false }), null);
});
