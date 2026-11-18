// node ~/.config/herdr-app/tests/alerts.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAlerts, unseen, markRead, ago } from "../mods/ella-accounts/alerts.js";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  ", name); };

const file = JSON.stringify({ alerts: [
  { slug: "globex", ts: "1794600000.1", at: "2026-11-13T10:00:00+00:00", title: "older" },
  { slug: "globex", ts: "1794700000.2", at: "2026-11-14T10:00:00+00:00", title: "newer" },
  { slug: "hooli", ts: "1794650000.3", at: "2026-11-13T20:00:00+00:00", title: "y" },
] });

t("grouped by account, newest first", () => {
  const a = parseAlerts(file);
  assert.deepEqual(Object.keys(a).sort(), ["globex", "hooli"]);
  assert.equal(a.globex[0].title, "newer");
});
t("bad or missing file is no alerts", () => {
  assert.deepEqual(parseAlerts(null), {});
  assert.deepEqual(parseAlerts("{nope"), {});
});
t("unread is per post: reading the newer one leaves the older one unread", () => {
  const a = parseAlerts(file);
  assert.equal(unseen(a.globex, undefined), 2);
  assert.equal(unseen(a.globex, { "1794700000.2": 1 }), 1);
  assert.equal(unseen(a.globex, { "1794700000.2": 1, "1794600000.1": 1 }), 0);
  assert.equal(unseen(undefined, null), 0);
});
t("markRead adds posts and drops ones gone from the file", () => {
  const a = parseAlerts(file);
  assert.deepEqual(markRead({ "1700000000.9": 1 }, ["1794650000.3"], a), { "1794650000.3": 1 });
  assert.deepEqual(markRead({ "1794650000.3": 1 }, ["1794600000.1"], a), { "1794650000.3": 1, "1794600000.1": 1 });
});
t("ago", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  assert.equal(ago("2026-11-16T11:30:00Z", now), "30m");
  assert.equal(ago("2026-11-16T07:00:00Z", now), "5h");
  assert.equal(ago("2026-11-13T12:00:00Z", now), "3d");
});
t("the copies in ella-tabs and alerts haven't drifted", () => {
  const base = new URL("../mods/", import.meta.url);
  const src = readFileSync(new URL("ella-accounts/alerts.js", base), "utf8");
  for (const m of ["ella-tabs", "ella-alerts", "ella-sidebar/sections/accounts"]) assert.equal(readFileSync(new URL(`${m}/alerts.js`, base), "utf8"), src, m);
});
console.log(`${n} passed`);
