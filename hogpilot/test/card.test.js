import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCard } from "../mods/hogpilot/card.js";

const CARD = `## Acme
\`00000000-0000-0000-0000-000000000001\` · Customer Analytics account \`acct-1\`
Contract (billing, read 2026-11-10): prepaid credit in force until 2027-08-25
Billing (read 2026-11-15): MRR $10.5k (period ended 2026-10-25) · read live before you quote · current period forecast $11.8k

**Signals** _(from billing data and sessions, checked 2026-11-15 · 1 open · 0 closed in 30 days)_
- Credit runs out around Nov 23 · $24,522 left, about $12,315 a month · likely why (model-linked): A retry bug doubled events. · $148k ARR at stake · billing_usage_by_org_date
  - acts on: The team is preparing a top-up. since 2026-11-05 [session]
    > "calculate the top-up"
  - likely explains (model-linked): A retry bug doubled events. _(inferred)_ [cloud task]

**Memory** _(71 facts · captured through 2026-11-16 · thin: read live before you answer)_
## verdict
- Zero-length replays drive the bill. _(inferred, recheck: review date passed)_ [session]
_+53 withheld (char budget) - use --query <topic> to focus._

**Snapshots** _(as of the date shown; a -- row needs a live read)_
## metrics
- events_7d: 27,621,361 count  WoW -2.8% (-785,831) · MoM +5.2% (+1,374,870)  _(obs 8d · never verified)_
- mrr: 10,478.06 usd  QoQ +14% (+1,278.06)  _(obs 22d · checked 28d ago · drift)_
- x:mcp_agent_share: 0.71 ratio  _(obs 6d · never verified)_
- logs_usage: --  _(obs 83d · never verified · re-read live)_

**Something new** _(a block this reader has never seen)_
- keep me as I am`;

const card = parseCard(CARD, { year: 2026 });
const section = (title) => card.sections.find((s) => s.title === title);

test("the header keeps the facts and drops the agent instructions", () => {
  assert.equal(card.name, "Acme");
  assert.equal(card.orgId, "00000000-0000-0000-0000-000000000001");
  assert.deepEqual(card.facts[0], { label: "Contract", note: "billing, read Nov 10", value: "prepaid credit in force until Aug 25, 2027" });
  assert.equal(card.facts[1].value, "MRR $10.5k (period ended Oct 25) · current period forecast $11.8k");
  assert.equal(section("Memory").meta, "71 facts · through Nov 16 · thin");
});

test("a signal shows its headline, stake and cause, and folds its linked facts", () => {
  const s = section("Signals");
  assert.equal(s.meta, "1 open · 0 closed in 30 days · checked Nov 15");
  const [sig] = s.rows;
  assert.equal(sig.text, "Credit runs out around Nov 23");
  assert.equal(sig.chip, "$148k ARR");
  assert.equal(sig.stake, 148000);
  assert.deepEqual(sig.sub, ["$24,522 left, about $12,315 a month", "Likely why: A retry bug doubled events."]);
  assert.deepEqual(sig.children.map((c) => c.label), ["Acts on", "Likely explains"]);
  assert.deepEqual(sig.children[0].quotes, ["calculate the top-up"]);
  assert.deepEqual(sig.children[1].tags.map((t) => t.text), ["inferred", "cloud task"]);
});

test("snapshots hide the rows with no value and shorten the rest", () => {
  const s = section("Snapshots");
  assert.equal(s.meta, "3 metrics · 1 need a live read");
  assert.deepEqual(s.rows.map((r) => [r.label, r.value, r.change, r.flag]), [
    ["Events, 7d", "27.6M", "+5.2% MoM", null],
    ["MRR", "$10.5k", "+14% QoQ", "drift"],
    ["MCP agent share", "71%", "", null],
  ]);
  const memory = section("Memory");
  assert.deepEqual(memory.rows[1].tags.map((t) => [t.text, t.warn]), [["inferred", false], ["recheck: review date passed", true], ["session", false]]);
  assert.deepEqual(memory.notes, ["+53 more facts · ask Claude about a topic"]);
});

test("a section the reader does not know stays raw Markdown", () => {
  const s = section("Something new");
  assert.equal(s.kind, "raw");
  assert.equal(s.markdown, "**Something new** _(a block this reader has never seen)_\n- keep me as I am");
});
