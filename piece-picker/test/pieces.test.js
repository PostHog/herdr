import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, summaryOf, reportOf } from "../mods/piece-picker/pieces.js";

test("scan keeps top-level pieces and their layouts, and skips nested recipes", () => {
  const out = ["/r/b/RECIPE.md", "/r/a/RECIPE.md", "/r/a/layouts/A-Wide.json", "/r/a/docs/RECIPE.md", "/r/c/layouts/x.json", ""].join("\n");
  assert.deepEqual(scan(out, "/r"), [
    { name: "a", layouts: ["A-Wide"] },
    { name: "b", layouts: [] },
  ]);
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
