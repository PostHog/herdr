// node ~/.config/herdr-app/tests/heard.test.mjs
import assert from "node:assert/strict";
import { pending, day, todoText, source, swipe } from "../mods/ella-todo/heard.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  ", name); };

const card = { id: "a", status: "pending", account: "acme", meeting_title: "Pat and Ella", meeting_at: "2026-11-13T10:00:00.000+00:00",
  todo: "Send Pat the setup notes", quote: "I can send over the setup notes", time: "26:27" };
const raw = JSON.stringify({ items: [card, { ...card, id: "b", status: "accepted" }, { ...card, id: "c" }] });

t("only pending, minus ones decided this session", () => assert.deepEqual(pending(raw, new Set(["c"])).map((c) => c.id), ["a"]));
t("bad or missing file → nothing", () => { assert.deepEqual(pending("{"), []); assert.deepEqual(pending(null), []); });
t("day", () => assert.equal(day("2026-11-03T10:00"), "3 Nov"));
t("todo text names the call", () => assert.equal(todoText(card), "Send Pat the setup notes (acme call, 13 Nov at 26:27)"));
t("todo text without account uses the meeting title", () => assert.equal(todoText({ ...card, account: null, time: "" }), "Send Pat the setup notes (Pat and Ella, 13 Nov)"));
t("source line", () => assert.equal(source(card), "acme · Pat and Ella · 13 Nov"));
t("sideways swipe accumulates", () => assert.equal(swipe(10, { touch_phase: "moved", delta: { x: -30, y: 2 } }).offset, -20));
t("vertical scroll ignored", () => assert.equal(swipe(10, { touch_phase: "moved", delta: { x: 3, y: 20 } }).offset, 10));
t("far enough → dismiss on release", () => assert.equal(swipe(-90, { touch_phase: "ended", delta: { x: 0, y: 0 } }).dismiss, true));
t("not far enough → snaps back", () => assert.deepEqual(swipe(-40, { touch_phase: "ended", delta: { x: 0, y: 0 } }), { offset: 0, dismiss: false }));
console.log(`${n} passed`);
