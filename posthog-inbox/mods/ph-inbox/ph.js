// PostHog, through phmcp.py (an MCP client beside this file) and the mod's config.

import { exec, appHome, home, readTextFile } from "herdr";

export const CONFIG_PATH = "~/.config/posthog-inbox/config.json";
// PostHog's new-key form, filled in with the MCP Server preset (it includes the inbox and task scopes).
export const KEY_URLS = {
  US: "https://us.posthog.com/settings/user-api-keys?preset=mcp_server",
  EU: "https://eu.posthog.com/settings/user-api-keys?preset=mcp_server",
};
export const expand = (path) => (path?.startsWith("~/") ? home() + path.slice(1) : path);

// Calls one PostHog MCP tool. Throws an Error with `code` ("no_key",
// "unauthorized", "network", "tool", ...) and the server's own words.
export async function ph(tool, args = {}, timeout = 120000) {
  let r;
  try {
    r = await exec("python3", [`${appHome()}/mods/ph-inbox/phmcp.py`, "call", tool, JSON.stringify(args)], { timeout });
  } catch (e) {
    throw Object.assign(new Error(String(e?.message ?? e)), { code: "exec" });
  }
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw Object.assign(new Error((r.stderr || r.stdout || "No answer from phmcp.py").trim().slice(0, 300)), { code: "protocol" });
  }
  if (r.code !== 0) throw Object.assign(new Error(out?.error ?? "The PostHog call failed"), { code: out?.code, status: out?.status });
  return out;
}

// The config without its key: the key stays with phmcp.py.
export async function loadConfig() {
  let c = {};
  try {
    c = JSON.parse((await readTextFile(expand(CONFIG_PATH))) ?? "{}");
  } catch {}
  return { default_repo: c.default_repo ?? null, repos: c.repos ?? {}, agent: c.agent ?? "claude" };
}

// The local checkout for "owner/name" (GitHub slugs compare without case).
export function checkoutOf(config, slug) {
  if (!slug) return null;
  const hit = Object.entries(config.repos ?? {}).find(([k]) => k.toLowerCase() === slug.toLowerCase());
  return hit ? expand(hit[1]) : null;
}
