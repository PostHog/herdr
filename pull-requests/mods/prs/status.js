export const DEFAULT_SERVICES = [
  { name: "GitHub", url: "https://www.githubstatus.com" },
  { name: "Trunk", url: "https://status.trunk.io" },
  { name: "Depot", url: "https://status.depot.dev" },
  { name: "Docker", url: "https://www.dockerstatus.com" },
  { name: "npm", url: "https://status.npmjs.org" },
  { name: "PyPI", url: "https://status.python.org" },
  { name: "Claude", url: "https://status.claude.com" },
];

const INDICATOR_LEVEL = { none: "ok", minor: "warn", major: "bad", critical: "bad", maintenance: "info" };
const PAGE_STATUS_LEVEL = { UP: "ok", HASISSUES: "warn", UNDERMAINTENANCE: "info" };
const LEVEL_TEXT = { ok: "All systems operational", warn: "Degraded", bad: "Outage", info: "Under maintenance", unknown: "Status unknown" };
const LEVEL_RANK = { bad: 0, warn: 1, info: 2, unknown: 3, ok: 4 };
const SEVERE_IMPACT = /major|critical|outage/i;

const words = (value) => String(value ?? "").replace(/_/g, " ").toLowerCase();

export function parseSummary(service, body) {
  const indicator = body?.status?.indicator;
  const pageStatus = body?.page?.status;
  const incidents = (body?.incidents ?? body?.activeIncidents ?? []).map((incident) => ({
    name: incident.name ?? "Incident",
    status: words(incident.status),
    impact: words(incident.impact),
    url: incident.shortlink ?? incident.url ?? service.url,
    since: incident.created_at ?? incident.started ?? null,
  }));
  const components = (body?.components ?? [])
    .filter((component) => component.status && component.status !== "operational" && !component.group)
    .map((component) => ({ name: component.name, status: words(component.status) }));
  const maintenance = (body?.scheduled_maintenances ?? body?.activeMaintenances ?? [])
    .filter((item) => !item.status || /in.?progress|verifying/i.test(item.status))
    .map((item) => ({ name: item.name ?? "Maintenance", url: item.shortlink ?? item.url ?? service.url }));
  let level = INDICATOR_LEVEL[indicator] ?? PAGE_STATUS_LEVEL[pageStatus] ?? "unknown";
  if (level === "warn" && incidents.some((incident) => SEVERE_IMPACT.test(incident.impact))) level = "bad";
  if (level === "ok" && incidents.length) level = "warn";
  return {
    name: service.name,
    url: service.url,
    level,
    description: body?.status?.description ?? LEVEL_TEXT[level],
    incidents,
    components,
    maintenance,
  };
}

const unreachable = (service, reason) => ({ name: service.name, url: service.url, level: "unknown", description: `Couldn't read its status page${reason ? ` (${reason})` : ""}`, incidents: [], components: [], maintenance: [] });

async function fetchService(service) {
  try {
    const response = await fetch(`${service.url.replace(/\/+$/, "")}/api/v2/summary.json`);
    if (!response.ok) return unreachable(service, `HTTP ${response.status}`);
    return parseSummary(service, await response.json());
  } catch (error) {
    return unreachable(service, String(error?.message ?? error).slice(0, 80));
  }
}

export async function fetchServices(services = DEFAULT_SERVICES) {
  return { at: Date.now(), services: await Promise.all(services.map(fetchService)) };
}

export function queueService(trunk) {
  if (!trunk) return null;
  const listing = trunk.listing;
  if (!listing) return { name: "Merge queue", url: null, level: "unknown", description: trunk.error ?? "The merge queue isn't available.", incidents: [], components: [], maintenance: [] };
  const running = listing.running === "Running";
  return {
    name: `Merge queue · ${trunk.repo}`,
    url: null,
    level: running ? "ok" : "warn",
    description: running ? `Running on ${listing.branch}` : `${listing.running} on ${listing.branch}`,
    incidents: [],
    components: [],
    maintenance: [],
  };
}

export const isIncident = (service) => service.level === "warn" || service.level === "bad";

export function statusOverview(services) {
  const troubled = services.filter(isIncident).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  const unknown = services.filter((service) => service.level === "unknown").length;
  const level = troubled[0]?.level ?? "ok";
  const title = troubled.length
    ? `${troubled.map((service) => service.name.split(" · ")[0]).join(", ")} ${troubled.length === 1 ? "has" : "have"} an incident`
    : unknown
      ? `No incidents, but ${unknown} status page${unknown === 1 ? "" : "s"} couldn't be read`
      : "All systems operational";
  return { level, title, troubled, sorted: [...services].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) };
}
