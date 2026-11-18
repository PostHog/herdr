// hogli: run PostHog's dev stack (`hogli start`, the phrocs TUI) from a sidebar on the right.
// Pick the machine at the top (this Mac, or one of your running devboxes), then the worktree (each
// shows its task). Every machine has its own shell named "hogli" that stays open, and its own
// stack: they don't share ports, so switching the panel between machines never stops anything.
// One stack per machine. Stacks are seen as their phrocs processes, so one started elsewhere
// shows too. A devbox's PostHog (its port 8010) is forwarded to a free port here while its stack
// runs. This Mac's stack is shared as "hogli.running", which the tasks panel marks with an icon.
//
// The layout is never rewritten from here: a rewrite folds single-child columns (the Files panel's,
// this one's) into their child, losing ids, sizes and hidden flags, and overrides show/hide clicks.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, terminals, spaces, machines, shared, setShared, run, theme, layout, nextCommand, props, openOverlay, closeOverlay, readTextFile, notify } from "herdr";

const NAME = "hogli"; // the shell the stack runs in (hc names are unique among live terminals)
const COLUMN = "hogli"; // the layout column this panel sits in
const TERM = "hogli-term"; // its block showing the shell, { terminal: "hogli" }
const CONTROLS = "hogli-controls"; // this panel's block
const HEAD_PX = 36; // the header row
const RAIL_PX = 44;
const WIDE_PX = 480;
const SCAN_MS = 3000;
const STOP_WAIT_MS = 8000; // after Ctrl-C, how long phrocs gets before it's sent SIGTERM
const START_WAIT_MS = 30000; // after this, a start without its phrocs fails once hogli has exited
const START_GIVE_UP_MS = 15 * 60000; // and fails anyway after this
const SHELLS = /(^|\/)-?(ba|z|fi|da|k)?sh$/; // a shell's process name: hogli is no longer the shell's foreground
const ICON = (name) => `mods/hogli/icons/${name}.svg`;
const WT_ROW = 40; // a worktree row in the picker: branch and path
const repo = () => `${home()}/dev/posthog/posthog`;
const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null));
const short = (path) => path.replace(home(), "~");
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const LINKS = "hogli.links"; // shared: { [worktree path]: spaceId }, the task a worktree was started for
const WINDOW = "hogli.window"; // shared: the Full view window's overlay id while it's open
const RUNNING = "hogli.running"; // shared: { path, branch, space, external } of this Mac's stack, or null
const PHROCS = /^(.+)\/tools\/phrocs\/dist\/phrocs\b/; // a stack's process (its command line), wherever it was started
const LOCAL = "local"; // this Mac's key among the machines; a devbox's is its Herdr machine name
const CODER = () => `${home()}/.hogli/bin/coder`;
// How Herdr reaches a devbox: Coder's ssh (as ~/.ssh/config's "coder.*") with --disable-autostart,
// given as options so ~/.ssh/config stays as hogli made it. Herdr reconnects its machines on its
// own, and a plain `ssh coder.<ws>` starts a devbox that was stopped (by Archive, or Coder's
// schedule). Machines added before point at "coder.<workspace>".
const DEVBOX_SSH_OPTS = () => ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR", "-o", `ProxyCommand=${CODER()} ssh --stdio --disable-autostart --ssh-host-prefix coder. %h`];
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const devboxVia = (ws) => `ssh ${DEVBOX_SSH_OPTS().map(shq).join(" ")} coder.${ws}`;
const addDevboxArgs = (ws, name) => ["machine", "add", "--via", devboxVia(ws), "--name", name, "--install", "--json"];
const reachesDevbox = (target, ws) => target === `coder.${ws}` || String(target ?? "").endsWith(` coder.${ws}`);
const DEVBOXES_MS = 30000; // how often `coder list` is asked which devboxes run
const OTHERS_SCAN_MS = 15000; // machines not shown are scanned this often, for their dots
const DEVBOX_UI_PORT = 8010; // PostHog on a devbox (its proxy), forwarded here
// Ports here for devboxes' PostHog: never 8010, which this Mac's own stack needs.
const FORWARD_PORTS = [8011, 8012, 8013, 8014, 8015, 8016, 8017, 8018, 8019, 8020];
const FORWARD = /\bport-forward (\S+) --tcp=(\d+):8010\b/;
// A terminal's machine: "devbox-x/t3" is on devbox-x, "t3" here.
const machineOf = (address) => (String(address ?? "").includes("/") ? String(address).split("/")[0] : null);
// phrocs' socket name for a folder: the first 8 hex of sha256(its real absolute path).
const SOCKET_HASH = "import hashlib, os, sys; print(hashlib.sha256(os.path.abspath(os.path.realpath(sys.argv[1])).encode()).hexdigest()[:8])";
const POLL_MS = 2000; // services and the selected one's logs, read over phrocs' socket
const LOG_LINES = 300;
// One request over phrocs' socket: send a JSON line, read the JSON line back.
const SOCKET_CLIENT = [
  "import socket, sys",
  "s = socket.socket(socket.AF_UNIX)",
  "s.settimeout(float(sys.argv[3]) if len(sys.argv) > 3 else 3)",
  "s.connect(sys.argv[1])",
  "s.sendall(sys.argv[2].encode() + b'\\n')",
  "buf = b''",
  "while not buf.endswith(b'\\n'):",
  "    chunk = s.recv(1 << 16)",
  "    if not chunk: break",
  "    buf += chunk",
  "sys.stdout.write(buf.decode('utf-8', 'replace'))",
].join("\n");
const MONO = "JetBrains Mono";
// Log rows are wrapped here, at the width of a monospace character, so every row has the same
// height and the view can scroll by rows itself: it draws the rows that fit, counted back from
// the end by logOffset. (GPUI's lists here grew to their content inside this panel and never
// scrolled, so scroll_to_bottom did nothing.)
const LOG_FONT_PX = 10.5;
const LOG_CHAR_PX = LOG_FONT_PX * 0.6; // JetBrains Mono's advance is 600/1000 of its size
const LOG_ROW_PX = 16;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\r/g, "");

