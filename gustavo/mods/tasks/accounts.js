// Claude accounts: one Claude Code login per folder. "main" is ~/.claude, as Claude Code keeps it;
// each other account is ~/.claude-accounts/<name>, run with CLAUDE_CONFIG_DIR pointing there, so
// it has a login (and .claude.json) of its own. Everything else in it (settings, CLAUDE.md,
// skills, hooks, plugins, memory and conversations) links back to ~/.claude, so a session moves
// between accounts with `claude --resume` and finds the same conversation.

import { exec, home, readTextFile, writeTextFile, shared } from "herdr";

export const MAIN = "main";
export const ACCOUNT = "tasks.account"; // the account new Claude sessions start as (a name)
export const ACCOUNTS = "tasks.accounts"; // [{ name, dir, email, org, plan }]
export const SESSION_ACCOUNTS = "tasks.sessionAccounts"; // { terminal address: account name }
export const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export const accountsDir = () => `${home()}/.claude-accounts`;
export const launcher = () => `${accountsDir()}/claude-as`;
export const dirOf = (name) => (name === MAIN ? `${home()}/.claude` : `${accountsDir()}/${name}`);
export const defaultAccount = () => {
  const name = shared(ACCOUNT);
  return name && (shared(ACCOUNTS) ?? []).some((a) => a.name === name) ? name : MAIN;
};

// The argv that starts Claude as an account; main is plain `claude`, as before accounts.
export function claudeArgv(name = defaultAccount(), extra = []) {
  return !name || name === MAIN ? ["claude", ...extra] : [launcher(), name, ...extra];
}

// What links back to ~/.claude, when it exists there: all but the login and .claude.json.
const LINKED = ["settings.json", "settings.local.json", "CLAUDE.md", "agents", "skills", "commands", "plugins", "hooks",
  "projects", "sessions", "plans", "keybindings.json", "output-styles", "history.jsonl", "file-history", "bin"];

const LAUNCHER = `#!/bin/sh
# claude-as <account> [claude args...]: Claude Code logged in as that account (Herdr's tasks mod).
# main is ~/.claude; any other is ~/.claude-accounts/<account>.
account="$1"
shift
if [ "$account" = "main" ]; then
  unset CLAUDE_CONFIG_DIR
else
  export CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/$account"
fi
exec claude "$@"
`;

async function sh(script, args = []) {
  const r = await exec("/bin/sh", ["-c", script, "sh", ...args]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
  return r.stdout;
}

export async function ensureLauncher() {
  await sh('mkdir -p "$1"', [accountsDir()]);
  const now = await readTextFile(launcher()).catch(() => null);
  if (now !== LAUNCHER) await writeTextFile(launcher(), LAUNCHER);
  await sh('chmod +x "$1"', [launcher()]);
}

// Who each account is logged in as, from its .claude.json (main's is ~/.claude.json).
export async function readAccounts() {
  const names = (await sh('ls -1 "$1" 2>/dev/null || true', [accountsDir()])).split("\n")
    .filter((n) => NAME.test(n) && n !== MAIN);
  const out = [];
  for (const name of [MAIN, ...names]) {
    const file = name === MAIN ? `${home()}/.claude.json` : `${dirOf(name)}/.claude.json`;
    const text = await readTextFile(file).catch(() => null);
    if (name !== MAIN && text === null) continue; // not an account folder
    let a = null;
    try { a = JSON.parse(text ?? "{}").oauthAccount ?? null; } catch { /* half-written: shown as not logged in */ }
    out.push({ name, dir: dirOf(name), email: a?.emailAddress ?? null, org: a?.organizationName ?? null, plan: a?.billingType ?? null });
  }
  return out;
}

// A new account's folder: the links back to ~/.claude, and a .claude.json with main's MCP servers
// and folder trust, so it only asks to log in. Its login happens in Claude (it asks on start).
export async function createAccount(name) {
  if (!NAME.test(name) || name === MAIN) throw new Error("Use lowercase letters, digits and dashes (up to 24), not “main”.");
  const dir = dirOf(name);
  const exists = await sh('[ -e "$1" ] && echo yes || true', [dir]);
  if (exists.trim()) throw new Error(`${dir.replace(home(), "~")} already exists.`);
  await ensureLauncher();
  await sh('mkdir -p "$1"', [dir]);
  for (const item of LINKED) {
    await sh('[ -e "$1/$3" ] && ln -s "$1/$3" "$2/$3" || true', [`${home()}/.claude`, dir, item]);
  }
  let main = {};
  try { main = JSON.parse(await readTextFile(`${home()}/.claude.json`)); } catch { /* none yet */ }
  const seed = { mcpServers: main.mcpServers ?? {}, projects: main.projects ?? {} };
  await writeTextFile(`${dir}/.claude.json`, JSON.stringify(seed, null, 2));
}

// Which account each running Claude session uses: CLAUDE_CONFIG_DIR in its process's environment
// (ps shows it for your own processes), main when it has none.
export async function sessionAccount(pid) {
  const r = await exec("ps", ["eww", "-o", "command=", "-p", String(pid)]).catch(() => null);
  const m = (r?.stdout ?? "").match(/(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/);
  if (!m) return MAIN;
  const dir = m[1].replace(/\/+$/, "");
  if (dir === `${home()}/.claude`) return MAIN;
  return dir.startsWith(`${accountsDir()}/`) ? dir.slice(accountsDir().length + 1) : dir.split("/").pop();
}
