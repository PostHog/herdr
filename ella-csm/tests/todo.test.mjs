// node ~/.config/herdr-app/tests/todo.test.mjs
import assert from "node:assert/strict";
import { parse, serialize, add, toggle, remove, rollover } from "../mods/ella-todo/list.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  ", name); };

const text = "# to-do\n\n- [ ] email acme\n- [x] fix flag <!-- done:2026-11-12 -->\n- [x] call globex <!-- done:2026-11-13 -->\n";

t("parses open and done items with dates", () => {
  assert.deepEqual(parse(text), [
    { text: "email acme", done: false, doneOn: null },
    { text: "fix flag", done: true, doneOn: "2026-11-12" },
    { text: "call globex", done: true, doneOn: "2026-11-13" },
  ]);
});
t("ignores headings and blank lines", () => { assert.equal(parse("# x\n\nfoo\n").length, 0); });
t("round-trips", () => { assert.deepEqual(parse(serialize(parse(text))), parse(text)); });
t("add puts new items at the end of the open ones", () => {
  const items = add(parse(text), "  chase globex  ");
  assert.deepEqual(items.map((i) => i.text), ["email acme", "chase globex", "fix flag", "call globex"]);
});
t("add ignores empty text", () => { assert.equal(add(parse(text), "   ").length, 3); });
t("toggle ticks with today's date", () => {
  const items = toggle(parse(text), 0, "2026-11-13");
  assert.deepEqual(items.find((i) => i.text === "email acme"), { text: "email acme", done: true, doneOn: "2026-11-13" });
});
t("toggle again unticks", () => {
  const items = toggle(toggle(parse(text), 0, "2026-11-13"), 0, "2026-11-13");
  assert.equal(items[0].done, false); assert.equal(items[0].doneOn, null);
});
t("remove drops an item", () => { assert.equal(remove(parse(text), 1).length, 2); });
t("rollover keeps open items and today's ticks, archives older ticks", () => {
  const { keep, archived } = rollover(parse(text), "2026-11-13");
  assert.deepEqual(keep.map((i) => i.text), ["email acme", "call globex"]);
  assert.deepEqual(archived.map((i) => i.text), ["fix flag"]);
});
console.log(`${n} passed`);

// Background agents: a stable, filename-safe key per item text.
const { slug } = await import("../mods/ella-todo/list.js");
t("slug is filename-safe and short", () => { const s = slug("Draft VANDELAY follow-up: re/ Q4 (urgent!)"); assert.match(s, /^[a-z0-9-]+$/); assert.ok(s.length <= 52); });
t("slug is stable", () => { assert.equal(slug("check acme"), slug("check acme")); });
t("slug differs for different text with the same start", () => { assert.notEqual(slug("x".repeat(60) + "a"), slug("x".repeat(60) + "b")); });
const { slackLink } = await import("../mods/ella-todo/list.js");
const S = "https://posthog.slack.com/archives/C0000000SALES/p1700000000000001";
t("reads a slack comment and keeps the text and done date clean", () => {
  assert.deepEqual(parse(`- [ ] chase invoice <!-- slack:${S} -->\n- [x] old <!-- slack:${S} --> <!-- done:2026-11-12 -->\n`), [
    { text: "chase invoice", done: false, doneOn: null, slack: S },
    { text: "old", done: true, doneOn: "2026-11-12", slack: S },
  ]);
});
t("slack comment survives a round trip, and a tick", () => {
  const items = toggle(parse(`- [ ] chase invoice <!-- slack:${S} -->\n`), 0, "2026-11-18");
  assert.equal(serialize(items), `# to-do\n\n- [x] chase invoice <!-- slack:${S} --> <!-- done:2026-11-18 -->\n`);
  assert.deepEqual(parse(serialize(items)), items);
});
t("the slack comment doesn't change the item's slug", () => {
  assert.equal(slug(parse(`- [ ] chase invoice <!-- slack:${S} -->`)[0].text), slug("chase invoice"));
});
t("slackLink: comment, then pasted link, then found record, else null", () => {
  assert.equal(slackLink({ text: "x", slack: S }, { slack: "other" }), S);
  assert.equal(slackLink({ text: `see ${S}?thread_ts=1 please` }, null), `${S}?thread_ts=1`);
  assert.equal(slackLink({ text: "x" }, { slack: S }), S);
  assert.equal(slackLink({ text: "x" }, { slack: null }), null);
  assert.equal(slackLink({ text: "x" }, null), null);
});
console.log(`${n} passed`);
