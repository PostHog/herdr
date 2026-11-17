// What waits on you in Slack, for the Inbox, unread only: DMs and mentions you haven't answered,
// alerts still firing in the team's alerts channel, and team channel messages nobody answered
// (or threads you're in where someone else spoke last). Read is Slack's own mark: a channel's or
// DM's last_read (conversations.info), and a thread's (its parent in conversations.replies). Read as you with a user token (slack-api.sh: the app
// "Herdr Inbox (Gustavo)", user scopes only, token in the keychain); the top part of the tasks mod
// reads it every few minutes and shares it as "tasks.slack".

import { exec, appHome } from "herdr";
import { PRIVATE, PRIVATE_FILE, loadPrivate } from "./private.js";

// "#name" of a channel in the private settings ("alerts" | "team"), for showing it.
export const channelName = (which) => (PRIVATE.slack?.[which]?.name ? `#${PRIVATE.slack[which].name}` : `the ${which} channel`);

// The channels ({ id, name }), from the private settings: "slack": { "alerts": …, "team": … }.
function channel(which) {
  const c = PRIVATE.slack?.[which];
  if (!c?.id) throw new Error(PRIVATE.error ?? `No Slack "${which}" channel in ${PRIVATE_FILE}`);
  return c;
}
const DAY = 86400;
const LOOKBACK_DAYS = 3; // DMs, mentions and firing alerts older than this are left out
const TEAM_HOURS = 24; // unanswered team channel messages
const TEAM_THREAD_DAYS = 7; // threads there you're in, with someone else's word last

// Slack said no. `code` is Slack's error ("no_token" when the keychain has none).
export class SlackError extends Error {
  constructor(code, method) {
    super(code === "no_token" ? "No Slack token in the keychain" : `Slack ${method}: ${code}`);
    this.code = code;
  }
}

async function api(method, params = {}) {
  const args = [`${appHome()}/mods/tasks/slack-api.sh`, method, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)];
  const r = await exec("/bin/bash", args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `slack ${method} exited ${r.code}`);
  const body = JSON.parse(r.stdout);
  if (!body.ok) throw new SlackError(body.error, method);
  return body;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return out;
}

// People by id, kept for the life of the mod: { name, bot }.
const people = new Map();
async function person(id) {
  if (!id) return null;
  if (!people.has(id)) {
    const u = (await api("users.info", { user: id }).catch(() => null))?.user;
    people.set(id, u ? { name: u.profile?.display_name || u.real_name || u.name, bot: Boolean(u.is_bot || u.id === "USLACKBOT") } : { name: id, bot: false });
  }
  return people.get(id);
}
const nameOf = (id) => people.get(id)?.name ?? id;

