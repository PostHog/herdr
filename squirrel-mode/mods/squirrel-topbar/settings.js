// Personal settings live in ~/.config/herdr-app/squirrel.json, outside the files install.sh manages,
// so updates never overwrite them. Every key is optional. This mod loads the file into shared state
// for the panel too, at start and before each GitHub refresh.
import { shared, setShared, exec } from "herdr";

export const SETTINGS = "squirrel.settings";
export const DEFAULTS = {
  reviewSkill: "explaining-prs",
  standupSkill: "standup",
  standupCommand: ["claude"],
  posthogCheckout: "~/code/posthog",
  mergedDays: 7,
};

export async function loadSettings() {
  const r = await exec("/bin/sh", ["-c", 'cat "$HOME/.config/herdr-app/squirrel.json" 2>/dev/null']).catch(() => null);
  let mine = {};
  try { mine = r?.stdout?.trim() ? JSON.parse(r.stdout) : {}; } catch { mine = { error: "squirrel.json isn't valid JSON" }; }
  if (JSON.stringify(mine) !== JSON.stringify(shared(SETTINGS) ?? {})) setShared(SETTINGS, mine);
}

export const squirrelSettings = () => ({ ...DEFAULTS, ...(shared(SETTINGS) ?? {}) });
