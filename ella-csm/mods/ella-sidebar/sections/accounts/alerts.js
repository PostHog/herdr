// Scout alerts per account: the PostHog Slack app's posts from the last 7 days that
// name an account in the book, written to ~/book/spaces/alerts.json by
// ~/.local/bin/book-spaces (refresh-alerts, every 30 min in work hours). A post is
// read once Ella clicks it through to Slack (or "mark all read"); shared "alerts.read"
// holds { ts: 1 } for read posts. Opening the list alone reads nothing.
// Copied into accounts, ella-tabs and alerts (mods can't import each other);
// tests/alerts.test.mjs fails if they drift. Pure, so node can test it.

export const ALERTS_FILE = "book/spaces/alerts.json";
export const SEEN_KEY = "alerts.read";

// alerts.json -> { slug: [alert, newest first] }
export function parseAlerts(text) {
  let data;
  try { data = JSON.parse(text ?? ""); } catch { return {}; }
  const out = {};
  for (const a of data?.alerts ?? []) (out[a.slug] ??= []).push(a);
  for (const list of Object.values(out)) list.sort((a, b) => Number(b.ts) - Number(a.ts));
  return out;
}

// How many of an account's alerts Ella hasn't read.
export function unseen(list, read) {
  return (list ?? []).filter((a) => !read?.[a.ts]).length;
}

// The read map with these posts added, dropping posts no longer in the file (older
// than 7 days) so it doesn't grow forever.
export function markRead(read, tsList, all) {
  const live = new Set(Object.values(all ?? {}).flat().map((a) => a.ts));
  const out = {};
  for (const ts of Object.keys(read ?? {})) if (live.has(ts)) out[ts] = 1;
  for (const ts of tsList) out[ts] = 1;
  return out;
}

// "4h", "2d": how long ago an alert was posted.
export function ago(iso, now = new Date()) {
  const mins = Math.max(0, Math.round((now - new Date(iso)) / 60000));
  if (Number.isNaN(mins)) return "";
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}