// Slack's markup as plain text: mentions, channels and links by their names.
function plain(text) {
  return String(text ?? "")
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (_m, id) => `@${nameOf(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!subteam\^[A-Z0-9]+\|?([^>]*)>/g, (_m, n) => n || "@team")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
    .trim();
}
const clip = (s, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mentionIds = (text) => [...String(text ?? "").matchAll(/<@([A-Z0-9]+)/g)].map((m) => m[1]);
const day = (secs) => new Date(secs * 1000).toISOString().slice(0, 10);
const threadOf = (m) => m.permalink?.match(/[?&]thread_ts=([0-9.]+)/)?.[1] ?? m.thread_ts ?? m.ts;
const linkFor = (base, channel, ts, thread) => `${base}archives/${channel}/p${ts.replace(".", "")}${thread && thread !== ts ? `?thread_ts=${thread}&cid=${channel}` : ""}`;

// Where you've read up to in a conversation (a ts string), once per read of Slack; null if unknown.
function readMarks() {
  const marks = new Map();
  return (channel) => {
    if (!marks.has(channel)) marks.set(channel, api("conversations.info", { channel }).then((r) => r.channel?.last_read ?? null).catch(() => null));
    return marks.get(channel);
  };
}
// Unread: newer than the mark. With no mark (Slack didn't say), it shows rather than hides.
const unread = (ts, mark) => !mark || Number(ts) > Number(mark);
// A thread's mark is on its parent message, for threads you follow.
const threadMark = (replies) => replies?.messages?.[0]?.last_read ?? null;

async function searchAll(query, count = 100) {
  return (await api("search.messages", { query, sort: "timestamp", sort_dir: "desc", count })).messages?.matches ?? [];
}

// DMs where the last word isn't yours (people only; bots and your notes to yourself are left out).
async function dms(me, since, mark) {
  const matches = await searchAll(`is:dm after:${day(since - DAY)}`);
  const latest = new Map();
  for (const m of matches) if (!latest.has(m.channel?.id)) latest.set(m.channel?.id, m);
  const recent = [...latest.values()].filter((m) => m.user && m.user !== me && Number(m.ts) >= since);
  const marks = await Promise.all(recent.map((m) => mark(m.channel.id)));
  const waiting = recent.filter((m, i) => unread(m.ts, marks[i]));
  await pool([...new Set(waiting.map((m) => m.user))], 4, person);
  return waiting.filter((m) => !people.get(m.user)?.bot).map((m) => ({
    key: `dm:${m.channel.id}`,
    version: m.ts,
    kind: "dm",
    where: m.channel?.is_mpim ? "Group DM" : "DM",
    author: nameOf(m.user),
    text: m.text,
    ts: Number(m.ts),
    link: m.permalink,
  }));
}

// Mentions of you in channels by people, per thread, where you haven't written since the latest one.
async function mentions(me, since, base, mark) {
  const matches = (await searchAll(`<@${me}> after:${day(since - DAY)}`, 50))
    .filter((m) => !m.channel?.is_im && !m.channel?.is_mpim && m.user && m.user !== me && !m.bot_id && Number(m.ts) >= since);
  const byThread = new Map();
  for (const m of matches) {
    const key = `${m.channel.id}:${threadOf(m)}`;
    if (!byThread.has(key)) byThread.set(key, m);
  }
  await pool([...new Set([...byThread.values()].map((m) => m.user))], 4, person);
  const hits = [...byThread.values()].filter((m) => !people.get(m.user)?.bot);
  const threads = await pool(hits, 4, (m) => api("conversations.replies", { channel: m.channel.id, ts: threadOf(m), limit: 200 }));
  // In a thread, the thread's mark says if you've read it; at the top level, the channel's.
  const marks = await Promise.all(hits.map((m, i) => (threadOf(m) !== m.ts ? threadMark(threads[i]) : mark(m.channel.id))));
  const out = [];
  hits.forEach((m, i) => {
    const replies = threads[i]?.messages;
    if (replies && replies.some((r) => r.user === me && Number(r.ts) > Number(m.ts))) return;
    if (!unread(m.ts, marks[i])) return;
    out.push({
      key: `mention:${m.channel.id}:${threadOf(m)}`,
      version: m.ts,
      kind: "mention",
      where: `#${m.channel.name}`,
      author: nameOf(m.user),
      text: m.text,
      ts: Number(m.ts),
      link: m.permalink || linkFor(base, m.channel.id, m.ts, threadOf(m)),
    });
  });
  return out;
}

// Every piece of text in a message: its text, blocks and attachments (incident.io puts the alert
// in blocks and edits it in place as it fires, gets acknowledged and resolves).
function allText(m) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "text" || k === "fallback" || k === "pretext") && typeof x === "string" ? out.push(x) : walk(x);
  };
  if (m.text) out.push(m.text);
  walk(m.blocks);
  walk(m.attachments);
  return [...new Set(out)].join("\n");
}

// One alert message: firing or resolved, its name, priority, environment and links.
export function parseAlert(m) {
  const text = allText(m).replace(/&gt;/g, ">");
  const head = text.match(/\b(Firing|Resolved)\s*-\s*[^-\n>]*?-\s*([^>*\n]+)/);
  if (!head) return null;
  const link = (re) => text.match(re)?.[1] ?? null;
  const status = plain(text.match(/^\*?:[a-z_]+:\s*([^*\n]+)\*?/m)?.[1] ?? "");
  // incident.io edits the message when someone cancels the escalation: done with, like resolved.
  const cancelled = /escalation cancel+ed/i.test(status);
  return {
    firing: head[1] === "Firing" && !cancelled,
    cancelled,
    name: plain(head[2]).replace(/^:[a-z_-]+:\s*/, "").trim(),
    priority: text.match(/\*Priority:\*\s*([A-Za-z]+)/)?.[1] ?? null,
    env: text.match(/\*Environment:\*\s*([A-Za-z0-9_-]+)/)?.[1] ?? null,
    status,
    runbook: link(/<(https:\/\/runbooks\.[^|>]+)/),
    incident: link(/<(https:\/\/app\.incident\.io\/[^|>]+)/),
    dashboard: link(/<(https:\/\/grafana\.[^|>]+\/d\/[^|>]+)\|\*?Alert Dashboard/),
    // The lines under "View in incident.io", up to the first "*Priority:*"-style field.
    summary: plain(text.match(/View in incident\.io>\s*\n((?:(?!>?\s?[*<])[^\n]+\n?){1,4})/)?.[1]?.replace(/^>\s?/gm, "").replace(/\n/g, " ") ?? ""),
  };
}

