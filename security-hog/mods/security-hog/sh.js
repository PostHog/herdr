// SecurityHog through shmcp.py (an MCP client beside this file), and the mod's config.

import { exec, appHome, home, readTextFile, shared, setShared } from "herdr";

export const CONFIG_PATH = "~/.config/security-hog/config.json";
export const expand = (path) => (path?.startsWith("~/") ? home() + path.slice(1) : path);
const script = () => `${appHome()}/mods/security-hog/shmcp.py`;

async function shmcp(args, timeout) {
  let r;
  try {
    r = await exec("python3", [script(), ...args], { timeout });
  } catch (e) {
    throw Object.assign(new Error(String(e?.message ?? e)), { code: "exec" });
  }
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw Object.assign(new Error((r.stderr || r.stdout || "No answer from shmcp.py").trim().slice(0, 300)), { code: "protocol" });
  }
  if (r.code !== 0) throw Object.assign(new Error(out?.error ?? "The SecurityHog call failed"), { code: out?.code, status: out?.status });
  return out;
}

// Calls one SecurityHog MCP tool. Throws an Error with `code` ("login",
// "network", "tool", ...) and the server's own words.
export async function sh(tool, args = {}, timeout = 120000) {
  try {
    return await shmcp(["call", tool, JSON.stringify(args)], timeout);
  } catch (e) {
    if (e.code === "login" && shared("security-hog.signin")?.state !== "waiting") setShared("security-hog.signin", { state: "out" });
    throw e;
  }
}

// The browser sign-in, once for every copy of the mod. Copies watch
// "security-hog.signin": its `at` changes when a sign-in lands.
export async function signIn() {
  if (shared("security-hog.signin")?.state === "waiting") return;
  setShared("security-hog.signin", { state: "waiting" });
  try {
    const r = await shmcp(["login"], 320000);
    setShared("security-hog.signin", { state: "in", at: Date.now(), expires_at: r.expires_at });
  } catch (e) {
    setShared("security-hog.signin", { state: "out", error: e.message });
  }
}

export async function signOut() {
  try {
    await shmcp(["logout"], 15000);
  } catch {}
  setShared("security-hog.signin", { state: "out" });
}

export async function loadConfig() {
  let c = {};
  try {
    c = JSON.parse((await readTextFile(expand(CONFIG_PATH))) ?? "{}");
  } catch {}
  return { team: c.team ?? null, email: c.email ?? null, repos: c.repos ?? {}, agent: c.agent ?? "claude" };
}

// Your SecurityHog email: the config's, else git's global one.
export async function myEmail(config) {
  if (config.email) return config.email.toLowerCase();
  try {
    const r = await exec("git", ["config", "--global", "user.email"]);
    return r.stdout.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

// The local checkout for "owner/name": the config's, else one picked before.
export function checkoutOf(config, slug) {
  if (!slug) return null;
  const all = { ...(shared("security-hog.repos") ?? {}), ...(config.repos ?? {}) };
  const hit = Object.entries(all).find(([k]) => k.toLowerCase() === slug.toLowerCase());
  return hit ? expand(hit[1]) : null;
}

export function rememberCheckout(slug, path) {
  setShared("security-hog.repos", { ...(shared("security-hog.repos") ?? {}), [slug]: path });
}
