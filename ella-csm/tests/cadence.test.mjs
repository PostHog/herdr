// node ~/.config/herdr-app/tests/cadence.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daysSince, band, bandColor, renewal, touched, parse } from "../mods/ella-accounts/cadence.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  ", name); };
const now = new Date(2026, 10, 15, 10, 0); // 15 nov 2026, local

t("days are calendar days, local time", () => {
  assert.equal(daysSince(new Date(2026, 10, 14, 23, 50).toISOString(), now), 1);
  assert.equal(daysSince(new Date(2026, 10, 15, 0, 5).toISOString(), now), 0);
  assert.equal(daysSince(null, now), null);
  assert.equal(daysSince("nonsense", now), null);
});
t("bands: green to 4 weeks, amber to 8, pink after, none = no touch", () => {
  assert.equal(band(0), "green"); assert.equal(band(28), "green");
  assert.equal(band(29), "amber"); assert.equal(band(56), "amber");
  assert.equal(band(57), "pink"); assert.equal(band(null), "none");
});
t("band colours: sage, amber, sakura (no touch is pink too)", () => {
  const th = { ansi1: "pink", ansi2: "green", ansi3: "amber" };
  assert.equal(bandColor(th, "green"), "green"); assert.equal(bandColor(th, "amber"), "amber");
  assert.equal(bandColor(th, "pink"), "pink"); assert.equal(bandColor(th, "none"), "pink");
});
t("renewal line", () => {
  assert.deepEqual(renewal({ contract_ends_at: null }, now), { text: "monthly", soon: false, ended: false });
  assert.deepEqual(renewal({ contract_ends_at: "2027-03-26" }, now), { text: "renews 26 mar 2027", soon: false, ended: false });
  assert.equal(renewal({ contract_ends_at: "2027-02-01" }, now).soon, true);
  assert.deepEqual(renewal({ contract_ends_at: "2026-11-04" }, now), { text: "contract ended 4 nov", soon: true, ended: true });
});
t("touched line", () => {
  assert.equal(touched({ last_touch: new Date(2026, 10, 9, 12).toISOString(), touch_source: "email" }, now), "6d ago · email");
  assert.equal(touched({ last_touch: new Date(2026, 10, 14, 12).toISOString(), touch_source: "call" }, now), "yesterday · call");
  assert.equal(touched({}, now), "no touch on record");
});
t("parse keys by slug and survives junk", () => {
  assert.deepEqual(Object.keys(parse(JSON.stringify({ accounts: [{ slug: "acme" }, { slug: "dunder-mifflin" }] }))), ["acme", "dunder-mifflin"]);
  assert.deepEqual(parse("{"), {}); assert.deepEqual(parse(null), {});
});
t("every copy of cadence.js is the same", () => {
  const home = new URL("../mods/", import.meta.url);
  const ref = readFileSync(new URL("ella-accounts/cadence.js", home), "utf8");
  for (const m of ["ella-spaces", "ella-tabs"]) assert.equal(readFileSync(new URL(`${m}/cadence.js`, home), "utf8"), ref, m);
});
console.log(`${n} passed`);
