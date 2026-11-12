// Constants and helpers every view of the panel uses.
import { shared } from "herdr";

// Shared state keys (also read by squirrel-topbar, squirrel-pane-header and squirrel-rename).
export const NAMES = "squirrel.pane-names";
export const VIEW = "squirrel.view";
export const GITHUB = "squirrel.github";
export const TRIAGED = "squirrel.triaged";
export const REVIEW_PANES = "squirrel.review-panes";
export const VISITED = "squirrel.visited";
export const SETTINGS = "squirrel.settings";

export const ROW = 28, HEADER = 28, COLS = 22, MAX_ROWS = 10, LINE = 18;
export const STALE_MS = 48 * 3600 * 1000;
export const CARD_W = 240, CARD_H = 56, GAP = 6;
export const now = () => Date.now();

// squirrel-topbar loads ~/.config/herdr-app/squirrel.json into shared state; these are the defaults.
export const DEFAULTS = { reviewSkill: "explaining-prs", posthogCheckout: "~/code/posthog" };
export const settings = () => ({ ...DEFAULTS, ...(shared(SETTINGS) ?? {}) });

export function ago(ms) {
  const m = Math.max(0, (Date.now() - ms) / 60000);
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 60 / 24)}d`;
}

// Requested from me by name first, then newest first.
export const order = (a, b) => (b.mine - a.mine) || Date.parse(b.created) - Date.parse(a.created);
export const newest = (a, b) => Date.parse(b.created) - Date.parse(a.created);