// phrocs' own config for a worktree: each service's group (the "layer" dimension the phrocs
// sidebar groups by) and the groups' order. A small reader, not YAML: only these two keys.
function parseGroups(text) {
  const groupOf = {}, order = [];
  let section = null, proc = null, inGroups = false, dim = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) { section = line.replace(/:.*$/, ""); proc = null; inGroups = false; dim = null; continue; }
    if (section === "procs") {
      let m = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
      if (m) { proc = m[1]; inGroups = false; continue; }
      if (/^    groups:\s*$/.test(line)) { inGroups = true; continue; }
      if (/^    \S/.test(line)) inGroups = false;
      m = inGroups && line.match(/^      layer:\s*(.+?)\s*$/);
      if (m && proc) groupOf[proc] = m[1].replace(/^['"]|['"]$/g, "");
    } else if (section === "group_order") {
      const m = line.match(/^  ([A-Za-z0-9_]+):\s*$/);
      if (m) { dim = m[1]; continue; }
      const item = line.match(/^  - (.+?)\s*$/);
      if (item && dim === "layer") order.push(item[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  return { groupOf, order };
}

// The repo's own list of services (bin/mprocs.yaml, 4-space indented): every unit hogli knows,
// with its layer, so the ones this stack left out can still be added.
function parseUnits(text) {
  const out = [];
  let inProcs = false, cur = null, inGroups = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) { inProcs = /^procs:/.test(line); cur = null; continue; }
    if (!inProcs) continue;
    let m = line.match(/^    ([A-Za-z0-9_.-]+):\s*$/);
    if (m) { cur = { name: m[1], layer: "Other" }; out.push(cur); inGroups = false; continue; }
    if (/^        groups:\s*$/.test(line)) { inGroups = true; continue; }
    if (/^        \S/.test(line)) inGroups = false;
    m = inGroups && cur && line.match(/^            layer:\s*(.+?)\s*$/);
    if (m) cur.layer = m[1].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

// The command hogli would give a unit in this stack (sandbox wrapper and all): a copy of the
// stack's config with the unit in include_units, regenerated aside in one scratch file that each
// run overwrites. The stack's own config and your saved hogli setup stay as they are.
const UNIT_SHELL = `set -e
cd "$1"
T="\${TMPDIR:-/tmp}/herdr-hogli-unit.yaml"
cp .posthog/.generated/mprocs.yaml "$T"
PY="$(. bin/helpers/worktree-borrow.sh && posthog_find_venv "$PWD")/bin/python"
"$PY" - "$T" "$2" <<'EOF'
import sys, yaml
path, unit = sys.argv[1], sys.argv[2]
d = yaml.safe_load(open(path))
inc = d.setdefault("_posthog", {}).setdefault("include_units", [])
if unit not in inc:
    inc.append(unit)
yaml.safe_dump(d, open(path, "w"), sort_keys=False)
EOF
HOGLI_MPROCS_PATH="$T" bin/hogli dev:generate >/dev/null
"$PY" -c 'import sys, yaml; print(yaml.safe_load(open(sys.argv[1]))["procs"][sys.argv[2]]["shell"])' "$T" "$2"`;

function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

// `git worktree list --porcelain`: blocks of "worktree <path>", "branch refs/heads/<b>", "locked"...
function parseWorktrees(text) {
  return text.split("\n\n").map((block) => {
    const line = (k) => block.split("\n").find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
    const path = line("worktree");
    return path && { path, branch: (line("branch") ?? "").replace("refs/heads/", "") || "(detached)" };
  }).filter(Boolean);
}

export default class Hogli extends View {
  init(_props, cx) {
    // One mod, three parts: the controls; "idle", a block that's always hidden, there only so the
    // column never has a single child (see the top of this file); "bar", Full view's title bar.
    this.part = props()?.part ?? "controls";
    if (this.part === "idle" || this.part === "bar") return;
    // Each machine's own state ("box"): this Mac's always, a devbox's once it's seen running.
    this.boxes = { [LOCAL]: this.newBox(LOCAL, { label: "This Mac" }) };
    this.devboxes = []; // [{ ws, label, machine }]: your running devboxes, from `coder list`
    this.forwards = {}; // { [workspace]: { pid, port } }: `coder port-forward`s running here
    this.cur = localStorage.getItem("machine") || LOCAL;
    this.open = false; // the worktree list
    this.width = WIDE_PX;
    this.height = 600;
    this.logBoxH = 400;
    this.follow = true; // keep the log view at its end
    this.logOffset = 0; // rows between the view's bottom and the end of the logs
    this.ticks = 0;
    // This panel draws the services itself; phrocs' own TUI is a click away (Full view).
    run("layout.hide", { id: TERM });
    run("layout.resize", { id: CONTROLS, weight: 1 }); // an earlier fold shrank the block to its header
    const local = this.boxes[LOCAL];
    this.ensureShell(local, cx);
    this.loadWorktrees(local, cx);
    this.scan(local, cx);
    this.loadDevboxes(cx);
    cx.timer.every(60000, (cx) => this.loadWorktrees(this.box(), cx));
    cx.timer.every(SCAN_MS, (cx) => {
      // The shown machine every few seconds, the others now and then (for their dots), and this
      // Mac always (the tasks panel follows its stack).
      this.ticks += 1;
      const every = Math.round(OTHERS_SCAN_MS / SCAN_MS);
      for (const b of this.listed()) if (b === this.box() || b.key === LOCAL || this.ticks % every === 0) this.scan(b, cx);
    });
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    cx.timer.every(DEVBOXES_MS, (cx) => this.loadDevboxes(cx));
    // hogli.start and hogli.stop (the shown machine's stack, in its picked worktree), hogli.window,
    // hogli.next-machine (keys.json or `herdr-app do`).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "stop") this.stop(this.box(), cx);
        else if (c === "start" && !this.running(this.box()) && this.ready(this.box())) this.start(this.box(), this.current(this.box()), cx);
        else if (c === "next-machine") {
          const all = this.listed();
          this.pick(all[(all.indexOf(this.box()) + 1) % all.length], cx);
        }
        else if (c === "window") shared(WINDOW) ? this.closeWindow() : this.openWindow(this.box());
        cx.notify();
      }
    });
  }

  newBox(key, { machine = null, ws = null, label }) {
    // This Mac keeps the keys it had before there were machines.
    const saved = (name) => localStorage.getItem(`${name}:${key}`) ?? (key === LOCAL ? localStorage.getItem(name) : null);
    return {
      key, machine, ws, label,
      home: machine ? null : home(),
      repo: machine ? null : repo(),
      worktrees: machine ? [] : [{ path: repo(), branch: "master" }],
      selected: saved("selected"),
      stacks: [], // [{ pid, path, ours }]: phrocs processes there, ours when under its hogli shell
      sockets: {}, // worktree path -> its phrocs socket
      // The stack that runs, from its socket. Names and logs answer at once; statuses can be slow
      // (phrocs samples each process's metrics for them, seconds each on a busy machine), so they
      // come in the background and the last ones known stay meanwhile.
      procs: null, // { path, names: [], status: { name: snapshot } }
      statusBusy: false,
      groups: { path: null, groupOf: {}, order: [] },
      units: [], // every unit in the repo's bin/mprocs.yaml: [{ name, layer }]
      adding: {}, // unit -> true while it's being added to the stack
      sel: saved("proc") || "backend", // the service whose logs show
      logs: [],
      procBusy: {}, // service -> "restarting" | "stopping" | "starting"
      busy: null, // "starting" | "stopping"
      launch: null, // { path, branch, since, tail } from Start until the services answer
      error: null,
      confirmStop: false,
      startedAt: Number(saved("startedAt")) || null,
    };
  }

  // The machines the panel offers: this Mac and the devboxes that run now.
  listed() {
    return [this.boxes[LOCAL], ...this.devboxes.map((d) => this.boxes[d.machine]).filter(Boolean)];
  }

  // The machine shown: the one picked, while it's still running; else this Mac.
  box() {
    return this.listed().find((b) => b.key === this.cur) ?? this.boxes[LOCAL];
  }

  // exec's options for a machine: on it, or here.
  on(b) {
    return b.machine ? { on: b.machine } : {};
  }

  // Its "hogli" shell's hc address: "hogli" here, "<machine>/hogli" on a devbox.
  addr(b) {
    return b.machine ? `${b.machine}/${NAME}` : NAME;
  }

  shell(b) {
    return terminals().find((x) => x.name === NAME && x.state === "live" && machineOf(x.address) === b.machine) ?? null;
  }

  // A devbox can be worked with once Herdr reaches it and knows its home.
  ready(b) {
    return !b.machine || (Boolean(b.home) && machines().find((m) => m.name === b.machine)?.layout === "ready");
  }

  setLocal(b, name, value) {
    localStorage.setItem(`${name}:${b.key}`, value);
  }

  // ---- machines ----

  // Your devboxes that run (`coder list`), each a machine in the picker. One Herdr doesn't know
  // yet gets added when it's picked.
  loadDevboxes(cx) {
    cx.spawn(async (cx) => {
      try {
        if (!this.coderUser) {
          const who = JSON.parse((await exec(CODER(), ["whoami", "-o", "json"])).stdout || "[]");
          this.coderUser = (Array.isArray(who) ? who[0] : who)?.username;
        }
        const r = await exec(CODER(), ["list", "--output", "json"]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `coder exited ${r.code}`);
        const known = JSON.parse((await exec("hc", ["machine", "ls", "--json"])).stdout || "{}").machines ?? [];
        const prefix = `devbox-${this.coderUser}`;
        this.devboxes = JSON.parse(r.stdout || "[]")
          .filter((w) => (w.name === prefix || w.name.startsWith(`${prefix}-`)) && w.latest_build?.status === "running")
          .map((w) => {
            const label = w.name === prefix ? "default" : w.name.slice(prefix.length + 1);
            return { ws: w.name, label, machine: known.find((m) => reachesDevbox(m.target, w.name))?.name ?? `devbox-${label}` };
          });
        for (const d of this.devboxes) this.boxes[d.machine] ??= this.newBox(d.machine, { machine: d.machine, ws: d.ws, label: d.label });
        this.devboxError = null;
        await this.syncForwards(cx);
      } catch (e) {
        this.devboxError = `Devboxes unavailable: ${String(e?.message ?? e).slice(0, 120)}`;
      }
      const b = this.box();
      if (b.machine && !this.ready(b)) this.connect(b, cx);
      cx.notify();
    });
  }

  pick(b, cx) {
    this.cur = b.key;
    localStorage.setItem("machine", b.key);
    this.open = false;
    this.toEnd();
    if (b.machine && !this.ready(b)) this.connect(b, cx);
    else { this.scan(b, cx); this.poll(cx); }
    cx.notify();
  }

  // A devbox in Herdr's machines (added with hc installed if it isn't), its home and repo
  // (~/posthog, where hogli puts it), its hogli shell and worktrees.
  connect(b, cx) {
    if (b.connecting) return;
    b.connecting = true;
    b.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const isReady = () => machines().find((m) => m.name === b.machine)?.layout === "ready";
        if (!machines().some((m) => m.name === b.machine)) {
          const r = await exec("hc", addDevboxArgs(b.ws, b.machine));
          if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "hc machine add failed");
        }
        for (let i = 0; i < 60 && !isReady(); i++) await cx.sleep(1000);
        if (!isReady()) throw new Error(`Herdr can't reach ${b.machine}`);
        const h = await exec("sh", ["-c", 'printf %s "$HOME"'], this.on(b));
        if (h.code !== 0 || !h.stdout.trim()) throw new Error(h.stderr.trim().split("\n").pop() || "no home there");
        b.home = h.stdout.trim();
        b.repo = `${b.home}/posthog`;
        if (!b.worktrees.length) b.worktrees = [{ path: b.repo, branch: "master" }];
        await this.ensureShell(b, cx);
        this.loadWorktrees(b, cx);
        this.scan(b, cx);
      } catch (e) {
        b.error = String(e?.message ?? e);
      }
      b.connecting = false;
      cx.notify();
    });
  }

  // ---- this Mac's view of a devbox's PostHog ----

  // `coder port-forward`s running here, found by their command lines (also one you started).
  async readForwards() {
    const r = await exec("ps", ["-eo", "pid=,args="]).catch(() => null);
    const out = {};
    for (const line of (r?.stdout ?? "").split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      const f = m && m[2].match(FORWARD);
      if (f) out[f[1]] = { pid: Number(m[1]), port: Number(f[2]) };
    }
    this.forwards = out;
    return out;
  }

  // Each running devbox whose stack runs (or is starting) gets a forward of its PostHog to the
  // first free port here from 8011; the forward of a devbox that no longer runs ends.
  async syncForwards(cx) {
    const fw = await this.readForwards();
    const live = new Set(this.devboxes.map((d) => d.ws));
    for (const [ws, f] of Object.entries(fw)) {
      if (!live.has(ws)) { await exec("kill", [String(f.pid)]).catch(() => null); delete fw[ws]; }
    }
    for (const d of this.devboxes) {
      const b = this.boxes[d.machine];
      if (fw[d.ws] || !b || !(b.stacks.length || b.launch)) continue;
      const taken = new Set(Object.values(fw).map((f) => f.port));
      let port = null;
      for (const p of FORWARD_PORTS) {
        if (taken.has(p)) continue;
        const busy = await exec("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"]).catch(() => ({ code: 0 }));
        if (busy.code !== 0) { port = p; break; }
      }
      if (!port) { b.error = "No free port here (8011–8020) to forward this devbox's PostHog to."; continue; }
      const log = `${home()}/.cache/herdr-devbox/forward-${d.ws}.log`;
      await exec("sh", ["-c", 'mkdir -p "$(dirname "$4")"; nohup "$0" port-forward "$1" --tcp="$2:$3" >"$4" 2>&1 </dev/null &',
        CODER(), d.ws, String(port), String(DEVBOX_UI_PORT), log]).catch(() => null);
      fw[d.ws] = { pid: null, port };
    }
    await cx.sleep(500);
    await this.readForwards();
    cx.notify();
  }

  // ---- each machine's stack ----

  // A machine's hogli shell, kept by its core across restarts. Started here, not from an agent's
  // terminal, so nobody gets told when it ends.
  ensureShell(b, cx) {
    if (this.shell(b)) return Promise.resolve();
    const args = ["run", ...(b.machine ? ["--on", b.machine] : ["--cwd", home()]), "--bg", "--keep", "--json", "--name", NAME];
    return exec("hc", args)
      .then((r) => { if (r.code !== 0) b.error = r.stderr.trim().split("\n").pop(); cx.notify(); })
      .catch((e) => { b.error = String(e?.message ?? e); cx.notify(); });
  }

  loadWorktrees(b, cx) {
    if (!this.ready(b)) return;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["-C", b.repo, "worktree", "list", "--porcelain"], this.on(b));
        if (r.code === 0) b.worktrees = parseWorktrees(r.stdout);
        else b.error = r.stderr.trim().split("\n").pop();
      } catch (e) {
        b.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // Every stack is a phrocs process; the ones under the machine's hogli shell are this panel's.
  scan(b, cx) {
    if (b.scanning || !this.ready(b)) return;
    b.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const ps = await exec("ps", ["-eo", "pid=,ppid=,args="], this.on(b)).catch(() => null);
        const rows = (ps?.stdout ?? "").split("\n").map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
          .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
        const found = rows.map((r) => ({ pid: r.pid, m: r.args.match(PHROCS) })).filter((x) => x.m).map((x) => ({ pid: x.pid, path: x.m[1] }));
        let stacks = found.map((f) => ({ ...f, ours: false }));
        if (found.length && this.shell(b)) {
          const info = await exec("hc", ["get", this.addr(b), "--json"]).catch(() => null);
          const shellPid = info?.code === 0 ? JSON.parse(info.stdout).pid : null;
          const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
          const under = (pid) => { for (let p = pid, n = 0; p > 1 && n < 30; p = parent.get(p), n++) if (p === shellPid) return true; return false; };
          stacks = found.map((f) => ({ ...f, ours: Boolean(shellPid) && under(f.pid) }));
        }
        if (JSON.stringify(stacks) !== JSON.stringify(b.stacks)) {
          const wasUp = b.stacks.length > 0;
          b.stacks = stacks;
          // A devbox's stack came up: its PostHog gets forwarded here.
          if (b.machine && stacks.length && !wasUp) this.syncForwards(cx);
          cx.notify();
        }
      } finally {
        b.scanning = false;
      }
    });
  }

  // ---- phrocs' socket ----

  // /tmp/phrocs-<first 8 hex of sha256(real path)>.sock on that machine, as phrocs computes it.
  async socketFor(b, path) {
    if (b.sockets[path]) return b.sockets[path];
    const r = await exec("/usr/bin/python3", ["-I", "-c", SOCKET_HASH, path], this.on(b));
    if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim().split("\n").pop() || "couldn't name phrocs' socket");
    b.sockets[path] = `/tmp/phrocs-${r.stdout.trim()}.sock`;
    return b.sockets[path];
  }

  // One request, one line of JSON back.
  async ipc(b, path, req, timeoutS = 3) {
    const sock = await this.socketFor(b, path);
    const r = await exec("/usr/bin/python3", ["-I", "-c", SOCKET_CLIENT, sock, JSON.stringify(req), String(timeoutS)], this.on(b));
    const line = r.stdout.split("\n").find((l) => l.trim());
    if (!line) throw new Error(r.stderr.trim().split("\n").pop() || `no answer from phrocs (exit ${r.code})`);
    const resp = JSON.parse(line);
    if (!resp.ok) throw new Error(resp.error || "phrocs refused");
    return resp;
  }

  async loadGroups(b, path) {
    if (b.groups.path === path) return;
    const text = await readTextFile(`${path}/.posthog/.generated/mprocs.yaml`, this.on(b)).catch(() => "");
    b.groups = { path, ...parseGroups(text || "") };
    b.units = parseUnits(await readTextFile(`${path}/bin/mprocs.yaml`, this.on(b)).catch(() => "") || "");
  }

  // The shown machine's services and its selected one's logs.
  poll(cx) {
    const b = this.box();
    const r = this.running(b);
    if (!r) { if (b.procs) { b.procs = null; b.logs = []; cx.notify(); } return; }
    if (b.polling || this.width < 160) return;
    b.polling = true;
    cx.spawn(async (cx) => {
      try {
        await this.loadGroups(b, r.path);
        const names = (await this.ipc(b, r.path, { cmd: "list" })).processes;
        if (b.procs?.path !== r.path) b.procs = { path: r.path, names, status: {} };
        else b.procs.names = names;
        if (!names.includes(b.sel)) b.sel = names.includes("backend") ? "backend" : [...names].sort()[0];
        this.refreshStatus(b, r.path, cx);
        const logs = await this.ipc(b, r.path, { cmd: "logs", process: b.sel, lines: LOG_LINES });
        b.logs = logs.lines.map(stripAnsi);
        b.ipcError = null;
      } catch (e) {
        b.ipcError = String(e?.message ?? e);
      }
      b.polling = false;
      cx.notify();
    });
  }

  // All statuses at once, one request at a time, given up to 90s.
  refreshStatus(b, path, cx) {
    if (b.statusBusy) return;
    b.statusBusy = true;
    cx.spawn(async (cx) => {
      try {
        const all = (await this.ipc(b, path, { cmd: "status_all" }, 90)).processes;
        if (b.procs?.path === path) b.procs.status = all;
        b.statusError = null;
      } catch (e) {
        b.statusError = String(e?.message ?? e);
      }
      b.statusBusy = false;
      cx.notify();
    });
  }

  toEnd() {
    this.follow = true;
    this.logOffset = 0;
  }

  selectProc(b, name, cx) {
    b.sel = name;
    this.setLocal(b, "proc", name);
    b.logs = [];
    this.toEnd();
    cx.notify();
    this.poll(cx);
  }

  // A unit this stack left out (not in its products, not a manual one): hogli works out its
  // command, and phrocs adds and starts it. It lasts until the stack stops; hogli dev:setup
  // keeps it for good.
  addUnit(b, name, cx) {
    const r = this.running(b);
    if (!r || b.adding[name]) return;
    b.adding[name] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await exec("/bin/sh", ["-c", UNIT_SHELL, "sh", r.path, name], this.on(b));
        const cmd = res.stdout.trim();
        if (res.code !== 0 || !cmd) throw new Error(res.stderr.trim().split("\n").pop() || `hogli exited ${res.code}`);
        await this.ipc(b, r.path, { cmd: "add-proc", process: name, shell: cmd });
        const unit = b.units.find((u) => u.name === name);
        if (unit) b.groups.groupOf[name] = unit.layer;
        b.sel = name;
        this.setLocal(b, "proc", name);
        this.follow = true;
      } catch (e) {
        notify({ title: `Couldn't add ${name}`, body: String(e?.message ?? e), level: "error", timeout: 8000 });
      }
      delete b.adding[name];
      cx.notify();
      this.poll(cx);
    });
  }

  // Start, stop or restart one service: phrocs' socket toggles a service on or off; a restart
  // is off, then on once it has stopped.
  procAction(b, name, what, cx) {
    const r = this.running(b);
    if (!r || b.procBusy[name] || !b.procs?.status[name]) return;
    b.procBusy[name] = what;
    cx.notify();
    const isUp = () => ["running", "pending"].includes(b.procs?.status[name]?.status);
    cx.spawn(async (cx) => {
      try {
        if (what !== "starting" || !isUp()) await this.ipc(b, r.path, { cmd: "toggle-proc", process: name });
        if (what === "restarting") {
          for (let i = 0; i < 20; i++) {
            await cx.sleep(500);
            const st = (await this.ipc(b, r.path, { cmd: "status", process: name })).status;
            if (!["running", "pending"].includes(st)) break;
          }
          await this.ipc(b, r.path, { cmd: "toggle-proc", process: name });
        }
      } catch (e) {
        b.ipcError = String(e?.message ?? e);
      }
      delete b.procBusy[name];
      cx.notify();
      this.poll(cx);
    });
  }

  // What runs on a machine now: this panel's stack, else one started elsewhere.
  running(b) {
    const s = b.stacks.find((x) => x.ours) ?? b.stacks[0];
    if (!s) return null;
    const wt = b.worktrees.find((w) => w.path === s.path);
    const labels = this.shell(b)?.labels ?? {};
    return {
      path: s.path, pid: s.pid, external: !s.ours,
      branch: wt?.branch ?? s.path.split("/").pop(),
      space: s.ours && labels["hogli.cwd"] === s.path ? labels["hogli.space"] || null : null,
      since: s.ours ? b.startedAt : null,
    };
  }

  // The tasks panel marks the task this Mac's stack runs for.
  share(r) {
    const value = r ? { path: r.path, branch: r.branch, space: r.space ?? this.taskFor(this.boxes[LOCAL], r.branch, r.path)?.id ?? null, external: r.external } : null;
    if (JSON.stringify(value) !== JSON.stringify(shared(RUNNING) ?? null)) setShared(RUNNING, value);
  }

  // A worktree's task: on a devbox, the task that runs there; here, the one it was started for,
  // else the one whose PRs are on its branch (the tasks panel shares them).
  taskFor(b, branch, path) {
    if (b.machine) return spaces().find((s) => s.machine === b.machine) ?? null;
    const linked = path && (shared(LINKS) ?? {})[path];
    const map = shared("tasks.branches") ?? {};
    const id = (linked && spaces().some((s) => s.id === linked) ? linked : null) ?? Object.keys(map).find((k) => map[k].includes(branch));
    return id ? spaces().find((s) => s.id === id) ?? null : null;
  }

  // Started here from a task that no PR ties to this worktree: remember that task for it.
  link(b, wt) {
    const known = this.taskFor(b, wt.branch, wt.path);
    if (known || b.machine) return known;
    const setup = new Set(shared("tasks.setup") ?? []);
    const active = spaces().find((s) => s.active && !setup.has(s.id));
    if (active) setShared(LINKS, { ...(shared(LINKS) ?? {}), [wt.path]: active.id });
    return active ?? null;
  }

  current(b) {
    const path = b.selected ?? this.running(b)?.path ?? b.repo;
    return b.worktrees.find((w) => w.path === path) ?? b.worktrees[0];
  }

  select(b, wt, cx) {
    b.selected = wt.path;
    this.setLocal(b, "selected", wt.path);
    this.open = false;
    cx.notify();
  }

  // Full view: phrocs' own screen in a window, under a bar (this mod, part "bar") that names it,
  // drags it and closes it. The window's id is shared so the bar can close it.
  openWindow(b) {
    if (shared(WINDOW)) this.closeWindow();
    const id = openOverlay({ kind: "window", key: "hogli", width: 760, height: 480,
      layout: { type: "column", children: [
        { type: "block", id: "hogli-window-bar", size: { px: 32 }, content: { mod: "hogli", props: { part: "bar", label: b.label } } },
        { type: "block", id: "hogli-window-term", content: { terminal: this.addr(b) } },
      ] } });
    setShared(WINDOW, id);
  }

  closeWindow() {
    const id = shared(WINDOW);
    if (id) closeOverlay(id);
    setShared(WINDOW, null);
  }

  windowBar(t) {
    const label = props()?.label;
    return h_flex().size_full().px(10).gap(8).items_center().bg(t.chrome).border_b_1().border_color(t.border)
      .child(this.icon("hogli", t.ansi2, 13))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground)
        .child(`hogli${label && label !== "This Mac" ? ` · ${label}` : ""} · full view`))
      .child(div().id("hg-window-close").p(3).rounded(5).cursor_pointer().text_color(t.dim)
        .hover((x) => x.bg(t.raised).text_color(t.foreground)).tooltip("Close")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // a press elsewhere on the bar drags the window
        .on_click(() => this.closeWindow())
        .child(svg(ICON("x")).size(13)));
  }

  // ---- start and stop ----

  // Types the start into the machine's shell: direnv exec loads the worktree's flox environment,
  // as cd-ing there at a prompt would.
  start(b, wt, cx) {
    if (b.busy) return;
    b.busy = "starting";
    b.error = null;
    cx.notify();
    const task = this.link(b, wt);
    cx.spawn(async (cx) => {
      try {
        await this.ensureShell(b, cx);
        await exec("hc", ["label", this.addr(b), `hogli.cwd=${wt.path}`, `hogli.branch=${wt.branch}`, `hogli.space=${b.machine ? "" : task?.id ?? ""}`]);
        const r = await exec("hc", ["send", this.addr(b), `cd ${quote(wt.path)} && direnv exec . bin/hogli start`]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `hc send exited ${r.code}`);
        b.startedAt = Date.now();
        this.setLocal(b, "startedAt", String(b.startedAt));
        b.launch = { path: wt.path, branch: wt.branch, since: Date.now(), tail: [] };
        if (b.machine) this.syncForwards(cx);
        this.watchStart(b, wt.path, Date.now(), cx);
      } catch (e) {
        b.error = String(e?.message ?? e);
      }
      b.busy = null;
      cx.notify();
    });
  }

  // From Start until the services answer, the panel says which step it's at and shows the shell's
  // last lines, checking every second instead of the usual SCAN_MS. No phrocs under the shell
  // after START_WAIT_MS and hogli no longer running there (the shell is back at its prompt), or
  // nothing by START_GIVE_UP_MS: the start failed, and those lines become the error. (A devbox's
  // first start installs packages for minutes before phrocs runs.)
  watchStart(b, path, since, cx) {
    cx.timer.after(1000, (cx) => cx.spawn(async (cx) => {
      const l = b.launch;
      if (!l || l.path !== path) return; // cancelled, or another start
      if (b.procs?.path === path && b.procs.names.length) { b.launch = null; cx.notify(); return; }
      const r = await exec("hc", ["read", this.addr(b), "--lines", "12"]).catch(() => null);
      l.tail = (r?.stdout ?? "").split("\n").map((x) => stripAnsi(x).trimEnd()).filter((x) => x && !x.startsWith("[hc]")).slice(-8);
      const up = b.stacks.some((s) => s.ours && s.path === path);
      let gaveUp = false;
      if (!up && Date.now() - since >= START_WAIT_MS) {
        const info = await exec("hc", ["get", this.addr(b), "--json"]).catch(() => null);
        const fg = info?.code === 0 ? JSON.parse(info.stdout).foreground : undefined;
        // Unknown (the line to a devbox dropped): keep waiting, up to the limit.
        const atPrompt = fg !== undefined && (!fg || SHELLS.test(fg.name ?? fg.argv?.[0] ?? ""));
        gaveUp = atPrompt || Date.now() - since >= START_GIVE_UP_MS;
      }
      if (gaveUp) {
        b.launch = null;
        b.error = `hogli didn't start:\n${l.tail.slice(-6).join("\n") || "no output"}`;
        cx.notify();
        return;
      }
      if (up) this.poll(cx); else this.scan(b, cx);
      cx.notify();
      this.watchStart(b, path, since, cx);
    }));
  }

  cancelStart(b, cx) {
    b.launch = null;
    exec("hc", ["interrupt", this.addr(b)]).catch(() => null);
    cx.notify();
  }

  // Ctrl-C (in the shell for this panel's stack, SIGINT for another), then SIGTERM if phrocs is
  // still there after STOP_WAIT_MS. Only that machine's stack.
  stop(b, cx, then) {
    const r = this.running(b);
    if (!r || b.busy) return;
    b.busy = "stopping";
    b.confirmStop = false;
    b.error = null;
    cx.notify();
    const started = Date.now();
    const alive = async () => (await exec("kill", ["-0", String(r.pid)], this.on(b)).catch(() => ({ code: 1 }))).code === 0;
    cx.spawn(async (cx) => {
      if (r.external) await exec("kill", ["-INT", String(r.pid)], this.on(b)).catch(() => null);
      else await exec("hc", ["interrupt", this.addr(b)]).catch(() => null);
      while (await alive() && Date.now() - started < STOP_WAIT_MS) await cx.sleep(1000);
      if (await alive()) await exec("kill", ["-TERM", String(r.pid)], this.on(b)).catch(() => null);
      b.stacks = b.stacks.filter((s) => s.pid !== r.pid);
      b.busy = null;
      cx.notify();
      if (then) cx.timer.after(2000, (cx) => then(cx));
    });
  }

  // ---- sidebar width, and this section folded ----

  // The column folds from its top row (the chrome mod's "right" part, shared "right.width");
  // hogli's rail only unfolds it.
  expand() {
    run("layout.resize", { id: COLUMN, px: Number(shared("right.width")) || Number(localStorage.getItem("width")) || WIDE_PX });
  }

  // Folded, the section draws its header row only. Its block keeps the rest of the column (empty),
  // so the column's footer stays at the bottom.
  isOpen() { return localStorage.getItem("open:hogli") !== "0"; }

  toggleOpen(cx) {
    localStorage.setItem("open:hogli", this.isOpen() ? "0" : "1");
    cx.notify();
  }

  // ---- drawing ----

  icon(name, color, size = 13) {
    return svg(ICON(name)).size(size).flex_none().text_color(color);
  }

  button(t, id, label, onClick, primary = false) {
    return h_flex().id(id).h(28).px(12).gap(6).items_center().justify_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium().cursor_pointer()
      .hover((x) => x.opacity(0.88))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  chip(t, text) {
    return div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(text);
  }

  // A machine in the picker: green dot while its stack runs, pulsing while one starts.
  machineChip(t, b) {
    const on = b === this.box();
    const up = b.stacks.length > 0;
    const dot = b.launch || b.busy === "starting" ? div().w(6).h(6).flex_none().rounded(6).bg(t.ansi3).loop("opacity", { from: 0.35, to: 1, period: 1200 })
      : up ? div().w(6).h(6).flex_none().rounded(6).bg(t.ansi2)
      : div().w(6).h(6).flex_none().rounded(6).border_1().border_color(t.dim);
    const d = b.machine ? this.devboxes.find((x) => x.machine === b.machine) : null;
    return h_flex().id(`hg-m-${b.key}`).h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.input).bg(on ? t.selected : t.raised)
      .text_size(11.5).text_color(on ? t.foreground : t.muted).hover((x) => x.text_color(t.foreground))
      .tooltip(b.machine ? `Devbox ${d?.ws ?? b.machine}${up ? " · hogli runs there" : ""}` : `This Mac${up ? " · hogli runs here" : ""}`)
      .on_click((_e, cx) => this.pick(b, cx))
      .child(dot)
      .child(div().child(b.machine ? `☁ ${b.label}` : b.label));
  }

  worktreeRow(t, b, wt, selected, running) {
    const task = this.taskFor(b, wt.branch, wt.path);
    // A fixed height that doesn't shrink: rows that shrink to fit leave the list nothing to scroll.
    return h_flex().id(`hg-wt-${wt.path}`).h(WT_ROW).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => this.select(b, wt, cx))
      .child(running ? this.icon("hogli", t.ansi2, 12) : div().w(12).flex_none())
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(wt.branch))
          .when(Boolean(task), (el) => el.child(this.chip(t, task.name.slice(0, 28)))))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(this.short(b, wt.path))));
  }

  // A path for people: ~ for the machine's home.
  short(b, path) {
    return b.home ? path.replace(b.home, "~") : short(path);
  }

  rail(t) {
    const up = this.listed().filter((b) => b.stacks.length > 0);
    return v_flex().id("hg-rail").size_full().bg(t.chrome).items_center().pt(12).gap(6).cursor_pointer()
      .tooltip(up.length ? `hogli running on ${up.map((b) => b.label).join(", ")}` : "hogli: not running")
      .on_click(() => this.expand())
      .child(this.icon("hogli", up.length ? t.ansi2 : t.dim, 16))
      .child(div().w(6).h(6).rounded(6).bg(up.length ? t.ansi2 : t.dim));
  }

  // ---- services ----

  // A service's dot, as phrocs draws it: ready green, starting yellow (pulsing), crashed red,
  // finished (a one-off like a migration) a dim check, stopped or waiting dim.
  procDot(t, snap) {
    const st = snap?.status;
    if (st === "crashed") return div().w(7).h(7).flex_none().rounded(7).bg(t.ansi1);
    if (st === "running" && snap.ready) return div().w(7).h(7).flex_none().rounded(7).bg(t.ansi2);
    if (st === "running") return div().w(7).h(7).flex_none().rounded(7).bg(t.ansi3).loop("opacity", { from: 0.35, to: 1, period: 1200 });
    if (st === "done") return div().w(7).flex_none().text_size(9).text_color(t.dim).child("✓");
    if (st === "unknown") return div().w(7).h(7).flex_none().rounded(7).bg(t.raised);
    return div().w(7).h(7).flex_none().rounded(7).border_1().border_color(t.dim);
  }

  // A unit hogli knows that this stack doesn't have: Add brings it in and starts it.
  unitRow(t, b, u) {
    const busy = b.adding[u.name];
    return h_flex().id(`hg-unit-${u.name}`).h(22).px(8).gap(7).items_center().rounded(5)
      .hover((x) => x.bg(t.hover))
      .tooltip(`${u.layer}. Add runs it in this stack until the stack stops (hogli dev:setup keeps it for good).`)
      .child(busy ? this.icon("spinner", t.working, 10).spin(900) : div().w(7).h(7).flex_none().rounded(7).border_1().border_dashed().border_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(u.name))
      .when(!busy, (el) => el.child(this.smallButton(t, `hg-unit-add-${u.name}`, "Add", (cx) => this.addUnit(b, u.name, cx))))
      .when(Boolean(busy), (el) => el.child(div().text_size(10.5).text_color(t.dim).child("adding…")));
  }

  // canStart: a standby service, which gets its own Start.
  procRow(t, b, name, snap, canStart = false) {
    const sel = name === b.sel;
    const busy = b.procBusy[name];
    return h_flex().id(`hg-proc-${name}`).h(22).px(8).gap(7).items_center().rounded(5).cursor_pointer()
      .when(sel, (el) => el.bg(t.selected))
      .hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => this.selectProc(b, name, cx))
      .child(busy ? this.icon("spinner", t.working, 10).spin(900) : this.procDot(t, snap))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5)
        .text_color(snap.status === "crashed" ? t.ansi1 : snap.status === "running" ? t.foreground : t.muted).child(name))
      .when(Boolean(snap.mem_rss_mb) && this.width > 300, (el) => el.child(div().flex_none().font_family(MONO).text_size(10).text_color(t.dim)
        .child(`${Math.round(snap.mem_rss_mb)}M`)))
      .when(canStart && !busy, (el) => el.child(this.smallButton(t, `hg-proc-start-${name}`, "Start", (cx) => { cx.stop_propagation(); this.procAction(b, name, "starting", cx); })));
  }

  // Services by phrocs' "layer" groups, in its order; then the ones that don't start by
  // themselves (standby: Start runs one), and the units this stack left out (Add runs one).
  procList(t, b) {
    const status = b.procs.status;
    const names = [...b.procs.names].filter((n) => status[n]?.status !== "standby").sort();
    const standby = [...b.procs.names].filter((n) => status[n]?.status === "standby").sort();
    const known = new Set(b.procs.names);
    const missing = b.units.filter((u) => !known.has(u.name)).sort((a, c) => a.name.localeCompare(c.name));
    const { groupOf, order } = b.groups;
    const groups = new Map();
    for (const n of names) {
      const g = groupOf[n] ?? "Other";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
    }
    const ordered = [...groups.keys()].sort((a, c) => {
      const ia = order.indexOf(a), ic = order.indexOf(c);
      return (ia < 0 ? 99 : ia) - (ic < 0 ? 99 : ic) || a.localeCompare(c);
    });
    const rows = [];
    for (const g of ordered) {
      rows.push(div().px(8).pt(6).pb(2).text_size(10.5).text_color(t.dim).child(g));
      for (const n of groups.get(g)) rows.push(this.procRow(t, b, n, status[n] ?? { status: "unknown" }));
    }
    if (standby.length) {
      rows.push(div().px(8).pt(6).pb(2).text_size(10.5).text_color(t.dim).child("Off (start by hand)"));
      for (const n of standby) rows.push(this.procRow(t, b, n, status[n], true));
    }
    if (missing.length) {
      const open = localStorage.getItem("open:missing") === "1";
      rows.push(h_flex().id("hg-missing").px(8).pt(6).pb(2).gap(5).items_center().cursor_pointer()
        .text_size(10.5).text_color(t.dim).hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => { localStorage.setItem("open:missing", open ? "0" : "1"); cx.notify(); })
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(9).flex_none())
        .child(div().child(`Not in this stack (${missing.length})`)));
      if (open) for (const u of missing) rows.push(this.unitRow(t, b, u));
    }
    return rows;
  }

  procSummary(b) {
    const all = Object.values(b.procs?.status ?? {}).filter((p) => p.status !== "standby");
    if (!all.length) return { text: b.statusBusy ? "reading statuses…" : b.statusError ? "statuses unavailable" : "", crashed: 0 };
    const count = (f) => all.filter(f).length;
    const parts = [`${count((p) => p.status === "running" && p.ready)} ready`];
    // Running but not ready yet is starting; pending is waiting (to be started, or on another).
    const starting = count((p) => p.status === "running" && !p.ready);
    if (starting) parts.push(`${starting} starting`);
    const waiting = count((p) => p.status === "pending");
    if (waiting) parts.push(`${waiting} waiting`);
    const crashed = count((p) => p.status === "crashed");
    if (crashed) parts.push(`${crashed} crashed`);
    return { text: parts.join(" · "), crashed };
  }

  smallButton(t, id, label, onClick, on = false) {
    return div().id(id).px(7).h(20).flex().items_center().rounded(5).border_1()
      .border_color(on ? t.accent : t.input).bg(on ? t.selected : t.raised)
      .text_size(10.5).text_color(t.foreground).cursor_pointer().hover((x) => x.opacity(0.85))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  // The selected service's last lines, following the end unless Follow is off.
  logView(t, b) {
    const snap = b.procs?.status[b.sel];
    const up = ["running", "pending"].includes(snap?.status);
    const busy = b.procBusy[b.sel];
    const lineColor = (l) => /\b(error|exception|traceback|fatal|critical)\b/i.test(l) ? t.ansi1
      : /\bwarn(ing)?\b/i.test(l) ? t.ansi3 : t.muted;
    const cols = Math.max(20, Math.floor((this.width - 24) / LOG_CHAR_PX));

    const rows = [];
    for (const line of b.logs) {
      const chars = Array.from(line), color = lineColor(line);
      if (!chars.length) rows.push({ text: " ", color });
      for (let i = 0; i < chars.length; i += cols) rows.push({ text: chars.slice(i, i + cols).join(""), color });
    }
    // Paused, new rows push the offset so the view stays on the same lines.
    if (!this.follow && this.rowCount && rows.length > this.rowCount) this.logOffset += rows.length - this.rowCount;
    this.rowCount = rows.length;
    const fit = Math.max(1, Math.floor(this.logBoxH / LOG_ROW_PX));
    this.logOffset = Math.max(0, Math.min(this.logOffset, rows.length - fit));
    const end = rows.length - this.logOffset;
    const shown = rows.slice(Math.max(0, end - fit), end);
    return v_flex().flex_1().min_h(0).overflow_hidden().border_t_1().border_color(t.border)
      .child(h_flex().px(10).py(6).flex_none().gap(6).items_center()
        .child(this.procDot(t, snap))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(b.sel))
        // phrocs only toggles a service on or off, so its buttons wait until its status is known.
        .child(busy ? div().text_size(10.5).text_color(t.muted).child(`${busy}…`)
          : !snap ? div().text_size(10.5).text_color(t.dim).child("status…")
          : h_flex().gap(4)
            .when(this.follow, (el) => el.child(this.smallButton(t, "hg-pause", "Pause", (cx) => { this.follow = false; cx.notify(); })))
            .child(this.smallButton(t, "hg-proc-restart", "Restart", (cx) => this.procAction(b, b.sel, "restarting", cx)))
            .child(this.smallButton(t, "hg-proc-toggle", up ? "Stop" : "Start", (cx) => this.procAction(b, b.sel, up ? "stopping" : "starting", cx)))))
      // Follows the end; scrolling up stops that, and Bottom brings it back.
      // The list is the growing flex item itself: a percentage height inside a flex item isn't
      // bounded, so the list would grow to its content and never scroll.
      .child(v_flex().id("hg-logs-box").relative().flex_1().min_h(0).px(4).overflow_hidden()
        .on_size_change((size, cx) => { if (Math.abs(size.height - this.logBoxH) >= 1) { this.logBoxH = size.height; cx.notify(); } })
        // The wheel moves by rows: up (positive y) goes back in the logs and stops following.
        .on_scroll_wheel((e, cx) => {
          const by = Math.round((e.delta.y || 0) / LOG_ROW_PX) || Math.sign(e.delta.y || 0);
          if (!by) return;
          this.logOffset = Math.max(0, this.logOffset + by);
          this.follow = this.logOffset === 0;
          cx.notify();
        })
        .children(shown.map((r) => div().h(LOG_ROW_PX).flex_none().px(6).whitespace_nowrap().overflow_hidden()
          .font_family(MONO).text_size(LOG_FONT_PX).text_color(r.color).child(r.text)))
        .when(!this.follow, (el) => el.child(h_flex().id("hg-bottom").absolute().bottom(10).right(14).h(24).px(10).gap(5)
          .items_center().rounded(12).bg(t.solid).text_color(t.solid_foreground).text_size(11).font_medium().cursor_pointer()
          .shadow_md().hover((x) => x.opacity(0.9)).tooltip("Scroll to the end and follow it")
          .on_click((_e, cx) => { this.toEnd(); cx.notify(); })
          .child("↓ Bottom"))));
  }

  services(t, b) {
    const sum = this.procSummary(b);
    const open = localStorage.getItem("open:services") !== "0";
    return v_flex().flex_1().min_h(0).mt(4).border_t_1().border_color(t.border)
      // The sidebar's one collapsing pattern: chevron on the left, title, count; the row toggles.
      .child(h_flex().id("hg-sec-services").h(28).px(12).flex_none().gap(6).items_center().cursor_pointer()
        .text_color(t.muted).hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => { localStorage.setItem("open:services", open ? "0" : "1"); cx.notify(); })
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
        .child(div().text_size(11.5).font_medium().child("Services"))
        .child(div().text_size(10.5).text_color(sum.crashed ? t.ansi1 : t.dim).child(sum.text)))
      // Services above, logs below, and a divider between them that drags. The services get a set
      // height (kept); the logs always get the rest, so they never run past the bottom.
      .when(open, (el) => el.child(v_flex().id("hg-procs").flex_none().h(this.listPx()).px(6).pb(4).overflow_y_scrollbar().children(this.procList(t, b))))
      .when(open, (el) => el.child(div().id("hg-divider").h(6).flex_none().cursor_row_resize()
        .bg(this.splitDrag ? t.accent : "#00000000").hover((x) => x.bg(t.border))
        .on_mouse_down("left", (e, cx) => { this.splitDrag = { y: e.position.y, px: this.listPx() }; cx.stop_propagation(); cx.notify(); })))
      .child(this.logView(t, b));
  }

  listPx() {
    const stored = Number(localStorage.getItem("listPx")) || Math.round(this.height * 0.4);
    return Math.max(60, Math.min(stored, Math.max(60, this.height - 320)));
  }

  // Stopping a stack this panel didn't start asks first.
  stopButton(t, b, r, id, label, then, primary = false) {
    return this.button(t, id, label, (cx) => {
      if (r.external && !b.confirmStop) { b.confirmStop = { label, then }; cx.notify(); return; }
      this.stop(b, cx, then);
    }, primary);
  }

  // A devbox's PostHog here: the forwarded port, with Open; while its stack runs.
  forwardRow(t, b) {
    const f = this.forwards[b.ws];
    const url = f ? `http://localhost:${f.port}` : null;
    return h_flex().mx(12).mb(8).px(10).py(6).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(div().w(6).h(6).flex_none().rounded(6).bg(url ? t.ansi2 : t.ansi3))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12).text_color(t.foreground).child(url ? `localhost:${f.port}` : "Forwarding PostHog here…"))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(url ? `the devbox's PostHog (its port ${DEVBOX_UI_PORT}), on this Mac` : "coder port-forward")))
      .when(Boolean(url), (el) => el
        .child(this.smallButton(t, "hg-fw-copy", "Copy", (cx) => { cx.write_to_clipboard(url); notify({ title: "Copied", body: url, level: "info", timeout: 2000 }); }))
        .child(this.smallButton(t, "hg-fw-open", "Open", () => exec("open", [url]).catch(() => null))));
  }

  render(cx) {
    const t = theme();
    if (this.part === "idle") return div();
    if (this.part === "bar") return this.windowBar(t);
    this.share(this.running(this.boxes[LOCAL]));
    const b = this.box();
    const r = this.running(b);
    const root = (el) => el.id("hg-root").on_size_change((size, cx) => {
      if (Math.abs(size.width - this.width) < 1 && Math.abs(size.height - this.height) < 1) return;
      this.width = size.width;
      this.height = size.height;
      cx.notify();
    })
      // Dragging the divider between services and logs.
      .on_mouse_move((e, cx) => {
        const d = this.splitDrag;
        if (!d) return;
        localStorage.setItem("listPx", String(Math.round(Math.max(60, d.px + e.position.y - d.y))));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.splitDrag) { this.splitDrag = null; cx.notify(); } })
      .on_hover((on, cx) => { if (!on && this.splitDrag) { this.splitDrag = null; cx.notify(); } });
    if (this.width < 160) return root(this.rail(t));
    const wt = this.current(b);
    const here = r && r.path === wt?.path;
    const task = wt && this.taskFor(b, wt.branch, wt.path);
    const restart = (cx) => this.start(b, wt, cx);

    let actions;
    if (!this.ready(b)) {
      actions = b.connecting || !b.error
        ? h_flex().gap(8).items_center()
          .child(this.icon("spinner", t.working, 13).spin(900))
          .child(div().text_size(12).text_color(t.muted).child(`Connecting to ${b.label}…`))
        : h_flex().gap(8).child(this.button(t, "hg-connect", "Try again", (cx) => this.connect(b, cx), true));
    } else if (b.busy) {
      actions = h_flex().gap(8).items_center()
        .child(this.icon("spinner", t.working, 13).spin(900))
        .child(div().text_size(12).text_color(t.muted).child(b.busy === "starting" ? "Starting…" : "Stopping…"));
    } else if (b.launch && !(r && r.path === b.launch.path && b.procs?.path === r.path && b.procs.names.length)) {
      // Started: what it's doing until the services answer (flox and hogli's own setup come first).
      const l = b.launch;
      const step = !r || r.path !== l.path ? "Preparing the environment…" : "Starting services…";
      actions = v_flex().gap(8)
        .child(h_flex().gap(8).items_center()
          .child(this.icon("spinner", t.working, 13).spin(900))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(step))
          .child(div().text_size(11).text_color(t.dim).child(`${Math.round((Date.now() - l.since) / 1000)}s`))
          .child(this.button(t, "hg-cancel", "Cancel", (cx) => this.cancelStart(b, cx))))
        .when(l.tail.length > 0, (el) => el.child(v_flex().p(8).rounded(6).bg(t.surface).border_1().border_color(t.border)
          .font_family(MONO).text_size(10.5).text_color(t.muted)
          .children(l.tail.map((x) => div().truncate().child(x)))));
    } else if (b.confirmStop && r?.external) {
      const c = b.confirmStop;
      actions = v_flex().gap(6)
        .child(div().text_size(11.5).text_color(t.foreground).child(`Stop the stack in ${r.branch}? It was started outside this panel (pid ${r.pid}).`))
        .child(h_flex().gap(8)
          .child(this.button(t, "hg-yes", "Stop it", (cx) => this.stop(b, cx, c.then), true))
          .child(this.button(t, "hg-no", "Cancel", (cx) => { b.confirmStop = false; cx.notify(); })));
    } else if (!r) {
      actions = h_flex().gap(8).child(this.button(t, "hg-start", "Start", restart, true));
    } else if (here) {
      actions = v_flex().gap(6)
        .when(r.external, (el) => el.child(div().text_size(11.5).text_color(t.muted).child("Started outside this panel (another terminal), so Full view isn't available.")))
        .child(h_flex().gap(8)
          .child(this.stopButton(t, b, r, "hg-stop", "Stop", null))
          .child(this.stopButton(t, b, r, "hg-restart", r.external ? "Restart here" : "Restart", restart))
          .when(!r.external, (el) => el.child(shared(WINDOW)
            ? this.button(t, "hg-window", "Close full view", () => this.closeWindow())
            : this.button(t, "hg-window", "Full view", () => this.openWindow(b)))));
    } else {
      actions = v_flex().gap(6)
        .child(div().text_size(11.5).text_color(t.muted).child(`Running in ${r.branch}${r.external ? " (started outside this panel)" : ""}. One stack per machine: they share its ports.`))
        .child(h_flex().gap(8).child(this.stopButton(t, b, r, "hg-switch", "Stop & start here", restart, true)));
    }

    const status = b.launch ? `starting · ${b.launch.branch}` : r ? `running · ${r.branch}${r.since ? ` · ${ago(Date.now() - r.since)}` : ""}` : "stopped";
    const listed = this.listed();
    const open = this.isOpen();
    // The header folds the section, as the sidebar's other sections do.
    const head = h_flex().id("hg-head").h(HEAD_PX).px(12).flex_none().gap(6).items_center().cursor_pointer()
      .on_click((_e, cx) => this.toggleOpen(cx))
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
      .child(this.icon("hogli", r ? t.ansi2 : t.muted, 14))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("hogli"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(r ? t.ansi2 : t.dim).child(status));
    if (!open) return root(v_flex().size_full().bg(t.chrome).child(head));
    return root(v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(head)
      // The machine: this Mac or a running devbox. Each keeps its own stack.
      .when(listed.length > 1 || Boolean(this.devboxError), (el) => el.child(v_flex().mx(12).mb(8).flex_none().gap(4)
        .child(h_flex().flex_wrap().gap(5).children(listed.map((x) => this.machineChip(t, x))))
        .when(Boolean(this.devboxError), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(this.devboxError)))))
      // The worktree to run in: the selection, and the list when open.
      .when(this.ready(b), (el) => el.child(h_flex().id("hg-picker").mx(12).px(10).py(6).flex_none().gap(8).items_center().rounded(8).cursor_pointer()
        .border_1().border_color(this.open ? t.accent : t.input).bg(t.surface)
        .hover((x) => x.border_color(t.accent))
        .on_click((_e, cx) => { this.open = !this.open; if (this.open) this.loadWorktrees(b, cx); cx.notify(); })
        .when(Boolean(here), (el) => el.child(this.icon("hogli", t.ansi2, 12)))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(wt?.branch ?? "No worktree"))
            .when(Boolean(task), (el) => el.child(this.chip(t, task.name.slice(0, 28)))))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(wt ? this.short(b, wt.path) : "")))
        .child(svg(ICON(this.open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))))
      .when(this.open && this.ready(b), (el) => el.child(v_flex().id("hg-list").mx(12).mt(4).p(4).flex_none().h(Math.min(320, b.worktrees.length * (WT_ROW + 1) + 8)).gap(1)
        .rounded(8).border_1().border_color(t.border).bg(t.popover).overflow_y_scrollbar()
        .children(b.worktrees.map((w) => this.worktreeRow(t, b, w, w.path === wt?.path, w.path === r?.path)))))
      .child(div().px(12).pt(10).pb(8).flex_none().child(actions))
      .when(Boolean(b.machine && (r || b.launch)), (el) => el.child(this.forwardRow(t, b)))
      .when(Boolean(b.error), (el) => el.child(div().mx(12).mb(8).p(8).rounded(6).bg(t.raised)
        .font_family(MONO).text_size(10.5).text_color(t.ansi1).child(b.error)))
      .when(Boolean(r && b.ipcError && !b.procs), (el) => el.child(div().mx(12).mb(8).text_size(11).text_color(t.dim)
        .child(`Can't read this stack's services yet: ${b.ipcError}`)))
      .when(Boolean(r && b.procs), (el) => el.child(this.services(t, b))));
  }
}
