// Reads your PostHog devboxes into shared "squirrel.devboxes" for the panel's Devboxes tab:
// the boxes from the Coder CLI and which local folder is synced to each from mutagen.
// Both binaries are the ones `hogli devbox:setup` installs in ~/.hogli/bin.
import { exec, home, shared, setShared, checking, notify } from "herdr";

export const DEVBOXES = "squirrel.devboxes";
export const DEVBOXES_EVERY_MS = 60 * 1000;
// The panel names the box here, then runs squirrel-topbar.devbox_stop or devbox_start.
export const BOX_TARGET = "squirrel.devbox-target";
// { [box name]: { verb, since } while hogli runs, or { error } after it failed }
export const BOX_ACTIONS = "squirrel.devbox-actions";
const FLOX = "/usr/local/bin/flox";
const ACTION_LIMIT_MS = 15 * 60 * 1000;

const SYNC_LIST = 'MUTAGEN_SSH_PATH="$HOME/.hogli/mutagen-ssh-shim" "$HOME/.hogli/bin/mutagen" sync list --template "{{json .}}"';

const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

function boxOf(w, syncs) {
  const build = w.latest_build ?? {};
  const resources = build.resources ?? [];
  const agent = resources.flatMap((r) => r.agents ?? [])[0] ?? null;
  const facts = Object.fromEntries(resources.flatMap((r) => r.metadata ?? []).map((m) => [m.key, m.value]));
  const sync = syncs.find((s) => s.name === `ph-${w.name}`) ?? null;
  const prefix = `devbox-${w.owner_name}-`;
  return {
    name: w.name,
    // What `hogli devbox:* -n` takes; null is your default box.
    label: w.name.startsWith(prefix) ? w.name.slice(prefix.length) : null,
    status: build.status ?? "unknown",
    type: facts["instance type"] ?? null,
    region: facts.region ?? null,
    stopsAt: build.status === "running" && build.deadline ? Date.parse(build.deadline) : null,
    app: (agent?.apps ?? []).find((a) => a.slug === "app")?.health ?? null,
    sync: sync && {
      from: sync.alpha?.path ?? null,
      state: sync.paused ? "paused" : sync.status || "running",
      conflicts: (sync.conflicts ?? []).length,
      error: sync.lastError ?? null,
    },
  };
}

export async function fetchDevboxes() {
  if (checking()) return;
  const prev = shared(DEVBOXES) ?? {};
  setShared(DEVBOXES, { ...prev, loading: true });
  const coder = await exec(`${home()}/.hogli/bin/coder`, ["list", "--output", "json"], { timeout: 30000 })
    .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  if (coder.code !== 0) {
    const missing = /no such file|not found|ENOENT/i.test(coder.stderr ?? "");
    setShared(DEVBOXES, { ...prev, loading: false, error: missing ? "Devboxes aren't set up here. Run hogli devbox:setup." : (coder.stderr ?? "").trim().split("\n").at(-1) || "coder list failed" });
    return;
  }
  const list = await exec("/bin/sh", ["-c", SYNC_LIST], { timeout: 15000 }).catch(() => null);
  const syncs = list?.code === 0 ? parse(list.stdout, []) ?? [] : [];
  const boxes = (parse(coder.stdout, []) ?? []).map((w) => boxOf(w, syncs)).sort((a, b) => a.name.localeCompare(b.name));
  setShared(DEVBOXES, { boxes, at: Date.now(), loading: false, error: null });
}

const setAction = (name, value) => {
  const next = { ...(shared(BOX_ACTIONS) ?? {}) };
  if (value) next[name] = value; else delete next[name];
  setShared(BOX_ACTIONS, next);
};

// Stop or start through hogli, so the mirror pauses and resumes with the box. While it runs the
// boxes are re-read every 10 seconds, so the row follows Coder's own status; a toast reports the end.
export async function devboxAction(verb) {
  const boxes = (shared(DEVBOXES) ?? {}).boxes ?? [];
  const box = boxes.find((b) => b.name === shared(BOX_TARGET)) ?? boxes.find((b) => !b.label);
  if (!box || (shared(BOX_ACTIONS) ?? {})[box.name]?.verb) return;
  setAction(box.name, { verb, since: Date.now() });
  let running = true;
  (async () => {
    while (running) {
      await exec("/bin/sleep", ["10"]).catch(() => null);
      if (running) await fetchDevboxes().catch(() => null);
    }
  })();
  const command = `hogli devbox:${verb}${box.label ? ` -n ${box.label}` : ""}`;
  const checkout = ((shared("squirrel.settings") ?? {}).posthogCheckout ?? "~/code/posthog").replace(/^~/, home());
  const r = await exec(FLOX, ["activate", "--", "bash", "-c", command], { cwd: checkout, timeout: ACTION_LIMIT_MS })
    .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  running = false;
  const error = r.code === 0 ? null : `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").at(-1) || `${command} failed`;
  setAction(box.name, error ? { error } : null);
  notify(error
    ? { title: `Couldn't ${verb} ${box.name}`, body: error, level: "error" }
    : { title: `${box.name} ${verb === "stop" ? "stopped" : "is running"}`, level: "success" });
  await fetchDevboxes().catch(() => null);
}
