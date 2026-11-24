import { appHome, exec, hc, home, readTextFile, spaces, terminals } from "herdr";

const UI_LABEL = "coder-devbox.ui";
const PORT_LABEL = "coder-devbox.port";
const CODER_SUFFIX = ".coder";
// `hogli devbox:setup` runs `coder config-ssh` with this prefix, so its hosts are coder.<workspace>[.<agent>].
const CODER_PREFIX = "coder.";
const REGION_SUFFIX = /-eu$/;
const CHECKOUT_PARENTS = ["workspace", "", "code", "src", "dev", "projects", "repos", "git"];
const READINESS_TRIES = 180;

const FORWARD_SCRIPT = `target="$1"; opener="$2"
PYTHONUNBUFFERED=1 bin/hogli devbox:forward "$target" 2>&1 | while IFS= read -r line; do
  printf '%s\\n' "$line"
  case "$line" in
    *"UI at http://localhost:"*)
      port=\${line##*localhost:}; port=\${port%%[!0-9]*}
      (
        tries=0
        until nc -z 127.0.0.1 "$port" 2>/dev/null; do
          kill -0 $$ 2>/dev/null || exit 0
          tries=$((tries + 1))
          if [ "$tries" -ge ${READINESS_TRIES} ]; then echo "localhost:$port never answered."; kill 0; exit 1; fi
          sleep 0.5
        done
        hc label "$HC_TERMINAL_ID" "${PORT_LABEL}=$port" >/dev/null
        "$opener" "http://localhost:$port"
      ) &
      ;;
  esac
done`;

export const isDevbox = (machine) => {
  const target = machine?.target ?? "";
  return target.endsWith(CODER_SUFFIX) || (target.startsWith(CODER_PREFIX) && target.length > CODER_PREFIX.length);
};

export function coderWorkspace(target) {
  if (target.startsWith(CODER_PREFIX)) return { workspace: target.slice(CODER_PREFIX.length).split(".")[0], owner: null };
  const parts = target.slice(0, -CODER_SUFFIX.length).split(".");
  if (parts.length === 1) return { workspace: parts[0], owner: null };
  return { workspace: parts[parts.length - 2], owner: parts[parts.length - 1] };
}

export async function coderUsername() {
  for (const coder of [`${home()}/.hogli/bin/coder`, "coder"]) {
    try {
      const result = await exec(coder, ["whoami", "-o", "json"], { timeout: 15000 });
      const username = JSON.parse(result.stdout)?.[0]?.username;
      if (result.code === 0 && username) return username;
    } catch {}
  }
  return null;
}

export function hogliTarget({ workspace, owner }, me) {
  const who = owner ?? me;
  if (!who) throw new Error("Couldn't ask Coder who you are, so this box can't be targeted.");
  const prefix = `devbox-${who}`;
  // Boxes outside the default region end in a region suffix (devbox-<user>-eu). hogli resolves
  // a label or @user across regions by itself and rejects a label that is a region suffix.
  workspace = workspace.replace(REGION_SUFFIX, "");
  const label = workspace === prefix ? null : workspace.startsWith(`${prefix}-`) ? workspace.slice(prefix.length + 1) : undefined;
  if (label === undefined) throw new Error(`hogli only targets boxes named ${prefix}[-label], not ${workspace}.`);
  if (who === me) return label ?? `@${me}`;
  return label ? `@${who}/${label}` : `@${who}`;
}

const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

export async function loginShell() {
  const result = await exec("sh", ["-c", 'printf %s "$SHELL"']);
  return result.stdout.trim() || "/bin/sh";
}

async function hasHogli(dir) {
  return (await exec("test", ["-x", `${dir}/bin/hogli`])).code === 0;
}

export async function findCheckout() {
  let configured = null;
  try {
    configured = JSON.parse((await readTextFile(`${appHome()}/data/prs-config.json`)) ?? "{}").checkouts?.["PostHog/posthog"] ?? null;
  } catch {}
  const candidates = [
    configured?.replace(/^~(?=\/|$)/, home()),
    ...CHECKOUT_PARENTS.map((parent) => (parent ? `${home()}/${parent}/posthog` : `${home()}/posthog`)),
    ...spaces().filter((s) => !s.machine && s.folder).map((s) => s.folder),
  ].filter(Boolean);
  for (const dir of new Set(candidates)) {
    if (await hasHogli(dir)) return dir;
  }
  return null;
}

// hogli.yaml lists every command under its group, indented. A checkout from before a command
// landed doesn't have it, so the menu leaves that row out instead of failing on a click.
export async function hogliCommands(checkout) {
  try {
    const text = await readTextFile(`${checkout}/hogli.yaml`);
    const names = [...(text ?? "").matchAll(/^\s+([a-z][\w-]*(?::[\w-]+)+):\s*$/gm)].map((m) => m[1]);
    return names.length ? new Set(names) : null;
  } catch {
    return null;
  }
}

export function uiForward(machineName) {
  const forward = terminals().find((t) => t.labels?.[UI_LABEL] === machineName && t.state === "live" && !String(t.address).includes("/"));
  if (!forward) return null;
  const port = Number(forward.labels[PORT_LABEL]);
  return { address: forward.address, port: Number.isInteger(port) && port > 0 ? port : null };
}

export async function collectEndedForward(machineName) {
  const listed = await hc(["ls", "--all", "--json", "--label", `${UI_LABEL}=${machineName}`]);
  let error = null;
  for (const terminal of JSON.parse(listed.stdout || "{}").terminals ?? []) {
    if (terminal.state === "live") continue;
    const screen = (await hc(["read", terminal.address, "--lines", "8"])).stdout;
    error = screen.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "hogli devbox:forward stopped.";
    await hc(["rm", terminal.address]).catch(() => {});
  }
  return error;
}

export async function startUiForward({ machineName, target, checkout, shell, opener }) {
  const started = await hc([
    "run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", checkout,
    "--label", `${UI_LABEL}=${machineName}`,
    "--", shell, "-lic", `exec sh -c ${quote(FORWARD_SCRIPT)} coder-devbox ${quote(target)} ${quote(opener)}`,
  ]);
  if (started.code !== 0) throw new Error(started.stderr.trim() || "Couldn't start hogli.");
}

export async function stopUiForward(address) {
  await hc(["kill", address]).catch(() => {});
  await hc(["rm", address]).catch(() => {});
}

const hogliCommand = (args, target) => ["bin/hogli", ...args, ...(target ? [quote(target)] : [])].join(" ");

export async function runDetached({ args, target, checkout, shell }) {
  const command = hogliCommand(args, target);
  const result = await exec(shell, ["-lic", command], { cwd: checkout, timeout: 60000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n").pop() || `${command} failed`);
}

export function commandInTab({ args, target, shell }) {
  return [shell, "-lic", `${hogliCommand(args, target)}; exec ${quote(shell)} -l`];
}

export const browserOpener = (platform) => (platform === "macos" ? "open" : "xdg-open");

export async function openInBrowser(port, platform) {
  await exec(browserOpener(platform), [`http://localhost:${port}`]);
}
