import { exec, hc, home, appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";

export const dataDir = () => `${appHome()}/data/claude-usage`;
export const tapPath = () => `${appHome()}/mods/claude-usage/tap.sh`;
const CHUNK = 4 * 1024 * 1024;
const KEEP_DAYS = 8;

export const WINDOWS = [
  { key: "five_hour", label: "5h", long: "5 hours", title: "5-hour Claude limit" },
  { key: "seven_day", label: "week", long: "Week", title: "Weekly Claude limit" },
  { key: "spend_limit", label: "spend", long: "Spend", title: "Claude spend limit" },
];

const parse = (text) => {
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export async function auth() {
  try {
    const r = await exec("claude", ["auth", "status", "--json"]);
    const s = parse(r.stdout.trim());
    if (s && typeof s === "object") return s;
    return { error: (r.stderr || r.stdout).trim().split("\n").pop() || `claude exited ${r.code}` };
  } catch (e) {
    return { missing: true, error: String(e?.message ?? e) };
  }
}

export const configDir = (a) => a?.configDirectory || `${home()}/.claude`;
export const projectsDir = (a) => a?.projectsDirectory || `${configDir(a)}/projects`;

export async function connection(dir) {
  const path = `${dir}/settings.json`;
  const text = await readTextFile(path);
  const settings = text == null ? {} : parse(text);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { path, error: `${path} is not valid JSON` };
  const command = settings.statusLine?.command;
  return { path, text, settings, connected: typeof command === "string" && command.includes("/mods/claude-usage/tap.sh") };
}

async function writeThrough(path, before, text) {
  const now = await readTextFile(path);
  if (now !== before) throw new Error("Claude Code's settings changed while this ran. Try again.");
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = `${dataDir()}/settings.next.json`;
  await fs.writeFile(tmp, text);
  const r = await exec("/bin/sh", ["-c", 'cat "$1" > "$2" && rm -f "$1"', "sh", tmp, path]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Couldn't write ${path}`);
}

const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;

export async function connect(dir) {
  const c = await connection(dir);
  if (c.error) throw new Error(c.error);
  if (c.connected) return;
  const original = c.settings.statusLine ?? null;
  const command = original?.type === "command" && typeof original.command === "string" ? original.command : "";
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(`${dataDir()}/original-statusline.json`, JSON.stringify(original));
  await fs.writeFile(`${dataDir()}/original-command`, command);
  const tap = shq(tapPath());
  const statusLine = { ...(original ?? {}), type: "command", command: `[ -f ${tap} ] && exec sh ${tap}; ${command || "true"}` };
  await writeThrough(c.path, c.text, pretty({ ...c.settings, statusLine }));
}

export async function disconnect(dir) {
  const c = await connection(dir);
  if (c.error) throw new Error(c.error);
  if (!c.connected) return;
  const saved = await readTextFile(`${dataDir()}/original-statusline.json`);
  let original = parse(saved);
  if (saved == null) {
    const command = (await readTextFile(`${dataDir()}/original-command`)) ?? "";
    original = command ? { type: "command", command } : null;
  }
  const next = { ...c.settings };
  if (original) next.statusLine = original;
  else delete next.statusLine;
  await writeThrough(c.path, c.text, pretty(next));
}

export async function prune() {
  await exec("find", [`${dataDir()}/sessions`, "-name", "*.json", "-mtime", `+${KEEP_DAYS}`, "-delete"]).catch(() => null);
}

export async function limits() {
  const dir = `${dataDir()}/sessions`;
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return { windows: {}, sessions: new Map(), reports: 0 };
  }
  const windows = {};
  const sessions = new Map();
  for (const name of names) {
    const p = parse(await readTextFile(`${dir}/${name}`).catch(() => null));
    if (!p) continue;
    sessions.set(p.session_id ?? name.slice(0, -5), { transcript: p.transcript_path ?? null, model: p.model?.display_name ?? null });
    for (const { key } of WINDOWS) {
      const w = p.rate_limits?.[key];
      if (!w || typeof w.used_percentage !== "number") continue;
      const resets = typeof w.resets_at === "number" ? w.resets_at : 0;
      const best = windows[key];
      if (!best || resets > best.resets || (resets === best.resets && w.used_percentage > best.used)) {
        windows[key] = { used: w.used_percentage, resets };
      }
    }
  }
  return { windows, sessions, reports: names.length };
}

export async function sessionOf(address, dir) {
  const r = await hc(["get", address, "--json"]);
  const pid = parse(r.stdout)?.foreground?.pid;
  if (!pid) return null;
  return parse(await readTextFile(`${dir}/sessions/${pid}.json`).catch(() => null))?.sessionId ?? null;
}

export async function findTranscript(dir, sid) {
  let folders = [];
  try {
    folders = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const f of folders) {
    const path = `${dir}/${f}/${sid}.jsonl`;
    if (await fs.exists(path)) return path;
  }
  return null;
}

const fresh = () => ({ offset: 0, skip: false, seen: new Set(), output: 0, input: 0, cacheRead: 0, model: null });

export class Totals {
  constructor() {
    this.files = new Map();
  }

  async of(transcript) {
    const base = transcript.replace(/\.jsonl$/, "");
    let subs = [];
    try {
      subs = (await fs.readdir(`${base}/subagents`)).filter((n) => n.endsWith(".jsonl")).map((n) => `${base}/subagents/${n}`);
    } catch {
      subs = [];
    }
    const sum = { output: 0, input: 0, cacheRead: 0, model: null };
    for (const file of [transcript, ...subs]) {
      const s = await this.read(file);
      sum.output += s.output;
      sum.input += s.input;
      sum.cacheRead += s.cacheRead;
      if (file === transcript) sum.model = s.model;
    }
    return sum;
  }

  async read(file) {
    let s = this.files.get(file);
    if (!s) {
      s = fresh();
      this.files.set(file, s);
    }
    for (let i = 0; i < 8; i++) {
      const r = await exec("/bin/sh", ["-c", 'wc -c < "$1" | tr -d " "; tail -c +"$2" "$1" | head -c "$3"', "sh", file, String(s.offset + 1), String(CHUNK)]);
      if (r.code !== 0) break;
      const cut = r.stdout.indexOf("\n");
      const size = Number(r.stdout.slice(0, cut));
      const body = r.stdout.slice(cut + 1);
      if (!Number.isFinite(size)) break;
      if (size < s.offset) {
        Object.assign(s, fresh());
        continue;
      }
      if (!body) break;
      const end = body.lastIndexOf("\n");
      if (end < 0) {
        if (size - s.offset > CHUNK) {
          s.offset += CHUNK;
          s.skip = true;
          continue;
        }
        break;
      }
      let text = body.slice(0, end + 1);
      s.offset += utf8Len(text);
      if (s.skip) {
        text = text.slice(text.indexOf("\n") + 1);
        s.skip = false;
      }
      for (const line of text.split("\n")) this.take(s, line);
      if (s.offset >= size) break;
    }
    return s;
  }

  take(s, line) {
    if (!line.includes('"usage"')) return;
    const r = parse(line);
    const m = r?.message;
    if (!m?.usage || m.model === "<synthetic>") return;
    const key = m.id ?? r.requestId ?? r.uuid;
    if (key) {
      if (s.seen.has(key)) return;
      s.seen.add(key);
    }
    const u = m.usage;
    s.output += u.output_tokens ?? 0;
    s.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    s.cacheRead += u.cache_read_input_tokens ?? 0;
    if (m.model) s.model = m.model;
  }
}

export function modelName(id, fallback) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id ?? "");
  if (m) return m[3] ? `${m[1]} ${m[2]}.${m[3]}` : `${m[1]} ${m[2]}`;
  return (fallback ?? id ?? "").toLowerCase();
}
