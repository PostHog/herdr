// node ~/.config/herdr-app/tests/close-guard.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkedItems, tick, slug } from "../mods/ella-close-guard/links.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  ", name); };

const text = "# to-do\n\n- [ ] email acme\n- [ ] chase globex\n- [ ] no helper yet\n- [x] call globex <!-- done:2026-11-13 -->\n";
const records = {
  [slug("email acme")]: { status: "running", terminal: "t20" },
  [slug("chase globex")]: { status: "running", terminal: "t21" },
  [slug("call globex")]: { status: "running", terminal: "t20" },
};

t("the copy of todo/list.js matches the original", () => {
  const strip = (s) => s.replace(/^\/\/ Copy of .*\n/, "");
  const here = new URL("../mods/", import.meta.url);
  assert.equal(strip(readFileSync(new URL("ella-close-guard/todo-list.js", here), "utf8")), readFileSync(new URL("ella-todo/list.js", here), "utf8"));
});
t("finds open items whose helper terminal is closing", () => {
  assert.deepEqual(linkedItems(text, records, ["t20"]).map((i) => i.text), ["email acme"]);
});
t("a whole tab can link several items", () => {
  assert.deepEqual(linkedItems(text, records, ["t20", "t21", "t99"]).map((i) => i.text), ["email acme", "chase globex"]);
});
t("nothing linked for an ordinary terminal or no todo file", () => {
  assert.deepEqual(linkedItems(text, records, ["t5"]), []);
  assert.deepEqual(linkedItems(null, records, ["t20"]), []);
});
t("tick marks just those items done today and keeps the rest", () => {
  assert.equal(tick(text, ["email acme"], "2026-11-14"),
    "# to-do\n\n- [x] email acme <!-- done:2026-11-14 -->\n- [ ] chase globex\n- [ ] no helper yet\n- [x] call globex <!-- done:2026-11-13 -->\n");
});
console.log(`${n} passed`);
