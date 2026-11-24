// Brings Claude Code back in its terminals after a reboot.
//
// herdr-core recovers a kept terminal as a fresh shell (same address, same
// labels, a new shell pid) but never re-runs its program. While Claude runs,
// this mod keeps its session on the terminal's labels, together with the
// shell pid it ran under. A labelled terminal whose shell pid changed was
// recovered, so the mod types `claude --resume <session>` into it.
//
// Claude writes <config>/sessions/<pid>.json for each running session,
// with its current session id (it follows /clear and /resume) and folder.
// <config> is ~/.claude, or another ~/.claude-* folder for a second account
// started with CLAUDE_CONFIG_DIR; the resume runs under that same account.

import { View, div } from "gpui-kit";
import { exec, hc, home, readTextFile, terminals } from "herdr";

const SESSION = "resume-agents.claude.session";
const CWD = "resume-agents.claude.cwd";
const SHELL = "resume-agents.claude.shell";
const DIR = "resume-agents.claude.config";

const POLL_MS = 5000;
// Claude gone this long under the same shell means someone quit it, so it
// stays closed. A shutdown takes the whole machine down well within this.
const QUIT_AFTER_MS = 20000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function shellQuote(s) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

async function getTerminal(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// ~/.claude first, then every ~/.claude-* folder Claude has written sessions to.
async function configDirs() {
  const r = await exec("/bin/sh", ["-c", 'for d in "$HOME/.claude" "$HOME"/.claude-*; do [ -d "$d/sessions" ] && echo "$d"; done']).catch(() => null);
  const dirs = (r?.stdout ?? "").split("\n").filter(Boolean);
  return dirs.length ? dirs : [`${home()}/.claude`];
}

async function claudeSession(pid, dirs) {
  if (!pid) return null;
  for (const dir of dirs) {
    const text = await readTextFile(`${dir}/sessions/${pid}.json`);
    if (!text) continue;
    try {
      const s = JSON.parse(text);
      if (s.pid !== pid || !UUID.test(s.sessionId ?? "") || !s.cwd) return null;
      if (s.kind && s.kind !== "interactive") return null;
      return { session: s.sessionId, cwd: s.cwd, dir };
    } catch {
      return null;
    }
  }
  return null;
}

// Claude saves a session only once it has a message, and `--resume` fails on
// one it never saved.
async function hasTranscript({ session, cwd, dir }) {
  const project = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const r = await exec("test", ["-f", `${dir}/projects/${project}/${session}.jsonl`]);
  return r.code === 0;
}

async function label(address, pairs) {
  await hc(["label", address, ...Object.entries(pairs).map(([k, v]) => `${k}=${v}`)]);
}

export default class ResumeAgents extends View {
  init(_props, cx) {
    this.goneSince = new Map();
    this.sweeping = false;
    this.dirs = null;
    this.dirsAt = 0;
    cx.timer.every(POLL_MS, (cx) => this.tick(cx));
    this.tick(cx);
  }

  tick(cx) {
    if (this.sweeping) return;
    this.sweeping = true;
    cx.spawn(async () => {
      try {
        await this.sweep();
      } catch (e) {
        console.log(`resume-agents: ${e}`);
      } finally {
        this.sweeping = false;
      }
    });
  }

  async sweep() {
    if (!this.dirs || Date.now() - this.dirsAt > 60000) {
      this.dirs = await configDirs();
      this.dirsAt = Date.now();
    }
    // Local terminals only: remote ones have a machine/ prefix, and their
    // Claude sessions live on that machine.
    const candidates = terminals().filter(
      (t) =>
        t.state === "live" &&
        !t.address.includes("/") &&
        (t.program?.key === "claude" || t.labels?.[SESSION]),
    );
    const seen = new Set();

    for (const { address } of candidates) {
      seen.add(address);
      const t = await getTerminal(address);
      if (!t || t.state !== "live" || !t.pid) continue;
      const labels = t.labels ?? {};
      const shell = String(t.pid);

      const running = await claudeSession(t.foreground?.pid, this.dirs);
      if (running) {
        this.goneSince.delete(address);
        if (labels[SESSION] !== running.session || labels[CWD] !== running.cwd || labels[SHELL] !== shell || labels[DIR] !== running.dir) {
          await label(address, { [SESSION]: running.session, [CWD]: running.cwd, [SHELL]: shell, [DIR]: running.dir });
        }
        continue;
      }

      if (!labels[SESSION]) continue;

      if (labels[SHELL] !== shell) {
        // Mark it first, so the next sweep doesn't type it again while
        // Claude starts up.
        await label(address, { [SHELL]: shell });
        const dir = labels[DIR] || `${home()}/.claude`;
        const saved = { session: labels[SESSION], cwd: labels[CWD], dir };
        if (UUID.test(saved.session) && saved.cwd && (await hasTranscript(saved))) {
          // The default account must start without CLAUDE_CONFIG_DIR: naming ~/.claude makes Claude act as a fresh install.
          const env = dir === `${home()}/.claude` ? "" : `CLAUDE_CONFIG_DIR=${shellQuote(dir)} `;
          await hc(["send", address, `cd ${shellQuote(labels[CWD])} && ${env}claude --resume ${labels[SESSION]}`]);
        }
        continue;
      }

      const since = this.goneSince.get(address) ?? Date.now();
      this.goneSince.set(address, since);
      if (Date.now() - since >= QUIT_AFTER_MS) {
        this.goneSince.delete(address);
        await label(address, { [SESSION]: "", [CWD]: "", [SHELL]: "", [DIR]: "" });
      }
    }

    for (const address of this.goneSince.keys()) {
      if (!seen.has(address)) this.goneSince.delete(address);
    }
  }

  render() {
    return div();
  }
}
