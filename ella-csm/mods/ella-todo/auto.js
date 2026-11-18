// Alert to-dos that ~/morning-launch/alert-check closes by itself when every check agrees
// there's nothing to do. It records its progress as "auto" in todo-prep/<slug>.json and
// appends each closed item to todo-prep/autoclosed.json. Pure functions; main.js reads files.

// The line under a helper's status: what the auto-close check is doing, or why it kept the item.
export function autoLine(rec) {
  const a = rec?.auto;
  if (!a?.state) return null;
  if (a.state === "checking") return { kind: "working", text: "double-checking" };
  if (a.state === "closing") return { kind: "working", text: "all checks agree, closing" };
  if (a.state === "keep") return { kind: "kept", text: `kept open: ${a.why || "checks didn't all agree"}` };
  return null;
}

// Items closed by alert-check on `today` (YYYY-MM-DD), newest first.
export function closedToday(raw, today) {
  let items;
  try { items = JSON.parse(raw ?? ""); } catch { return []; }
  if (!Array.isArray(items)) return [];
  return items.filter((i) => (i?.at ?? "").startsWith(today)).sort((a, b) => (a.at < b.at ? 1 : -1));
}

// A Slack message link (…/p1794997688116579) → its ts ("1794997688.116579"), the key alerts.read uses.
export function tsFromLink(link) {
  const m = /\/p(\d{10})(\d{6})/.exec(link ?? "");
  return m ? `${m[1]}.${m[2]}` : null;
}

// The alerts.read map with these closed items' posts marked read; same object back when nothing changes.
export function markClosedRead(read, closed) {
  const out = { ...(read ?? {}) };
  let changed = false;
  for (const c of closed) {
    const ts = tsFromLink(c.slack);
    if (ts && !out[ts]) { out[ts] = 1; changed = true; }
  }
  return changed ? out : read;
}
