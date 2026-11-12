// Plan limits straight from Claude Code's /usage screen, for every Claude subscription in
// settings().claudeProfiles: a hidden Claude session starts, /usage is typed in, the screen is read,
// and the session ends. /usage sends nothing to the model, so this costs no tokens. It covers what the
// statusline doesn't carry: per-model weekly limits (Fable) and usage credits.
import { hc, home, exec } from "herdr";
import { settings } from "./shared.js";

const DEFAULT_DIR = "~/.claude";
const absolute = (path) => path.replace(/^~/, home()).replace(/\/$/, "");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "claude";
// Mods have no setTimeout, and this runs outside a view's cx, so it sleeps with /bin/sleep.
const wait = (ms) => exec("/bin/sleep", [String(ms / 1000)]).catch(() => null);

async function screen(name) {
  const r = await hc(["read", name, "--lines", "0"]).catch(() => null);
  return r?.code === 0 ? r.stdout : "";
}

// "Current session" / "Current week (Fable)" headings, each followed by "N% used" and "Resets …".
export function parseUsage(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const windows = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(Current session|Current week.*|Usage credits)$/.exec(lines[i]);
    if (!heading) continue;
    const label = heading[1] === "Current session" ? "5h" : heading[1] === "Usage credits" ? "credits"
      : heading[1].replace(/^Current week \((.+)\)$/, "$1").replace(/^all models$/, "week");
    if (label === "credits" && /credits are off/i.test(lines[i + 1] ?? "")) { windows.push({ label, off: true }); continue; }
    const used = /(\d+(?:\.\d+)?)% used/.exec(lines[i + 1] ?? "");
    if (!used) continue;
    const after = lines[i + 2] ?? "";
    const resets = /Resets (.+?)(?: \([^)]*\))?$/.exec(after.replace(/^.*·\s*/, ""))?.[1] ?? null;
    const spent = /(\$[\d.,]+) \/ (\$[\d.,]+)/.exec(after);
    windows.push({ label, pct: Number(used[1]), resetsAt: resetTime(resets), spent: spent ? `${spent[1]} of ${spent[2]}` : null });
  }
  return windows;
}

// "2:29pm", "Nov 13 at 4pm" or "Dec 1" (local time) to epoch ms, so every reset reads "in 3h".
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function resetTime(text, now = new Date()) {
  if (!text) return null;
  const m = /^(?:([A-Za-z]{3})\w* (\d{1,2}))?(?:\s*at\s*)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i.exec(text.trim());
  if (!m || (!m[1] && !m[3])) return null;
  const d = new Date(now);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    d.setMonth(month, Number(m[2]));
    if (d < now && now - d > 30 * 864e5) d.setFullYear(d.getFullYear() + 1);
  }
  let hour = m[3] ? Number(m[3]) % 12 + (m[5].toLowerCase() === "pm" ? 12 : 0) : 0;
  d.setHours(hour, m[4] ? Number(m[4]) : 0, 0, 0);
  if (!m[1] && d < now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function readProfile(profile) {
  const name = `squirrel-usage-${slug(profile.name)}`;
  const dir = `${home()}/.config/herdr-app/data/squirrel/usage`;
  await exec("/bin/mkdir", ["-p", dir]).catch(() => null);
  await hc(["kill", name]).catch(() => null);
  await hc(["rm", name]).catch(() => null);
  // Claude's default config must start without CLAUDE_CONFIG_DIR: naming ~/.claude explicitly makes
  // Claude treat it as a fresh install with no login.
  const dirPath = absolute(profile.configDir ?? DEFAULT_DIR);
  const argv = dirPath === absolute(DEFAULT_DIR) ? ["env", "SQUIRREL_PROBE=1", "claude"] : ["env", "SQUIRREL_PROBE=1", `CLAUDE_CONFIG_DIR=${dirPath}`, "claude"];
  const started = await hc(["run", "--bg", "--no-notify", "--name", name, "--cwd", dir, ...argv]).catch(() => null);
  if (started?.code !== 0) return null;
  try {
    await hc(["wait", name, "--timeout", "25"]).catch(() => null);
    // The folder is an empty one this mod made, so trusting it is safe. The dialog's default is "No, exit".
    if (/trust this folder/i.test(await screen(name))) {
      await hc(["keys", name, "down", "enter"]);
      await hc(["wait", name, "--timeout", "15"]).catch(() => null);
    }
    await hc(["keys", name, "/", "u", "s", "a", "g", "e", "enter"]);
    for (let i = 0; i < 20; i++) {
      await wait(750);
      const text = await screen(name);
      if (/Current week/.test(text) && !/Refreshing|Loading/.test(text)) return parseUsage(text);
    }
    return parseUsage(await screen(name));
  } finally {
    await hc(["kill", name]).catch(() => null);
    await hc(["rm", name]).catch(() => null);
    // Claude saves a session for every start, so each read leaves one behind in the probe folder's
    // project directory. Only these probes ever run there, so clear it.
    await exec("/bin/sh", ["-c", 'rm -f "$1"/projects/*-data-squirrel-usage/*.jsonl', "sh", dirPath]).catch(() => null);
  }
}

// { "<config dir>": { name, windows: [{ label, pct, resets, spent }], at } } for each profile.
export async function readUsage() {
  const out = {};
  for (const profile of settings().claudeProfiles) {
    const windows = await readProfile(profile).catch(() => null);
    if (windows?.length) out[absolute(profile.configDir ?? DEFAULT_DIR)] = { name: profile.name, windows, at: Date.now() };
  }
  return out;
}
