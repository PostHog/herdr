// Panes minimised from their header (mods/ella-pane): the terminal is parked (no pane,
// still running) and listed here, in shared "pane.minimised", until it's brought back.
// Copied into mods/ella-pane and mods/ella-tabs too (mods can't import from each other);
// tests/minimised.test.mjs checks the copies match.
export const KEY = "pane.minimised";

// Add one, newest first, never twice.
export function addMinimised(list, entry) {
  return [entry, ...(list ?? []).filter((m) => m.terminal !== entry.terminal)];
}

// Only the ones whose terminal is still running (terminals() from herdr).
export function liveMinimised(list, terms) {
  const live = new Set((terms ?? []).filter((t) => t.state === "live").map((t) => t.address));
  return (list ?? []).filter((m) => live.has(m.terminal));
}

export function removeMinimised(list, terminal) {
  return (list ?? []).filter((m) => m.terminal !== terminal);
}
