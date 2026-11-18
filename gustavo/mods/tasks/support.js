// Support hero: the PostHog support tickets assigned to Team Feature Flags that aren't resolved,
// read through PostHog's MCP server (posthog-mcp.py: a personal API key from the keychain,
// read-only). The list comes from the saved view "Flags Support Hero" (assignee = the Team
// Feature Flags role), resolved ones left out. Tickets on the customer (pending, on hold) keep
// the view's own date window (last 7 days); new and open ones, which wait on the team, show
// whatever their age. Each ticket's details (customer, subject, tags, SLA) are asked
// for again only when the ticket changed. The top part of the tasks mod reads it every few
// minutes and shares it as "tasks.support".

import { exec, appHome } from "herdr";
import { PRIVATE, PRIVATE_FILE, loadPrivate } from "./private.js";

// The PostHog project and saved view, the rotation's schedule and your Slack user: private settings.
const sup = () => PRIVATE.support ?? {};
// The view in PostHog, or null before the private settings are read.
export const viewUrl = () => (sup().project && sup().view ? `${sup().project}/support/tickets?view=${sup().view}` : null);
const ticketUrl = (id) => `${sup().project}/support/tickets/${id}`;
// The schedule in incident.io, or null before the private settings are read.
export const scheduleUrl = () => (sup().heroSchedule ? `https://app.incident.io/posthog/on-call/schedules/${sup().heroSchedule}` : null);

// The MCP call failed. code: "no_token" (nothing in the keychain), "auth" (PostHog refused the
// key), "scope" (the key lacks ticket:read), "network", "http", or "error".
export class SupportError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.code = code;
  }
}

async function mcp(args) {
  const r = await exec("/usr/bin/python3", ["-I", `${appHome()}/mods/tasks/posthog-mcp.py`, ...args], { timeout: 28000 });
  if (r.code !== 0) throw new SupportError(r.stderr.trim() || `posthog-mcp.py exited ${r.code}`);
  const body = JSON.parse(r.stdout);
  if (!body.ok) throw new SupportError(body.error, body.code);
  return body;
}

// Details by ticket id, kept for the life of the mod: { updated, detail }.
const details = new Map();

const plain = (s) => String(s ?? "").replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1").replace(/\s+/g, " ").trim();

// The open tickets, newest activity first: [{ key, version, id, number, status, priority,
// channel, unread, messages, last, customer, email, subject, tags, slaDue, created, updated, url }].
export async function readTickets() {
  await loadPrivate();
  const VIEW = sup().view;
  if (!VIEW || !sup().project) throw new SupportError(PRIVATE.error ?? `No support "project" and "view" in ${PRIVATE_FILE}`);
  const lists = await mcp(["--batch", JSON.stringify([
    ["conversations-tickets-list", { view: VIEW, status: "new,open", date_from: "all", limit: 100 }],
    ["conversations-tickets-list", { view: VIEW, status: "pending,on_hold", limit: 100 }],
  ])]);
  const failed = lists.results.find((r) => !r.ok);
  if (failed) throw new SupportError(failed.error);
  const byId = new Map(lists.results.flatMap((r) => r.result?.results ?? []).map((t) => [t.id, t]));
  const tickets = [...byId.values()];
  const stale = tickets.filter((t) => details.get(t.id)?.updated !== t.updated_at);
  if (stale.length) {
    const batch = await mcp(["--batch", JSON.stringify(stale.map((t) => ["conversations-tickets-retrieve", { id: t.id }]))]);
    stale.forEach((t, i) => {
      const r = batch.results[i];
      if (r?.ok) details.set(t.id, { updated: t.updated_at, detail: r.result });
    });
  }
  return tickets.map((t) => {
    const d = details.get(t.id)?.detail ?? {};
    const who = d.anonymous_traits ?? {};
    return {
      key: `support:${t.id}`,
      version: t.updated_at,
      id: t.id,
      number: t.ticket_number,
      status: t.status,
      priority: t.priority,
      channel: t.channel_source,
      unread: t.unread_team_count ?? 0,
      messages: t.message_count ?? 0,
      last: plain(t.last_message_text).slice(0, 400),
      customer: who.name || d.person?.name || who.email || d.email_from || d.distinct_id || "",
      email: who.email || d.email_from || "",
      subject: plain(d.email_subject),
      tags: (d.tags ?? []).filter((x) => !/^ai-task:|^classified_by_workflow$/.test(x)),
      slaDue: d.sla_due_at ? Date.parse(d.sla_due_at) : null,
      created: Date.parse(t.created_at),
      updated: Date.parse(t.updated_at),
      url: ticketUrl(t.id),
    };
  }).sort((a, b) => b.updated - a.updated);
}

// Waits on the team: a new ticket, or one where the customer wrote and nobody on the team has read it.
export const needsTeam = (x) => x.status === "new" || x.unread > 0;

// ---- the rotation ----

// Team Feature Flags' support hero schedule in incident.io and you, as incident.io knows you from
// Slack: "heroSchedule" and "slackUser" in the private settings.

export class HeroError extends SupportError {}

let myEmail = null;

// The shifts from now on, a person's back-to-back entries joined: [{ name, me, start, end }] (ms).
export async function readShifts() {
  await loadPrivate();
  if (!sup().heroSchedule) throw new HeroError(PRIVATE.error ?? `No support "heroSchedule" in ${PRIVATE_FILE}`);
  if (myEmail === null) {
    const r = await exec("git", ["config", "--global", "user.email"]).catch(() => null);
    myEmail = (r?.stdout ?? "").trim().toLowerCase();
  }
  const r = await exec("/usr/bin/python3", ["-I", `${appHome()}/mods/tasks/incident-oncall.py`, sup().heroSchedule, "35"], { timeout: 25000 });
  if (r.code !== 0) throw new HeroError(r.stderr.trim() || `incident-oncall.py exited ${r.code}`);
  const body = JSON.parse(r.stdout);
  if (!body.ok) throw new HeroError(body.error, body.code);
  const shifts = [];
  for (const e of body.entries) {
    const me = (Boolean(sup().slackUser) && e.slack_user_id === sup().slackUser) || (Boolean(myEmail) && e.email?.toLowerCase() === myEmail);
    const s = { name: e.name, me, start: Date.parse(e.start), end: Date.parse(e.end) };
    const prev = shifts[shifts.length - 1];
    if (prev && prev.name === s.name && prev.me === s.me && prev.end >= s.start) prev.end = Math.max(prev.end, s.end);
    else shifts.push(s);
  }
  return shifts;
}

// From the shifts, at `now`: who's hero, whether it's you, until when, and your next turn.
export function heroAt(shifts, now = Date.now()) {
  const current = (shifts ?? []).find((s) => s.start <= now && now < s.end) ?? null;
  const next = (shifts ?? []).find((s) => s.me && s.start > now) ?? null;
  return { current, me: Boolean(current?.me), until: current?.end ?? null, nextMine: next };
}
