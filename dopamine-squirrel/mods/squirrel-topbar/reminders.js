// Reminders: the top bar's bell, the add popup (squirrel-remind, cmd-shift-r) and the list popup
// (squirrel-reminders). The reminders live in data/squirrel/reminders.json, read and written only
// through reminders.py, which locks the file and replaces it atomically, so a force quit can't
// lose one. A macOS background job (com.squirrel.reminders.plist) runs `reminders.py tick mac`
// every minute for the Mac notification, also while Herdr is closed; Herdr runs `tick herdr` for its own.
import { exec, appHome, home, readTextFile, writeTextFile, setShared } from "herdr";

const STORE = () => `${appHome()}/mods/squirrel-topbar/reminders.py`;
const INBOX = () => `${appHome()}/data/squirrel/reminders-in`;
export const LIST = "squirrel.reminders";

async function store(...args) {
  const r = await exec("/usr/bin/python3", [STORE(), ...args], { timeout: 30000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "reminders.py failed");
  return JSON.parse(r.stdout);
}

// Hands JSON to reminders.py through a file, so reminder text never sits in a process's arguments.
async function inbox(data) {
  await exec("/bin/mkdir", ["-p", INBOX()]);
  const path = `${INBOX()}/${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  await writeTextFile(path, JSON.stringify(data), null);
  return path;
}

export async function refresh() {
  const list = await store("list");
  setShared(LIST, list);
  return list;
}

export async function addReminder(r) {
  await store("add", await inbox(r));
  return refresh();
}

export async function updateReminder(id, patch) {
  await store("update", id, await inbox(patch));
  return refresh();
}

// The reminders that came due and Herdr hasn't shown yet.
export async function tickHerdr() {
  const due = await store("tick", "herdr");
  if (due.length) await refresh();
  return due;
}

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    at: { type: "string" }, task: { type: "string" }, context: { type: "string" },
    model: { type: "string", enum: ["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5"] },
    effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
    problem: { type: "string" },
  },
  required: ["at", "task", "context", "model", "effort", "problem"],
  additionalProperties: false,
});

function localNow() {
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-";
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    + `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)} (${day})`;
}

// One Sonnet call reads the request: when, the task, model and effort, and, given the pane's recent
// conversation (only what was said, not tool output), what from it the task needs to start cold.
export async function parseReminder(text, transcript) {
  let talk = "";
  if (transcript) {
    const r = await exec("/usr/bin/python3", [`${appHome()}/mods/squirrel-topbar/recent-talk.py`, transcript], { timeout: 15000 }).catch(() => null);
    talk = r?.code === 0 ? r.stdout : "";
  }
  const prompt = `Turn this reminder request into a reminder. Now is ${localNow()}. Request: "${text}". `
    + "Rules: 'at' is when to remind, in local time with the offset; a day with no time means 9:00; 'next week' means next Monday 9:00. "
    + "'task' is what to do, in the person's own words, short, no time words. "
    + (talk
      ? "The person made this while in the conversation below (newest last). If the request refers to something in it (\"this\", \"the PR\", \"from here\"), "
        + "put in 'context' everything someone would need to start this task cold, and nothing else: the links, PR numbers, names, "
        + "file paths, numbers and decisions it depends on, copied exactly, as short lines. Leave out what the task doesn't need. "
        + "Never guess; if it isn't there, leave 'context' empty and say so in 'problem'. If the request refers to nothing in it, 'context' is empty. "
      : "'context' is empty. ")
    + "'model' is claude-opus-5-5 and 'effort' is high unless the request names another (fable = claude-fable-5-2, sonnet = claude-sonnet-5-5, haiku = claude-haiku-5-5). "
    + "If the time is unclear, still pick the likeliest and say why in 'problem'; otherwise 'problem' is empty."
    + (talk ? `\n\n<conversation>\n${talk}\n</conversation>` : "");
  // The prompt goes in a file, not the arguments: it can quote the conversation.
  const file = await inbox({ prompt });
  const r = await exec("/bin/sh", ["-c",
    'cd "$3" && /usr/bin/python3 -c "import json,sys;sys.stdout.write(json.load(open(sys.argv[1]))[\'prompt\'])" "$1" | '
    + 'env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_API_KEY claude -p --model claude-sonnet-5-5 --tools "" --strict-mcp-config '
    + '--no-session-persistence --output-format json --json-schema "$2"; s=$?; rm -f "$1"; exit $s', "sh", file, SCHEMA, home()], { timeout: 90000 });
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim().split("\n").pop() || "Claude didn't answer"); }
  const s = out.structured_output;
  if (!s) throw new Error(out.result || "Claude didn't answer");
  const at = Date.parse(s.at);
  if (Number.isNaN(at)) throw new Error(`Couldn't read the time "${s.at}"`);
  return { ...s, at };
}

export async function readTranscript(terminal) {
  try {
    const ctx = JSON.parse(await readTextFile(`${appHome()}/data/squirrel/context/${terminal}.json`) ?? "");
    return ctx.status?.transcript_path ?? null;
  } catch { return null; }
}
