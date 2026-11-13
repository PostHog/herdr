// Brings Claude Code back in its terminals after a reboot.
//
// herdr-core recovers a kept terminal as a fresh shell (same address, same
// labels, a new shell pid) but never re-runs its program. While Claude runs,
// this mod keeps its session on the terminal's labels, together with the
// shell pid it ran under. A labelled terminal whose shell pid changed was
// recovered, so the mod types `claude --resume <session>` into it.
//
// Claude writes ~/.claude/sessions/<pid>.json for each running session,
// with its current session id (it follows /clear and /resume) and folder.

import { View, div } from "gpui-kit";
import { exec, hc, home, readTextFile, terminals } from "herdr";

const SESSION = "resume-agents.claude.session";
const CWD = "resume-agents.claude.cwd";
const SHELL = "resume-agents.claude.shell";

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

async function claudeSession(pid) {
  if (!pid) return null;
  const text = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
  if (!text) return null;
  try {
    const s = JSON.parse(text);
    if (s.pid !== pid || !UUID.test(s.sessionId ?? "") || !s.cwd) return null;
    if (s.kind && s.kind !== "interactive") return null;
    return { session: s.sessionId, cwd: s.cwd };
  } catch {
    return null;
  }
}

// Claude saves a session only once it has a message, and `--resume` fails on
// one it never saved.
async function hasTranscript({ session, cwd }) {
  const project = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const r = await exec("test", ["-f", `${home()}/.claude/projects/${project}/${session}.jsonl`]);
  return r.code === 0;
}

async function label(address, pairs) {
  await hc(["label", address, ...Object.entries(pairs).map(([k, v]) => `${k}=${v}`)]);
}

export default class ResumeAgents extends View {
  init(_props, cx) {
    this.goneSince = new Map();
    this.sweeping = false;
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

      const running = await claudeSession(t.foreground?.pid);
      if (running) {
        this.goneSince.delete(address);
        if (labels[SESSION] !== running.session || labels[CWD] !== running.cwd || labels[SHELL] !== shell) {
          await label(address, { [SESSION]: running.session, [CWD]: running.cwd, [SHELL]: shell });
        }
        continue;
      }

      if (!labels[SESSION]) continue;

      if (labels[SHELL] !== shell) {
        // Mark it first, so the next sweep doesn't type it again while
        // Claude starts up.
        await label(address, { [SHELL]: shell });
        const saved = { session: labels[SESSION], cwd: labels[CWD] };
        if (UUID.test(saved.session) && saved.cwd && (await hasTranscript(saved))) {
          await hc(["send", address, `cd ${shellQuote(labels[CWD])} && claude --resume ${labels[SESSION]}`]);
        }
        continue;
      }

      const since = this.goneSince.get(address) ?? Date.now();
      this.goneSince.set(address, since);
      if (Date.now() - since >= QUIT_AFTER_MS) {
        this.goneSince.delete(address);
        await label(address, { [SESSION]: "", [CWD]: "", [SHELL]: "" });
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
