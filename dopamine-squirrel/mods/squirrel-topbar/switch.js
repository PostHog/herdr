// Moves a Claude pane's conversation to the other subscription in claudeProfiles. Claude is stopped,
// its transcript (and the folder of sub-agent logs and saved tool output beside it) is copied into the
// other account's projects folder, and `claude --resume` runs it there in the same pane's shell.
// `--resume` only finds sessions in its own account's folder, and each copy only grows on the account
// running it, so moving back copies the longer transcript over the older one.
import { hc, exec, home, appHome, readTextFile } from "herdr";

const norm = (d) => (d ?? "~/.claude").replace(/^~/, home()).replace(/\/$/, "");
const quote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const SHELL = /(^|\/)-?(zsh|bash|sh|fish|dash)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function sh(script, ...args) {
  const r = await exec("/bin/sh", ["-c", script, "sh", ...args], { timeout: 120000 });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

async function getTerminal(terminal) {
  const r = await hc(["get", terminal, "--json"]);
  try { return r.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
}

// A shell is left in the pane once Claude quits: the pane is a shell Claude was typed into, or a
// launch script that ends in `exec "$SHELL"` (or Herdr's own wrapper, `exec "$0" -li`).
function keepsShell(argv) {
  if (!argv?.length || !SHELL.test(argv[0])) return false;
  const c = argv.indexOf("-c");
  return c < 0 || /exec "\$(SHELL|0)"/.test(argv[c + 1] ?? "");
}

export function otherProfile(configDir, profiles) {
  const dirs = profiles.map((p) => norm(p.configDir));
  const i = dirs.indexOf(norm(configDir));
  return i < 0 || profiles.length < 2 ? null : profiles[(i + 1) % profiles.length];
}

// Returns null when done, or why it didn't move.
export async function switchAccount(terminal, profiles, cx) {
  if (!terminal || terminal.includes("/")) return "Only Claude panes on this computer can move.";
  let ctx;
  try { ctx = JSON.parse(await readTextFile(`${appHome()}/data/squirrel/context/${terminal}.json`) ?? ""); } catch { return "Couldn't read this pane's Claude session."; }
  const s = ctx.status ?? {};
  const from = norm(ctx.config_dir), target = otherProfile(from, profiles);
  if (!target) return "Couldn't tell which subscription this pane is on.";
  const to = norm(target.configDir);
  if (!UUID.test(s.session_id ?? "") || !s.cwd) return "Couldn't read this pane's Claude session.";

  const t = await getTerminal(terminal);
  if (!t || t.state !== "live") return "This pane isn't running.";
  const status = t.status?.state ?? t.status;
  if (status !== "idle" && status !== "done") return "Claude is busy. Move it once it's finished.";
  if (!keepsShell(t.argv)) return "This pane closes when Claude quits, so it can't move. Reopen it from the clock button first.";

  // The running Claude for this session, and a check that it's this pane's.
  const found = await sh('grep -l "\\"sessionId\\":\\"$2\\"" "$1"/sessions/*.json 2>/dev/null | head -1', from, s.session_id);
  const pid = Number(found.out.split("/").pop()?.replace(/\.json$/, ""));
  if (!pid) return "Couldn't find this pane's Claude.";
  const mine = await sh('p="$1"; for i in 1 2 3 4 5 6; do p=$(ps -o ppid= -p "$p" | tr -d " "); [ "$p" = "$2" ] && exit 0; [ -z "$p" ] || [ "$p" -le 1 ] && exit 1; done; exit 1', String(pid), String(t.pid));
  if (!mine.ok) return "Couldn't match Claude to this pane.";

  const project = s.cwd.replace(/[^A-Za-z0-9]/g, "-");
  const src = `${from}/projects/${project}/${s.session_id}`, dst = `${to}/projects/${project}`;
  const newer = await sh('[ -f "$2/$3.jsonl" ] && [ "$2/$3.jsonl" -nt "$1.jsonl" ]', src, dst, s.session_id);
  if (newer.ok) return `${target.name} has a newer copy of this conversation, so it wasn't replaced.`;

  // SIGTERM is a normal quit: the transcript is already saved message by message.
  const quit = await sh('kill -TERM "$1" && for i in $(seq 1 40); do kill -0 "$1" 2>/dev/null || exit 0; sleep 0.25; done; exit 1', String(pid));
  if (!quit.ok) return "Claude didn't quit.";

  const copy = await sh('mkdir -p "$2" && cp -Rp "$1.jsonl" "$2/" && { [ ! -d "$1" ] || cp -Rp "$1" "$2/"; }', src, dst);
  const env = to === norm("~/.claude") ? "-u CLAUDE_CONFIG_DIR" : `CLAUDE_CONFIG_DIR=${quote(to)}`;
  const flags = [s.model?.id && `--model ${quote(s.model.id)}`, s.effort?.level && `--effort ${quote(s.effort.level)}`].filter(Boolean).join(" ");
  // The copy failing leaves the conversation where it was, so it resumes there instead.
  const resumeEnv = copy.ok ? env : from === norm("~/.claude") ? "-u CLAUDE_CONFIG_DIR" : `CLAUDE_CONFIG_DIR=${quote(from)}`;

  // Wait for the pane's shell to be back in front before typing into it.
  for (let i = 0; i < 40; i++) {
    const now = await getTerminal(terminal);
    if (now?.foreground?.pid && now.foreground.pid !== pid && SHELL.test(now.foreground.argv?.[0] ?? "")) break;
    await cx.sleep(250);
  }
  // The shell may have picked up an API key from the folder (direnv); without it Claude uses the subscription.
  const sent = await hc(["send", terminal, `cd ${quote(s.cwd)} && env -u ANTHROPIC_API_KEY ${resumeEnv} claude --resume ${s.session_id} ${flags}`.trim()]);
  if (!copy.ok) return `Couldn't copy the conversation to ${target.name} (${copy.err || "cp failed"}), so it reopened where it was.`;
  if (sent.code !== 0) return `Copied to ${target.name}, but couldn't start Claude in the pane. Run: claude --resume ${s.session_id}`;
  return null;
}
