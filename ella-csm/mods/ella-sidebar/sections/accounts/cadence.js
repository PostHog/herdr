// Cadence for account spaces: days since Ella last touched an account (a CA
// meeting, an email she sent, a call Granola heard, or one she marked), banded
// green, then amber, then pink past 8 weeks; and the renewal line from the
// contract end. Data: ~/book/spaces/cadence.json, written by ~/.local/bin/book-spaces.
// The same file is copied into accounts, ella-spaces and ella-tabs (mods can't
// import each other); tests/cadence.test.mjs fails if they drift. Pure, so node can test it.

export const AMBER_AFTER = 28; // days: green up to four weeks
export const PINK_AFTER = 56; // days: pink past eight weeks
export const FILE = "book/spaces/cadence.json";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const dayOf = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

// Whole calendar days between then and now, in local time (yesterday = 1).
export function daysSince(iso, now = new Date()) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.round((dayOf(now) - dayOf(then)) / 86400000));
}

export function band(days) {
  if (days === null || days === undefined) return "none";
  if (days > PINK_AFTER) return "pink";
  if (days > AMBER_AFTER) return "amber";
  return "green";
}

// The theme colour for a band: sage, amber, sakura. No touch on record reads pink too.
export function bandColor(t, b) {
  return b === "green" ? t.ansi2 : b === "amber" ? t.ansi3 : t.ansi1;
}

export function shortDate(iso, now = new Date()) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

// "renews 26 mar 2027" (soon: within 90 days), "contract ended 4 nov", "monthly".
export function renewal(acc, now = new Date()) {
  const end = acc?.contract_ends_at;
  if (!end) return { text: "monthly", soon: false, ended: false };
  const days = Math.round((Date.parse(`${end}T12:00:00`) - now.getTime()) / 86400000);
  if (days < 0) return { text: `contract ended ${shortDate(end, now)}`, soon: true, ended: true };
  return { text: `renews ${shortDate(end, now)}`, soon: days <= 90, ended: false };
}

// "6d ago · email", "no touch on record".
export function touched(acc, now = new Date()) {
  const days = daysSince(acc?.last_touch, now);
  if (days === null) return "no touch on record";
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
  return acc.touch_source ? `${when} · ${acc.touch_source}` : when;
}

// The file's accounts keyed by space name (slug). Bad or missing file: {}.
export function parse(raw) {
  try {
    const data = JSON.parse(raw ?? "");
    return Object.fromEntries((data.accounts ?? []).map((a) => [a.slug, a]));
  } catch {
    return {};
  }
}