// The newest message of each (alert, environment) since `since`, newest first: firing or resolved.
async function latestAlerts(since, base) {
  const msgs = (await api("conversations.history", { channel: channel("alerts").id, oldest: String(since), limit: 200 })).messages ?? [];
  const seen = new Set();
  const out = [];
  for (const m of msgs) {
    const a = parseAlert(m);
    if (!a) continue;
    const id = `${a.name}|${a.env}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      key: `alert:${m.ts}`,
      id,
      version: m.edited?.ts ?? m.ts,
      kind: "alert",
      where: `#${channel("alerts").name}`,
      author: a.status,
      text: a.summary,
      ts: Number(m.ts),
      link: linkFor(base, channel("alerts").id, m.ts),
      alert: a,
    });
  }
  return out;
}

// Alerts still firing that you haven't read in Slack.
async function alerts(since, base, mark) {
  const [latest, read] = await Promise.all([latestAlerts(since, base), mark(channel("alerts").id)]);
  return latest.filter((x) => x.alert.firing && unread(x.ts, read));
}

// Only the alerts channel, for the Herdr toasts and the Inbox: every alert's newest state, read in
// Slack or not (one still firing waits on you either way). Cheap enough to ask every minute.
let workspaceUrl = null;
export async function readAlerts() {
  await loadPrivate();
  workspaceUrl ??= (await api("auth.test")).url;
  const latest = await latestAlerts(Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * DAY, workspaceUrl);
  for (const x of latest) x.text = clip(plain(x.text));
  return latest;
}

// The team channel: people's messages of the last day nobody answered, and threads you're in
// where someone else wrote last.
async function team(me, base, skip, mark) {
  const now = Date.now() / 1000;
  const msgs = (await api("conversations.history", { channel: channel("team").id, oldest: String(now - TEAM_THREAD_DAYS * DAY), limit: 200 })).messages ?? [];
  const human = (m) => m.user && !m.bot_id && (!m.subtype || m.subtype === "thread_broadcast");
  const read = await mark(channel("team").id);
  const unanswered = msgs.filter((m) => human(m) && m.user !== me && !m.reply_count && Number(m.ts) >= now - TEAM_HOURS * 3600 && unread(m.ts, read));
  const mine = msgs.filter((m) => m.reply_count && (m.reply_users ?? []).includes(me) && m.latest_reply && !skip.has(`${channel("team").id}:${m.ts}`));
  const threads = await pool(mine, 4, (m) => api("conversations.replies", { channel: channel("team").id, ts: m.ts, limit: 200 }));
  const out = unanswered.map((m) => ({ m, thread: m.ts, last: m, reason: "No reply yet" }));
  mine.forEach((m, i) => {
    const last = (threads[i]?.messages ?? []).filter(human).at(-1);
    if (last && last.user !== me && last.ts !== m.ts && unread(last.ts, threadMark(threads[i]))) out.push({ m, thread: m.ts, last, reason: "New reply in your thread" });
  });
  await pool([...new Set(out.map((x) => x.last.user))], 4, person);
  return out.filter((x) => !people.get(x.last.user)?.bot).map(({ thread, last, reason }) => ({
    key: `team:${thread}`,
    version: last.ts,
    kind: "team",
    where: `#${channel("team").name}`,
    author: nameOf(last.user),
    reason,
    text: last.text,
    ts: Number(last.ts),
    link: linkFor(base, channel("team").id, last.ts, thread),
  }));
}

// Everything, as { me, items, errors }. A part that fails is reported and the rest still shows.
export async function readSlack() {
  await loadPrivate();
  const auth = await api("auth.test");
  const me = auth.user_id;
  const base = auth.url; // https://<workspace>.slack.com/
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * DAY;
  const errors = [];
  const safe = (label, p) => p.catch((e) => { errors.push(`${label}: ${e?.message ?? e}`); return []; });
  const mark = readMarks();
  const [d, men, al] = await Promise.all([safe("DMs", dms(me, since, mark)), safe("Mentions", mentions(me, since, base, mark)), safe("Alerts", alerts(since, base, mark))]);
  const skip = new Set(men.map((x) => x.key.replace(/^mention:/, "")));
  const tm = await safe("Team", team(me, base, skip, mark));
  // Names of people mentioned in the text, so it reads as Slack shows it.
  const all = [...d, ...men, ...al, ...tm];
  await pool([...new Set(all.flatMap((x) => mentionIds(x.text)))].filter((id) => !people.has(id)), 4, person);
  for (const x of all) x.text = clip(plain(x.text));
  return { me, items: all.sort((a, b) => b.ts - a.ts), errors };
}
