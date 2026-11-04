import { runOn, launchShell } from "./runner.js";
import { config } from "./config.js";

const keeperMachine = () => config().prKeeper?.machine || null;
const keeperDir = () => config().prKeeper?.dir || "~/pr-keeper";
const onDevbox = (script, args = []) => runOn(keeperMachine(), `KEEPER_DIR="${keeperDir().replace(/^~/, "$HOME")}"; ${script}`, args);

const NODE_PRELUDE = '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1;';

const STATUS_SCRIPT = `systemctl --user show pr-keeper -p ActiveState -p SubState -p ActiveEnterTimestamp -p NRestarts -p MainPID -p ExecStart -p UnitFileState --no-pager
echo "Heartbeat=$(cat "$HOME/.local/state/pr-keeper/heartbeat" 2>/dev/null)"
echo "PollInterval=$(sed -n 's/^poll_interval:[[:space:]]*//p' "$HOME/.config/pr-keeper/config.yml" 2>/dev/null | head -n 1)"
echo "Branch=$(git -C "$KEEPER_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "Commit=$(git -C "$KEEPER_DIR" log -1 --format='%h %s' 2>/dev/null)"
echo "Dirty=$(git -C "$KEEPER_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
echo "---LOG---"
tail -n 80 "$HOME/.local/state/pr-keeper/pr-keeper.log" 2>/dev/null`;

const LEVELS = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
const SKIP_KEYS = new Set(["level", "time", "pid", "hostname", "msg", "v"]);

function durationMs(text) {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(text ?? "").trim());
  if (!match) return 180000;
  const value = Number(match[1]);
  return value * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? "s"];
}

function parseLog(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      const extra = Object.entries(value)
        .filter(([key]) => !SKIP_KEYS.has(key))
        .map(([key, item]) => `${key}=${typeof item === "object" ? JSON.stringify(item) : item}`)
        .join(" ");
      entries.push({ time: value.time, level: LEVELS[value.level] ?? String(value.level), msg: value.msg ?? "", extra });
    } catch {}
  }
  return entries.reverse();
}

export async function fetchKeeperStatus() {
  const result = await onDevbox(STATUS_SCRIPT);
  const [head, log = ""] = result.stdout.split("---LOG---\n");
  const fields = {};
  for (const line of head.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  const pollMs = durationMs(fields.PollInterval);
  const heartbeatAt = fields.Heartbeat?.trim() || null;
  const sinceHeartbeat = heartbeatAt ? Date.now() - Date.parse(heartbeatAt) : null;
  const active = fields.ActiveState === "active";
  return {
    installed: fields.UnitFileState !== undefined && fields.UnitFileState !== "",
    active,
    state: `${fields.ActiveState ?? "unknown"}${fields.SubState ? ` (${fields.SubState})` : ""}`,
    since: fields.ActiveEnterTimestamp || null,
    restarts: Number(fields.NRestarts ?? 0),
    pid: fields.MainPID && fields.MainPID !== "0" ? fields.MainPID : null,
    enabled: fields.UnitFileState === "enabled",
    dryRun: /argv\[\]=[^;]*--dry-run/.test(fields.ExecStart ?? ""),
    pollInterval: fields.PollInterval || "?",
    heartbeatAt,
    stale: active && (sinceHeartbeat === null || sinceHeartbeat > 2 * pollMs),
    branch: fields.Branch || "?",
    commit: fields.Commit || "?",
    dirty: Number(fields.Dirty ?? 0),
    log: parseLog(log.split("\n")),
  };
}

export async function systemctl(verb) {
  const result = await onDevbox(`systemctl --user ${verb} pr-keeper 2>&1`);
  return { ok: result.code === 0, message: result.code === 0 ? `PR Keeper ${verb === "stop" ? "stopped" : verb === "start" ? "started" : "restarted"}.` : result.stdout.trim() || `systemctl exited ${result.code}` };
}

export async function pollNow() {
  const result = await onDevbox(`${NODE_PRELUDE} cd "$KEEPER_DIR" && node dist/src/cli.js tick --no-wait 2>&1`);
  return { ok: result.code === 0, message: result.stdout.trim().split("\n").pop() || `exit ${result.code}` };
}

export function openLiveLog() {
  launchShell("pr-keeper log", "journalctl --user -u pr-keeper -f -n 200 -o cat", keeperMachine());
  return { ok: true, quiet: true };
}

export function switchMode(live) {
  launchShell(
    `pr-keeper ${live ? "live" : "dry run"}`,
    `KEEPER_DIR="${keeperDir().replace(/^~/, "$HOME")}"; ${NODE_PRELUDE} cd "$KEEPER_DIR" && deploy/devbox-setup.sh ${live ? "--live" : ""}; echo; echo "Finished. Close this tab when you've read the output."; exec bash`,
    keeperMachine(),
  );
  return { ok: true, message: `Running the setup script ${live ? "with --live" : "in dry-run mode"} in a new tab.` };
}
