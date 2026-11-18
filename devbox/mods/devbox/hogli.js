import { appHome, exec, hc, home, readTextFile, spaces, terminals } from "herdr";

const UI_LABEL = "devbox.ui";
const PORT_LABEL = "devbox.port";
const FORWARD_START_TIMEOUT_MS = 90000;
const CHECKOUT_PARENTS = ["workspace", "", "code", "src", "dev", "projects", "repos", "git"];

export const isDevbox = (machine) => Boolean(machine?.target?.endsWith(".coder"));
export const boxName = (machine) => machine.target.slice(0, -".coder".length);

export function hogliTarget(box) {
  const [, user, ...label] = box.split("-");
  return label.length ? label.join("-") : `@${user}`;
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

export function uiForward(machineName) {
  const forward = terminals().find((t) => t.labels?.[UI_LABEL] === machineName && t.state === "live" && !String(t.address).includes("/"));
  if (!forward) return null;
  const port = Number(forward.labels[PORT_LABEL]);
  return { address: forward.address, port: Number.isInteger(port) && port > 0 ? port : null };
}

async function localPortAnswers(port) {
  return (await exec("nc", ["-z", "127.0.0.1", String(port)], { timeout: 3000 }).catch(() => ({ code: 1 }))).code === 0;
}

export async function startUiForward({ machineName, box, checkout, shell, cx }) {
  const started = await hc([
    "run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", checkout,
    "--label", `${UI_LABEL}=${machineName}`,
    "--", shell, "-lic", `exec bin/hogli devbox:forward ${quote(hogliTarget(box))}`,
  ]);
  if (started.code !== 0) throw new Error(started.stderr.trim() || "Couldn't start hogli.");
  const { address } = JSON.parse(started.stdout);

  const deadline = Date.now() + FORWARD_START_TIMEOUT_MS;
  let port = null;
  while (Date.now() < deadline) {
    const screen = (await hc(["read", address, "--lines", "60"])).stdout;
    port ??= Number(screen.match(/http:\/\/localhost:(\d+)/)?.[1]) || null;
    const state = JSON.parse((await hc(["get", address, "--json"])).stdout).state;
    if (state !== "live") {
      await hc(["rm", address]).catch(() => {});
      const lastLine = screen.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      throw new Error(lastLine || "hogli devbox:forward stopped.");
    }
    if (port !== null) {
      await hc(["label", address, `${PORT_LABEL}=${port}`]);
      if (await localPortAnswers(port)) return port;
    }
    await cx.sleep(700);
  }
  await stopUiForward(address);
  throw new Error("hogli devbox:forward didn't start within 90 seconds.");
}

export async function stopUiForward(address) {
  await hc(["kill", address]).catch(() => {});
  await hc(["rm", address]).catch(() => {});
}

const hogliCommand = (args, box, targeted) => ["bin/hogli", ...args, ...(targeted ? [quote(hogliTarget(box))] : [])].join(" ");

export async function runDetached({ args, box, checkout, shell, targeted = true }) {
  const command = hogliCommand(args, box, targeted);
  const result = await exec(shell, ["-lic", command], { cwd: checkout, timeout: 60000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n").pop() || `${command} failed`);
}

export function commandInTab({ args, box, shell, targeted = true }) {
  return [shell, "-lic", `${hogliCommand(args, box, targeted)}; exec ${quote(shell)} -l`];
}

export async function openInBrowser(port, platform) {
  await exec(platform === "macos" ? "open" : "xdg-open", [`http://localhost:${port}`]);
}
