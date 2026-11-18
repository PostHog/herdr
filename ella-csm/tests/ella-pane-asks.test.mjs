// node ~/.config/herdr-app/tests/ella-pane-asks.test.mjs
import assert from "node:assert/strict";
import { ASKS, withContext } from "../mods/ella-pane/asks.js";

const ca = ASKS.find((a) => a.key === "ca");
assert.ok(ca, "log to CA button exists");
assert.equal(ca.label, "log to CA");
assert.match(ca.text, /Customer Analytics note/);
assert.match(ca.text, /hp memory add/, "also logs to HogPilot");
assert.match(ca.text, /--supersedes/, "replaces stale HogPilot facts");
assert.match(ca.text, /note link/);

const thanks = ASKS.find((a) => a.key === "thanks");
assert.ok(thanks, "thank-you button exists");
assert.equal(thanks.label, "💖");
assert.equal(withContext(thanks.text, "to-do helpers", thanks.plain), "nice tysm", "sent as is, no space name");
assert.match(withContext(ca.text, "acme"), /Herdr space "acme"/, "other asks still get the space name");

const devbox = ASKS.find((a) => a.key === "devbox");
assert.ok(devbox, "devbox handover button exists");
assert.match(devbox.text, /`away`/, "sends with the away command");
assert.match(devbox.text, /none of my connectors/, "warns what the devbox lacks");
assert.match(devbox.text, /never message customers/);

const verify = ASKS.find((a) => a.key === "verify");
assert.ok(verify, "verify button exists");
assert.match(verify.text, /verify-output skill/, "still runs the skill");
assert.match(verify.text, /codex-pane/, "also starts a Codex check");
assert.match(verify.text, /run_in_background/, "Codex runs alongside the skill");

console.log("ella-pane asks: ok");
