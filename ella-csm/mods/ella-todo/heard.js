// "Heard in meetings": commitments Ella made on calls, found by ~/morning-launch/heard/heard.py
// (launchd, every 15 min) and kept in ~/morning-launch/heard/heard.json. The panel shows the
// pending ones above the list; ticking adds one to todo.md (so todo-agent starts on it),
// swiping or × dismisses it. Pure functions only; main.js does the reading and running.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function pending(raw, decided = new Set()) {
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return (data?.items ?? []).filter((c) => c.status === "pending" && !decided.has(c.id));
}

export function day(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
}

const pretty = (slug) => (slug ?? "").replace(/-/g, " ");

// What lands in todo.md: the to-do, then where it came from, so the helper can find the call.
export function todoText(card) {
  const where = [card.account ? `${pretty(card.account)} call` : card.meeting_title, day(card.meeting_at)].filter(Boolean).join(", ");
  return `${card.todo} (${where}${card.time ? ` at ${card.time}` : ""})`;
}

export function source(card) {
  return [card.account ? pretty(card.account) : null, card.meeting_title, day(card.meeting_at)].filter(Boolean).join(" · ");
}

// Two-finger sideways swipe on a card. Returns the new offset and whether to dismiss.
export const SWIPE_AT = 80;
export function swipe(offset, e) {
  if (e.touch_phase === "started") return { offset: 0, dismiss: false };
  if (e.touch_phase === "ended" || e.touch_phase === "cancelled") return { offset: 0, dismiss: Math.abs(offset) >= SWIPE_AT };
  if (Math.abs(e.delta.x) <= Math.abs(e.delta.y)) return { offset, dismiss: false };
  return { offset: offset + e.delta.x, dismiss: false };
}
