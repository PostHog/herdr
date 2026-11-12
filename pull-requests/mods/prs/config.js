import { appHome, readTextFile, writeTextFile, setShared } from "herdr";
import { DEFAULT_SERVICES } from "./status.js";

export const DEFAULT_CONFIG = {
  version: 1,
  repos: ["PostHog/posthog", "PostHog/*"],
  runner: { machine: null },
  checkouts: {},
  trunk: { repo: "PostHog/posthog", machine: null },
  models: { review: "claude-sonnet-5-5", judge: "claude-opus-5-5", keeper: "claude-opus-5-5" },
  keep: { mode: "dry-run", select: "manual", label: "keep-healthy", land: false, quietMinutes: 10, maxConcurrent: 1, dailyRuns: 6 },
  notifications: true,
  status: { services: DEFAULT_SERVICES },
};

let cache = null;
let raw = null;

export const configPath = () => `${appHome()}/data/prs-config.json`;

function merge(base, value) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [key, item] of Object.entries(value ?? {})) {
    if (item && typeof item === "object" && !Array.isArray(item) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) out[key] = merge(out[key], item);
    else out[key] = item;
  }
  return out;
}

export async function loadConfig() {
  raw = await readTextFile(configPath());
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  cache = merge(DEFAULT_CONFIG, parsed);
  return cache;
}

export function config() {
  return cache ?? DEFAULT_CONFIG;
}

export async function updateConfig(edit) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await loadConfig();
    const next = JSON.parse(JSON.stringify(cache));
    edit(next);
    const text = JSON.stringify(next, null, 2) + "\n";
    try {
      await writeTextFile(configPath(), text, raw);
      cache = next;
      raw = text;
      setShared("prs.config", Date.now());
      return next;
    } catch {}
  }
  throw new Error("Couldn't save the PR settings; another window kept changing them.");
}

export const machineLabel = (machine) => machine ?? "this computer";
