// The to-do list as a markdown checklist, so Claude (and you) can edit the file too:
//   - [ ] email acme
//   - [x] call globex <!-- done:2026-11-13 -->
//   - [ ] reply to the overdue invoice alert <!-- slack:https://posthog.slack.com/archives/C0…/p… -->
// The slack comment is the message the item came from (a "slack" button opens it).
// Pure functions only; main.js does the reading and writing.

const LINE = /^\s*-\s*\[( |x|X)\]\s*(.*)$/;
const DONE = /<!--\s*done:(\d{4}-\d{2}-\d{2})\s*-->/;
const SLACK = /<!--\s*slack:(\S+?)\s*-->/;

export function parse(text) {
  const items = [];
  for (const line of (text ?? "").split("\n")) {
    const m = line.match(LINE);
    if (!m) continue;
    const doneOn = m[2].match(DONE)?.[1] ?? null;
    const slack = m[2].match(SLACK)?.[1] ?? null;
    const body = m[2].replace(DONE, "").replace(SLACK, "").trim();
    if (!body) continue;
    const done = m[1] !== " ";
    items.push({ text: body, done, doneOn: done ? doneOn : null, ...(slack ? { slack } : {}) });
  }
  return items;
}

export function serialize(items) {
  const lines = items.map((i) => {
    const tail = `${i.slack ? ` <!-- slack:${i.slack} -->` : ""}${i.done && i.doneOn ? ` <!-- done:${i.doneOn} -->` : ""}`;
    return `- [${i.done ? "x" : " "}] ${i.text}${tail}`;
  });
  return `# to-do\n\n${lines.join("\n")}\n`;
}

// The Slack message an item came from: a slack comment on its line, a Slack link
// pasted in its text, or one todo-slack found by searching (found = that record).
const PASTED = /https:\/\/[\w-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+[^\s)>\]]*/;
export function slackLink(item, found) {
  return item.slack ?? item.text.match(PASTED)?.[0] ?? found?.slack ?? null;
}

export function add(items, text) {
  const clean = (text ?? "").trim();
  if (!clean) return items;
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  return [...open, { text: clean, done: false, doneOn: null }, ...done];
}

export function toggle(items, index, today) {
  return items.map((i, k) => (k !== index ? i : i.done ? { ...i, done: false, doneOn: null } : { ...i, done: true, doneOn: today }));
}

export function remove(items, index) {
  return items.filter((_, k) => k !== index);
}

// Unticked items carry over by themselves; ticks stay visible for the day they
// were ticked, then move to the archive.
export function rollover(items, today) {
  const keep = items.filter((i) => !i.done || i.doneOn === today);
  const archived = items.filter((i) => i.done && i.doneOn !== today);
  return { keep, archived };
}

// A stable, filename-safe key for an item, used to name its background-agent
// files in ~/morning-launch/todo-prep/ (<slug>.json, <slug>.md).
export function slug(text) {
  let h = 5381;
  for (const ch of text) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "item";
  return `${base}-${h.toString(36)}`;
}
