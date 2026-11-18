// Which to-do items a closing tab or pane belongs to, and ticking them.
// An item is linked when its helper record (~/morning-launch/todo-prep/<slug>.json)
// names one of the terminals being closed. Pure functions; main.js reads and writes.

import { parse, serialize, slug } from "./todo-list.js";

// Open items in todo.md whose helper runs in one of `terminals`.
// `records` maps slug → parsed helper record (or null).
export function linkedItems(todoText, records, terminals) {
  const closing = new Set(terminals);
  return parse(todoText).filter((i) => !i.done && closing.has(records[slug(i.text)]?.terminal));
}

// todo.md with those items ticked as done today.
export function tick(todoText, texts, today) {
  const names = new Set(texts);
  const items = parse(todoText).map((i) => (!i.done && names.has(i.text) ? { ...i, done: true, doneOn: today } : i));
  return serialize(items);
}

export { slug };
