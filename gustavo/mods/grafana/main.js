// grafana: PostHog's Grafana dashboards, drawn natively (no web view here).
//
// Two parts:
// - "view": a main-area view (block "grafana" in the main-stack, picked in the sidebar switcher).
//   Feature flags dashboards on the left; the picked one's panels on the right, each query run
//   through Grafana's datasource proxy and drawn as lines (time series) or a number (stat, gauge).
//   Rows keep the dashboard's folded state; a folded row's panels aren't queried.
// - "flags" (the default): the right sidebar's block above hogli. The /flags service's main numbers
//   from its main dashboard (FLAG_METRICS), each with the last hour as a sparkline, coloured
//   by the dashboard's thresholds. Shares how many are bad as "grafana.health" for the switcher.
//   US, EU or Both: with Both, each tile shows the two regions' numbers and lines side by side.
//
// Grafana is reached by ./grafana.py (token from the keychain, as the Grafana MCP wrapper does).
// Shared "grafana.region" ("us" | "eu") is the view's region; "grafana.flags.region"
// ("us" | "eu" | "both") is the flags block's, and follows the view's until picked.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, readTextFile, shared, setShared, run, theme, layout, props, notify, nextCommand } from "herdr";

const REGION = "grafana.region";
const FLAGS_REGION = "grafana.flags.region";
const HEALTH = "grafana.health"; // shared: { bad, warn, region, at } from the flags block (region: its pick)
const VIEW = "grafana.view"; // shared: { uid } a dashboard the view should show (set by the flags block)
const STACK = "main-stack";
const BLOCK = "flags"; // the flags block's id in the layout (hogli's column)
const HOGLI_COLUMN = "hogli";
const ICON = (name) => `mods/grafana/icons/${name}.svg`;
const RANGES = [["1h", 3600], ["6h", 6 * 3600], ["24h", 86400], ["7d", 7 * 86400]];
const VIEW_REFRESH_MS = 60000;
const FLAGS_REFRESH_MS = 30000;
const FLAGS_RANGE_S = 3600;
const FLAGS_STEP_S = 60;
const LIST_W = 248;
const RAIL_PX = 160; // narrower than this, the column is hogli's folded rail
const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null));

// ---- the private settings ----

// Where the flags service runs and which dashboards are its own name PostHog's infrastructure, so
// they live in the private settings file, kept out of the repo (data/gustavo/private.json):
//   "grafana": {
//     "web": { us, eu }, "api": { us, eu },      the browser's (SSO) and grafana.py's addresses
//     "selectors": { "envoy": str, "pods": str }, PromQL label matchers for the service's envoy
//                                                 cluster and its pods
//     "dashboards": { "home": uid, "tag": str, "search": [str] } the main dashboard, the tag of the
//                                                 view's list, and titles searched for besides
//   }
// Read until it's there; a part that needs it shows what's missing.
const PRIVATE = "data/gustavo/private.json";
const NEEDED = ["selectors.envoy", "selectors.pods", "dashboards.home", "dashboards.tag"];
let settings = null;
async function grafanaSettings() {
  if (settings) return settings;
  const g = JSON.parse((await readTextFile(`${appHome()}/${PRIVATE}`)) ?? "{}").grafana ?? {};
  const missing = NEEDED.filter((k) => !k.split(".").reduce((o, x) => o?.[x], g));
  if (missing.length) throw new Error(`Missing in ${PRIVATE}: ${missing.map((k) => `grafana.${k}`).join(", ")}`);
  settings = g;
  return settings;
}

// ---- the /flags service at a glance (queries from its main dashboard) ----

// up: higher is better (colour flips). warn/bad: where the colour changes. expr(s): the query, from
// the private selectors s ({ envoy, pods }). Shown two per row, in this order.
const FLAG_METRICS = [
  { id: "success", label: "Success rate", unit: "percentunit", up: true, warn: 0.99, bad: 0.9,
    expr: (s) => `(sum(increase(envoy_cluster_upstream_rq{${s.envoy}, envoy_response_code=~"(2|3).."}[5m]))+1 or on() vector(1)) / (((sum(increase(envoy_cluster_upstream_rq{${s.envoy}, envoy_response_code!="429"}[5m])) or vector(0)) + (sum(increase(envoy_cluster_upstream_cx_connect_timeout{${s.envoy}}[5m])) or vector(0))) + 1)` },
  // As "Success rate", but no 4xx counts against it: the server's own failures only.
  { id: "server-success", label: "Server success rate", unit: "percentunit", up: true, warn: 0.999, bad: 0.99,
    expr: (s) => `(sum(increase(envoy_cluster_upstream_rq{${s.envoy}, envoy_response_code=~"(2|3).."}[5m]))+1 or on() vector(1)) / (((sum(increase(envoy_cluster_upstream_rq{${s.envoy}, envoy_response_code!~"4.."}[5m])) or vector(0)) + (sum(increase(envoy_cluster_upstream_cx_connect_timeout{${s.envoy}}[5m])) or vector(0))) + 1)` },
  { id: "rps", label: "Requests", unit: "reqps", expr: (s) => `sum(rate(envoy_cluster_upstream_rq{${s.envoy}}[2m]))` },
  { id: "p99", label: "P99 latency", unit: "ms", warn: 300, bad: 600,
    expr: (s) => `histogram_quantile(0.99, sum by (le) (rate(envoy_cluster_upstream_rq_time_bucket{${s.envoy}}[2m])))` },
  { id: "p50", label: "P50 latency", unit: "ms", warn: 100, bad: 300,
    expr: (s) => `histogram_quantile(0.50, sum by (le) (rate(envoy_cluster_upstream_rq_time_bucket{${s.envoy}}[2m])))` },
  { id: "errors", label: "5xx (5m)", unit: "short", warn: 50, bad: 300,
    expr: (s) => `sum(increase(envoy_cluster_upstream_rq{${s.envoy}, envoy_response_code=~"5.."}[5m])) or vector(0)` },
  { id: "cpu", label: "CPU / requests", unit: "percent", warn: 80, bad: 100,
    expr: (s) => `100 * sum(rate(container_cpu_usage_seconds_total{${s.pods}, container!~"POD|"}[2m])) / sum(median by (pod, container) (kube_pod_container_resource_requests{resource=~"cpu", ${s.pods}, container!~"POD|"} * on(pod, container) group_left() (median by (pod, container)(kube_pod_container_status_ready))))` },
  // Active over the pool limit, summed across pods, for the busiest pool. flags_pool_utilization_ratio
  // divides by open connections instead, so its max across pods is nearly always 1.
  { id: "pool", label: "DB pool", unit: "percentunit", warn: 0.8, bad: 0.95,
    expr: () => `max(sum by (pool) (flags_db_connection_pool_active_total) / sum by (pool) (flags_db_connection_pool_max_total))` },
  { id: "pods", label: "Pods", unit: "short",
    expr: (s) => `count(count by (pod) (kube_pod_info{${s.pods}}))` },
];

// ---- talking to Grafana ----

async function grafana(region, verb, arg, timeout = 60000) {
  const r = await exec("/usr/bin/python3", ["-I", `${appHome()}/mods/grafana/grafana.py`, region, verb, arg], { timeout });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `grafana.py exited with ${r.code}`);
  const out = JSON.parse(r.stdout);
  if (out && typeof out.error === "string" && Object.keys(out).length === 1) throw new Error(out.error);
  return out;
}

const regionOf = () => (shared(REGION) === "eu" ? "eu" : "us");
const flagsPickOf = () => (["us", "eu", "both"].includes(shared(FLAGS_REGION)) ? shared(FLAGS_REGION) : regionOf());
const regionsOf = (pick) => (pick === "both" ? ["us", "eu"] : [pick]);
const pickLabel = (pick) => (pick === "both" ? "US + EU" : String(pick).toUpperCase());
// The browser goes through Grafana's web address (SSO), the API through grafana.py. path: a string,
// or a function of the private settings that gives one.
function openInBrowser(region, path) {
  grafanaSettings()
    .then((g) => {
      const web = g.web?.[region];
      if (!web) throw new Error(`No Grafana web address for ${region} in ${PRIVATE}`);
      return exec("open", [`${web.replace(/\/$/, "")}${typeof path === "function" ? path(g) : path}`]);
    })
    .then((r) => { if (r.code !== 0) throw new Error(r.stderr.trim() || `open exited with ${r.code}`); })
    .catch((e) => notify({ title: "Couldn't open Grafana", body: String(e?.message ?? e), level: "error" }));
}

// Grafana's own variables, and the dashboard's at their saved values ("All" matches anything).
function expand(expr, vars, step, range) {
  const builtin = {
    __rate_interval: `${Math.max(4 * step, 60)}s`, __interval: `${step}s`, __interval_ms: String(step * 1000),
    __range: `${range}s`, __range_s: String(range), __range_ms: String(range * 1000),
  };
  return expr.replace(/\$\{(\w+)(?::[^}]*)?\}|\$(\w+)|\[\[(\w+)\]\]/g, (m, a, b, c) => {
    const k = a ?? b ?? c;
    return builtin[k] ?? vars[k] ?? m;
  });
}

function dashboardVars(dash) {
  const vars = {};
  for (const v of dash.templating?.list ?? []) {
    let cur = v.current?.value;
    const all = v.allValue || ".*";
    if (Array.isArray(cur)) cur = cur.includes("$__all") ? all : cur.length > 1 ? `(${cur.join("|")})` : cur[0];
    if (cur === "$__all" || cur === undefined || cur === null || cur === "") cur = v.type === "datasource" ? "victoriametrics" : all;
    vars[v.name] = String(cur);
  }
  return vars;
}

const CHARTS = new Set(["timeseries", "graph"]);
const NUMBERS = new Set(["stat", "gauge", "bargauge"]);

// The dashboard as rows and panels in reading order: { rows: [{ id, title, collapsed, panels }] }.
// Panels before the first row sit in an untitled one.
function parseDashboard(dash) {
  const vars = dashboardVars(dash);
  const byPos = (a, b) => (a.gridPos?.y ?? 0) - (b.gridPos?.y ?? 0) || (a.gridPos?.x ?? 0) - (b.gridPos?.x ?? 0);
  const dsOf = (d) => {
    const uid = typeof d === "string" ? d : d?.uid;
    if (!uid || uid === "-- Mixed --" || uid === "-- Dashboard --") return "victoriametrics";
    return uid.startsWith("$") ? expand(uid, vars, 60, 3600) : uid;
  };
  const panelOf = (p) => {
    const promDs = (d) => !d || typeof d === "string" || !d.type || d.type === "prometheus" || d.type === "datasource";
    const targets = (p.targets ?? []).filter((x) => x.expr && !x.hide && promDs(x.datasource ?? p.datasource))
      .map((x) => ({ ref: x.refId ?? "A", expr: x.expr, legend: x.legendFormat ?? "", ds: dsOf(x.datasource ?? p.datasource) }));
    const d = p.fieldConfig?.defaults ?? {};
    return {
      id: p.id, title: p.title ?? "", type: p.type, description: p.description ?? "",
      w: p.gridPos?.w ?? 12, h: p.gridPos?.h ?? 8,
      unit: d.unit ?? "short", decimals: d.decimals, min: d.min, max: d.max,
      steps: d.thresholds?.steps ?? [],
      targets, drawn: targets.length > 0 && (CHARTS.has(p.type) || NUMBERS.has(p.type)),
    };
  };
  const rows = [];
  let row = { id: "top", title: "", collapsed: false, panels: [] };
  for (const p of [...(dash.panels ?? [])].sort(byPos)) {
    if (p.type === "row") {
      if (row.panels.length || row.title) rows.push(row);
      row = { id: String(p.id), title: p.title ?? "", collapsed: Boolean(p.collapsed), panels: [...(p.panels ?? [])].sort(byPos).map(panelOf) };
    } else row.panels.push(panelOf(p));
  }
  if (row.panels.length || row.title) rows.push(row);
  return { vars, rows };
}

// ---- numbers ----

function num(v, digits = 3) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toPrecision(digits)}B`;
  if (a >= 1e6) return `${(v / 1e6).toPrecision(digits)}M`;
  if (a >= 1e3) return `${(v / 1e3).toPrecision(digits)}k`;
  if (a === 0) return "0";
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 0.01) return v.toFixed(2).replace(/\.?0+$/, "");
  return v.toPrecision(2);
}

function pct(v) {
  // 99.99% and 100% are different stories here: keep two decimals near the top.
  return `${v >= 99 && v < 100 ? (Math.floor(v * 100) / 100).toFixed(2) : num(v)}%`;
}

function fmt(v, unit) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  switch (unit) {
    case "percentunit": return pct(v * 100);
    case "percent": return pct(v);
    case "ms": return Math.abs(v) >= 1000 ? `${num(v / 1000)} s` : `${num(v)} ms`;
    case "s": return Math.abs(v) < 1 && v !== 0 ? `${num(v * 1000)} ms` : `${num(v)} s`;
    case "µs": return Math.abs(v) >= 1000 ? `${num(v / 1000)} ms` : `${num(v)} µs`;
    case "bytes": case "decbytes": {
      const units = ["B", "KiB", "MiB", "GiB", "TiB"];
      let i = 0, x = v;
      while (Math.abs(x) >= 1024 && i < units.length - 1) { x /= 1024; i++; }
      return `${num(x)} ${units[i]}`;
    }
    case "reqps": return `${num(v)}/s`;
    case "ops": return `${num(v)} ops/s`;
    default: return num(v);
  }
}

const lastValue = (series) => {
  for (let i = (series?.values?.length ?? 0) - 1; i >= 0; i--) {
    const v = parseFloat(series.values[i][1]);
    if (Number.isFinite(v)) return v;
  }
  return null;
};

// "ok" | "warn" | "bad" | null for a flags metric.
function level(m, v) {
  if (v === null || m.warn === undefined) return null;
  if (m.up) return v < m.bad ? "bad" : v < m.warn ? "warn" : "ok";
  return v >= m.bad ? "bad" : v >= m.warn ? "warn" : "ok";
}

// A Grafana threshold colour, as ours.
function stepLevel(steps, v) {
  if (v === null || !steps?.length) return null;
  let color = null;
  for (const s of steps) if (s.value === null || s.value === undefined || v >= s.value) color = String(s.color ?? "");
  if (!color) return null;
  if (/red|e24d42|f2495c|c4162a/i.test(color)) return "bad";
  if (/orange|yellow|f9934e|ff9830|fade2a|eab839/i.test(color)) return "warn";
  if (/green|629e51|73bf69|56a64b/i.test(color)) return "ok";
  return null;
}

const levelColor = (t, l) => ({ ok: t.ansi2, warn: t.ansi3, bad: t.ansi1 }[l] ?? t.foreground);
const regionColor = (t, r) => (r === "eu" ? t.ansi6 : t.accent); // a region's line when both show
const palette = (t) => [t.ansi4, t.ansi2, t.ansi3, t.ansi5, t.ansi6, t.ansi1, t.accent, t.ansi12, t.ansi10, t.ansi11, t.ansi13, t.ansi14].filter(Boolean);
const alpha = (color, hex) => (/^#[0-9a-f]{6}$/i.test(color) ? color + hex : color);

function legendOf(target, metric, title) {
  if (target.legend && target.legend !== "__auto") return target.legend.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => metric?.[k] ?? "");
  const labels = Object.entries(metric ?? {}).filter(([k]) => k !== "__name__");
  return labels.length ? labels.map(([k, v]) => `${k}=${v}`).join(", ") : title;
}

const ago = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60000)}m ago`);

// ---- drawing ----

// Lines over [start, end], scaled to the data (from 0 for data that never goes below it), as paths
// whose coordinates are percentages of the painted box: built once per data, they follow the
// box's size, so a render only paints them. Each line keeps at most MAX_POINTS points.
const MAX_POINTS = 160;
const THRESHOLD = /^\s*(vector\(\s*[\d.]+\s*\)|[\d.]+)\s*$/;
const MAX_LINES = 16; // a panel's lines drawn, at most (a topk(10) panel fits)
function buildChart(lines, { start, end, fill = false, min: fixedMin, max: fixedMax }) {
  let lo = Infinity, hi = -Infinity;
  for (const l of lines) for (const [, v] of l.points) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return null;
  if (lo >= 0) lo = 0;
  if (Number.isFinite(fixedMin)) lo = fixedMin;
  if (Number.isFinite(fixedMax) && fixedMax > lo) hi = Math.max(hi, fixedMax);
  if (hi === lo) hi = lo + (Math.abs(lo) || 1);
  hi += (hi - lo) * 0.06; // the top line isn't drawn on the edge
  const span = end - start || 1;
  const X = (ts) => `${Math.min(100, Math.max(0, ((ts - start) / span) * 100)).toFixed(2)}%`;
  const Y = (v) => `${((1 - (v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
  const shapes = [];
  lines.forEach((l, i) => {
    let pts = l.points;
    if (pts.length < 2) return;
    const every = Math.ceil(pts.length / MAX_POINTS);
    if (every > 1) pts = pts.filter((_, j) => j % every === 0 || j === pts.length - 1);
    let b = PathBuilder.stroke(i === 0 && fill ? 1.5 : 1.25);
    if (l.threshold) b = b.dash_array([4, 3]);
    let pen = false;
    let prev = null;
    for (const [ts, v] of pts) {
      // A gap of more than 3 steps is a gap in the data: lift the pen.
      if (pen && prev !== null && ts - prev > 3 * every * (l.step ?? 60)) pen = false;
      b = pen ? b.line_to(X(ts), Y(v)) : b.move_to(X(ts), Y(v));
      pen = true;
      prev = ts;
    }
    if (fill && i === 0) {
      const area = pts.map(([ts, v]) => [X(ts), Y(v)]);
      area.push([X(pts[pts.length - 1][0]), "100%"], [X(pts[0][0]), "100%"]);
      shapes.push({ line: i, fill: true, path: PathBuilder.fill().add_polygon(area, true).build() });
    }
    shapes.push({ line: i, fill: false, path: b.build() });
  });
  return { lo, hi, shapes };
}

// colorOf(line index) is a theme colour, read at render so the chart follows the theme.
function drawChart(t, built, colorOf, { h, axis = false, unit = "short" }) {
  if (!built) return div().h(h).w_full();
  return div().relative().w_full().h(h)
    .when(axis, (el) => el
      .child(div().absolute().top_0().left_0().right_0().h(1).bg(alpha(t.border, "80")))
      .child(div().absolute().bottom_0().left_0().right_0().h(1).bg(t.border))
      .child(div().absolute().top(2).left(2).text_size(9.5).text_color(t.dim).child(fmt(built.hi, unit)))
      .child(div().absolute().bottom(2).left(2).text_size(9.5).text_color(t.dim).child(fmt(built.lo, unit))))
    .children(built.shapes.map((s) => window.paint_path(s.path, s.fill ? alpha(colorOf(s.line), "26") : colorOf(s.line))
      .absolute().top_0().left_0().size_full()));
}

const pointsOf = (series) => (series.values ?? [])
  .map(([ts, v]) => [Number(ts), parseFloat(v)])
  .filter(([, v]) => Number.isFinite(v));

export default class Grafana extends View {
  init(_props, cx) {
    this.part = props()?.part ?? "flags";
    this.width = 400;
    this.loading = false;
    this.error = null;
    this.at = 0;
    if (this.part === "view") return this.initView(cx);
    this.pick = flagsPickOf(); // "us" | "eu" | "both"
    this.values = {}; // region → metric id → { value } | { error }
    this.errors = {}; // region → why its query failed
    this.charts = {}; // metric id → built chart, one line per region in regionsOf(pick) order
    this.refreshFlags(cx);
    cx.timer.every(FLAGS_REFRESH_MS, (cx) => this.refreshFlags(cx));
    cx.timer.every(1000, (cx) => this.followPick(cx));
    // "grafana.flags-us" | "grafana.flags-eu" | "grafana.flags-both" (for keys) pick the region.
    cx.spawn(async (cx) => {
      for (;;) {
        const m = /^flags-(us|eu|both)$/.exec(await nextCommand());
        if (m) { setShared(FLAGS_REGION, m[1]); this.followPick(cx); }
      }
    });
    cx.timer.every(10000, (cx) => cx.notify()); // "… ago"
  }

  setRegion(region, cx) {
    setShared(REGION, region);
    this.followRegion(cx);
  }

  // The view's region changed (here, or from a flags tile): start over with its data.
  followRegion(cx) {
    if (regionOf() === this.region) return;
    this.region = regionOf();
    this.at = 0;
    this.error = null;
    this.data = {}; this.cards = {};
    this.listError = null;
    this.loadDashboards(cx);
    this.load(cx);
    cx.notify();
  }

  // The flags block's pick changed (or, unpicked, the view's region): start over with its data.
  followPick(cx) {
    if (flagsPickOf() === this.pick) return;
    this.pick = flagsPickOf();
    this.at = 0;
    this.values = {}; this.errors = {}; this.charts = {};
    this.refreshFlags(cx);
    cx.notify();
  }

  // options: [[value, label]]; onPick(value, cx).
  chips(t, prefix, options, now, onPick) {
    return h_flex().gap(2).p(2).rounded(6).bg(t.surface).border_1().border_color(t.border)
      .children(options.map(([value, label]) => div().id(`${prefix}-region-${value}`).px(6).h(18).flex().items_center().rounded(4).cursor_pointer()
        .text_size(10.5).font_medium()
        .bg(now === value ? t.selected : "#00000000").text_color(now === value ? t.foreground : t.dim)
        .hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => onPick(value, cx))
        .child(label)));
  }

  iconButton(t, id, icon, tip, onClick) {
    return div().id(id).p(3).rounded(5).cursor_pointer().text_color(t.dim)
      .hover((x) => x.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => onClick(cx))
      .child(svg(ICON(icon)).size(13));
  }

  // ---- the flags block ----

  refreshFlags(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    const pick = this.pick;
    const regions = regionsOf(pick);
    const end = Math.floor(Date.now() / 1000 / FLAGS_STEP_S) * FLAGS_STEP_S;
    cx.spawn(async (cx) => {
      try {
        const { selectors } = await grafanaSettings();
        const spec = { start: end - FLAGS_RANGE_S, end, step: FLAGS_STEP_S, queries: FLAG_METRICS.map((m) => ({ id: m.id, expr: m.expr(selectors), ds: "victoriametrics" })) };
        // Each region answers on its own: one that can't be reached doesn't hide the other.
        const outs = await Promise.all(regions.map((r) => grafana(r, "query", JSON.stringify(spec))
          .then((out) => ({ out }), (e) => ({ error: String(e?.message ?? e) }))));
        if (pick !== this.pick) return;
        const values = {}, errors = {}, charts = {};
        regions.forEach((r, i) => {
          if (outs[i].error) errors[r] = outs[i].error;
          values[r] = {};
          for (const m of FLAG_METRICS) {
            const q = outs[i].out?.[m.id];
            values[r][m.id] = q?.error ? { error: q.error } : { value: q?.series?.[0] ? lastValue(q.series[0]) : null };
          }
        });
        // One chart per metric, a line per region on one scale; a lone region's is filled.
        for (const m of FLAG_METRICS) {
          const lines = outs.map((o) => {
            const s = o.out?.[m.id]?.series?.[0];
            return { points: s ? pointsOf(s) : [], step: FLAGS_STEP_S };
          });
          charts[m.id] = buildChart(lines, { start: spec.start, end: spec.end, fill: regions.length === 1 });
        }
        this.values = values;
        this.errors = errors;
        this.charts = charts;
        this.at = Date.now();
        const levels = regions.filter((r) => !errors[r]).flatMap((r) => FLAG_METRICS.map((m) => level(m, values[r][m.id]?.value ?? null)));
        setShared(HEALTH, Object.keys(errors).length === regions.length ? null
          : { region: pick, bad: levels.filter((l) => l === "bad").length, warn: levels.filter((l) => l === "warn").length, at: this.at });
      } catch (e) {
        this.errors = Object.fromEntries(regions.map((r) => [r, String(e?.message ?? e)]));
        setShared(HEALTH, null);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.again) { this.again = false; this.refreshFlags(cx); }
      }
    });
  }

  showView(uid) {
    if (uid) setShared(VIEW, { uid });
    run("layout.select", { stack: STACK, child: "grafana" });
    run("layout.hide", { id: "tabs" });
  }

  // The flags dashboard in the view, in this block's region when it shows one.
  openGeneral() {
    if (this.pick !== "both") setShared(REGION, this.pick);
    grafanaSettings().then((g) => this.showView(g.dashboards.home), () => this.showView());
  }

  tile(t, m) {
    const regions = regionsOf(this.pick);
    const both = regions.length > 1;
    const cells = regions.map((r) => {
      const d = this.values[r]?.[m.id];
      const v = d?.value ?? null;
      return { r, error: this.errors[r] ?? d?.error, v, l: level(m, v) };
    });
    const worst = cells.some((c) => c.l === "bad") ? "bad" : cells.some((c) => c.l === "warn") ? "warn" : null;
    const failed = cells.filter((c) => c.error);
    const value = (c, size) => div().text_size(size).font_semibold().truncate()
      .text_color(c.error ? t.dim : levelColor(t, c.l)).child(c.error ? "error" : fmt(c.v, m.unit));
    // Alone, a line takes its number's colour; side by side, each its region's (as its label).
    const lineColor = (i) => (both ? regionColor(t, regions[i])
      : cells[0].l === "bad" || cells[0].l === "warn" ? levelColor(t, cells[0].l) : t.accent);
    return v_flex().id(`gf-tile-${m.id}`).flex_1().min_w(0).p(8).gap(2).rounded(8).bg(t.surface).border_1()
      .border_color(worst === "bad" ? alpha(t.ansi1, "99") : t.border).cursor_pointer()
      .hover((x) => x.border_color(t.accent))
      .tooltip(failed.length ? failed.map((c) => `${m.label}${both ? ` (${c.r.toUpperCase()})` : ""}: ${c.error}`).join("\n")
        : `${m.label}, last hour. Open the dashboard`)
      .on_click(() => this.openGeneral())
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(m.label))
        .when(Boolean(worst), (el) => el.child(div().size(6).rounded(3).bg(levelColor(t, worst)))))
      .when(!both, (el) => el.child(value(cells[0], 16)))
      .when(both, (el) => el.child(h_flex().gap(8).items_center()
        .children(cells.map((c) => h_flex().flex_1().min_w(0).gap(4).items_center()
          .child(div().flex_none().text_size(9.5).font_medium().text_color(regionColor(t, c.r)).child(c.r.toUpperCase()))
          .child(value(c, 13.5))))))
      .child(drawChart(t, this.charts[m.id], lineColor, { h: 26 }));
  }

  renderFlags(t) {
    const open = localStorage.getItem("open:flags") !== "0";
    const health = shared(HEALTH);
    const worst = health?.bad ? "bad" : health?.warn ? "warn" : health ? "ok" : null;
    const root = (el) => el.id("gf-root").on_size_change((size, cx) => {
      if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); }
      const px = Math.ceil(size.height);
      if (Math.abs(px - (this.fitPx ?? 0)) >= 1) { this.fitPx = px; run("layout.resize", { id: BLOCK, px }); }
    });
    // hogli's folded rail: one icon, coloured by the worst number.
    if (this.width < RAIL_PX) {
      return root(v_flex().w_full().pt(10).pb(8).items_center().bg(t.chrome).border_b_1().border_color(t.border)
        .child(div().id("gf-rail").p(5).rounded(6).cursor_pointer().hover((x) => x.bg(t.raised))
          .tooltip(health ? `Flags (${pickLabel(health.region)}): ${health.bad} bad, ${health.warn} warning` : "Flags metrics")
          .on_click(() => run("layout.resize", { id: HOGLI_COLUMN, px: Number(shared("right.width")) || 480 }))
          .child(svg(ICON("chart")).size(15).text_color(worst ? levelColor(t, worst) : t.dim))));
    }
    const rows = [];
    for (let i = 0; i < FLAG_METRICS.length; i += 2) rows.push(FLAG_METRICS.slice(i, i + 2));
    const regions = regionsOf(this.pick);
    const errors = regions.filter((r) => this.errors[r]).map((r) => (regions.length > 1 ? `${r.toUpperCase()}: ${this.errors[r]}` : this.errors[r]));
    return root(v_flex().w_full().bg(t.chrome).border_b_1().border_color(t.border).pb(open ? 10 : 2)
      .child(h_flex().id("gf-head").px(12).pt(10).pb(6).gap(6).items_center().cursor_pointer()
        .on_click((_e, cx) => { localStorage.setItem("open:flags", open ? "0" : "1"); cx.notify(); })
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
        .child(svg(ICON("chart")).size(13).flex_none().text_color(worst ? levelColor(t, worst) : t.muted))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Flags"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(this.loading && !this.at ? "loading…" : this.at ? `last hour · ${ago(Date.now() - this.at)}` : ""))
        .child(h_flex().gap(4).items_center().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(this.chips(t, "gf", [["us", "US"], ["eu", "EU"], ["both", "Both"]], this.pick,
            (pick, cx) => { setShared(FLAGS_REGION, pick); this.followPick(cx); }))
          .child(this.iconButton(t, "gf-refresh", "refresh", "Refresh now", (cx) => this.refreshFlags(cx)))
          .child(this.iconButton(t, "gf-view", "chart", "Open the Grafana view", () => this.openGeneral()))
          .child(this.iconButton(t, "gf-open", "external", `Open in Grafana, ${pickLabel(this.pick)} (browser)`,
            () => regions.forEach((r) => openInBrowser(r, (g) => `/d/${g.dashboards.home}?from=now-1h&to=now`))))))
      .when(open && errors.length > 0, (el) => el.child(div().mx(12).p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.ansi1).child(errors.join("\n"))))
      .when(open, (el) => el.child(v_flex().px(12).gap(6)
        .children(rows.map((r, i) => h_flex().id(`gf-row-${i}`).gap(6).children(r.map((m) => this.tile(t, m))))))));
  }

  // ---- the view ----

  initView(cx) {
    this.dashboards = []; // [{ uid, title, folder }]
    this.dash = {}; // `${region}:${uid}` → parsed dashboard
    this.data = {}; // `${panelId}:${ref}` → { series } | { error }
    this.cards = {}; // panelId → digest(): what a panel card draws
    this.uid = localStorage.getItem("uid") || null; // null: the main dashboard, once the settings are read
    this.range = Number(localStorage.getItem("range")) || 6 * 3600;
    this.region = regionOf();
    this.size = { width: 1000, height: 700 };
    this.loadDashboards(cx);
    this.load(cx);
    cx.timer.every(1000, (cx) => {
      const ask = shared(VIEW);
      if (ask?.uid) { setShared(VIEW, null); this.pick(ask.uid, cx); }
      this.followRegion(cx);
      // Fresh while shown: on coming back after a while too, not only every minute.
      if (this.shown() && !this.loading && !this.error && Date.now() - this.at > VIEW_REFRESH_MS) this.load(cx);
    });
    cx.timer.every(10000, (cx) => { if (this.shown()) cx.notify(); }); // "updated … ago"
  }

  shown() { return findNode(layout(), STACK)?.active === "grafana"; }

  pick(uid, cx) {
    if (uid === this.uid) return;
    this.uid = uid;
    localStorage.setItem("uid", uid);
    this.data = {}; this.cards = {};
    this.error = null;
    this.load(cx);
    cx.notify();
  }

  loadDashboards(cx) {
    const region = this.region;
    cx.spawn(async (cx) => {
      try {
        const { dashboards } = await grafanaSettings();
        const found = await Promise.all([
          grafana(region, "get", `/api/search?type=dash-db&tag=${encodeURIComponent(dashboards.tag)}&limit=200`),
          ...(dashboards.search ?? []).map((q) => grafana(region, "get", `/api/search?type=dash-db&query=${encodeURIComponent(q)}`)),
        ]);
        const seen = new Set();
        const list = found.flat().filter((d) => !seen.has(d.uid) && seen.add(d.uid))
          .map((d) => ({ uid: d.uid, title: d.title, folder: d.folderTitle ?? "" }));
        // The service's main dashboard first, then by title.
        const home = dashboards.home;
        list.sort((a, b) => (b.uid === home) - (a.uid === home) || a.title.localeCompare(b.title));
        if (region === this.region) this.dashboards = list;
      } catch (e) {
        if (region === this.region) this.listError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  rowOpen(row) {
    const v = localStorage.getItem(`row:${this.uid}:${row.id}`);
    return v === null || v === undefined ? !row.collapsed : v === "1";
  }

  load(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    const region = this.region, range = this.range;
    cx.spawn(async (cx) => {
      try {
        if (!this.uid) this.uid = (await grafanaSettings()).dashboards.home;
        const uid = this.uid;
        const key = `${region}:${uid}`;
        if (!this.dash[key]) {
          const body = await grafana(region, "get", `/api/dashboards/uid/${encodeURIComponent(uid)}`);
          this.dash[key] = { title: body.dashboard?.title ?? uid, url: body.meta?.url ?? `/d/${uid}`, ...parseDashboard(body.dashboard ?? {}) };
          cx.notify();
        }
        const d = this.dash[key];
        // Enough points for a chart's width, never finer than VictoriaMetrics' 15s.
        const step = Math.max(15, Math.ceil(range / 300 / 15) * 15);
        const end = Math.floor(Date.now() / 1000 / step) * step;
        const queries = [];
        for (const row of d.rows) {
          if (!this.rowOpen(row)) continue;
          for (const p of row.panels) if (p.drawn) for (const tg of p.targets) {
            queries.push({ id: `${p.id}:${tg.ref}`, expr: expand(tg.expr, d.vars, step, range), ds: tg.ds });
          }
        }
        if (queries.length) {
          const out = await grafana(region, "query", JSON.stringify({ start: end - range, end, step, queries }), 180000);
          if (region === this.region && uid === this.uid && range === this.range) {
            this.data = { ...this.data, ...out };
            this.window = { start: end - range, end, step };
            const asked = new Set(queries.map((q) => q.id.split(":")[0]));
            for (const row of d.rows) for (const p of row.panels) if (asked.has(String(p.id))) this.cards[p.id] = this.digest(p);
          }
        }
        this.at = Date.now();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.again) { this.again = false; this.load(cx); }
      }
    });
  }

  dashRow(t, d) {
    const on = d.uid === this.uid;
    return v_flex().id(`gf-dash-${d.uid}`).px(10).py(6).rounded(7).cursor_pointer()
      .bg(on ? t.selected : "#00000000").hover((x) => x.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => this.pick(d.uid, cx))
      .child(div().truncate().text_size(12).font_medium().text_color(on ? t.foreground : t.muted)
        .child(d.title.replace(/^Feature [Ff]lags( - |: | — )?/, "") || d.title))
      .when(Boolean(d.folder) && d.folder !== "Synced", (el) => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(d.folder)));
  }

  // A panel's answers, made ready to draw: its lines' names and last values, the chart's paths
  // (the series as data, never touched by render), and the first error.
  digest(p) {
    const win = this.window;
    const results = p.targets.map((tg) => ({ tg, r: this.data[`${p.id}:${tg.ref}`] }));
    const lines = [];
    for (const { tg, r } of results) for (const s of r?.series ?? []) {
      if (lines.length >= MAX_LINES) break;
      // A constant (vector(600), 0.8) is a threshold drawn next to the data: dashed, after it in the legend.
      lines.push({ name: legendOf(tg, s.metric, p.title), points: pointsOf(s), step: win.step, last: lastValue(s), threshold: THRESHOLD.test(tg.expr) });
    }
    const number = NUMBERS.has(p.type);
    const built = buildChart(number ? lines.slice(0, 1) : lines, { start: win.start, end: win.end, fill: number, min: number ? undefined : p.min, max: number ? undefined : p.max });
    for (const l of lines) delete l.points;
    const legend = lines.map((l, i) => ({ ...l, i }))
      .sort((a, b) => a.threshold - b.threshold || (b.last ?? -Infinity) - (a.last ?? -Infinity)).slice(0, 4);
    return { lines, legend, built, error: results.find((x) => x.r?.error)?.r.error ?? null };
  }

  panelCard(t, p, w) {
    const c = this.cards[p.id];
    const colors = palette(t);
    const colorOf = (i) => colors[i % colors.length];
    const lines = c?.lines ?? [];
    const errors = c?.error ? [c.error] : [];
    const pending = !c;
    const h = Math.min(320, Math.max(NUMBERS.has(p.type) ? 120 : 190, p.h * 26));
    const card = v_flex().id(`gf-p-${p.id}`).w(w).h(h).p(10).gap(6).rounded(9).bg(t.surface).border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(p.title || "Untitled"))
        .when(Boolean(p.description), (el) => el.child(div().id(`gf-pd-${p.id}`).text_size(10.5).text_color(t.dim).tooltip(p.description).child("ⓘ")))
        .child(this.iconButton(t, `gf-po-${p.id}`, "external", "Open this panel in Grafana",
          () => openInBrowser(this.region, `${this.dash[`${this.region}:${this.uid}`]?.url ?? `/d/${this.uid}`}?viewPanel=${p.id}&from=now-${this.rangeLabel()}&to=now`))));
    if (!p.drawn) {
      return card.child(div().flex_1().flex().items_center().justify_center().text_size(11).text_color(t.dim)
        .child(p.type === "text" ? "Text panel" : `${p.type} panels aren't drawn here`));
    }
    if (errors.length && !lines.length) return card.child(div().text_size(11).text_color(t.ansi1).child(errors[0]));
    if (pending) return card.child(div().flex_1().flex().items_center().justify_center().text_size(11).text_color(t.dim).child(this.loading ? "Loading…" : "No data yet"));
    if (!lines.length) return card.child(div().flex_1().flex().items_center().justify_center().text_size(11).text_color(t.dim).child("No data"));
    if (NUMBERS.has(p.type)) {
      const v = lines[0].last;
      const color = levelColor(t, stepLevel(p.steps, v));
      return card
        .child(div().flex_1().flex().items_center().justify_center().text_size(26).font_semibold().text_color(color).child(fmt(v, p.unit)))
        .child(drawChart(t, c.built, () => (stepLevel(p.steps, v) ? color : t.accent), { h: 28 }));
    }
    const legend = c.legend;
    return card
      .child(div().flex_1().min_h(0).child(drawChart(t, c.built, colorOf, { h: h - 20 - 34 - legend.length * 15, axis: true, unit: p.unit })))
      .child(v_flex().gap(1).children(legend.map((l, i) => h_flex().id(`gf-lg-${p.id}-${i}`).gap(6).items_center().text_size(10.5)
        .child(div().size(7).rounded(2).flex_none().bg(colorOf(l.i)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(l.name))
        .child(div().flex_none().text_color(t.foreground).child(fmt(l.last, p.unit))))));
  }

  rangeLabel() { return (RANGES.find(([, s]) => s === this.range) ?? RANGES[1])[0]; }

  renderView(t) {
    const d = this.dash[`${this.region}:${this.uid}`];
    const contentW = Math.max(300, this.size.width - LIST_W - 1 - 32);
    const cardW = (w) => Math.max(160, Math.floor(((contentW + 8) * Math.min(24, w)) / 24) - 8);
    const listed = this.dashboards.length ? this.dashboards : this.uid ? [{ uid: this.uid, title: this.uid, folder: "" }] : [];
    return v_flex().id("gf-view").size_full().bg(t.canvas).rounded(10).border_1().border_color(t.border).overflow_hidden()
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.size.width) < 1 && Math.abs(size.height - this.size.height) < 1) return;
        this.size = size;
        cx.notify();
      })
      .child(h_flex().size_full().min_h(0)
        .child(v_flex().w(LIST_W).flex_none().h_full().bg(t.chrome).border_r_1().border_color(t.border)
          .child(h_flex().px(12).pt(12).pb(8).gap(8).items_center()
            .child(svg(ICON("chart")).size(14).text_color(t.muted))
            .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("Grafana"))
            .child(this.chips(t, "gv", [["us", "US"], ["eu", "EU"]], regionOf(), (r, cx) => this.setRegion(r, cx))))
          .child(div().px(12).pb(6).text_size(10.5).text_color(t.dim).child("Feature flags dashboards"))
          .when(Boolean(this.listError), (el) => el.child(div().mx(12).mb(6).text_size(10.5).text_color(t.ansi1).child(this.listError)))
          .child(v_flex().id("gf-dashes").flex_1().min_h(0).px(6).pb(8).gap(1).overflow_y_scrollbar()
            .children(listed.map((x) => this.dashRow(t, x)))))
        .child(v_flex().flex_1().min_w(0).h_full()
          .child(h_flex().px(16).pt(12).pb(10).gap(10).items_center().border_b_1().border_color(t.border)
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().text_size(14).font_semibold().text_color(t.foreground).child(d?.title ?? listed.find((x) => x.uid === this.uid)?.title ?? this.uid))
              .child(div().text_size(10.5).text_color(this.error ? t.ansi1 : t.dim).truncate()
                .child(this.error ?? (this.loading ? "Loading…" : this.at ? `${this.region.toUpperCase()} · updated ${ago(Date.now() - this.at)} · every minute while shown` : ""))))
            .child(h_flex().gap(2).p(2).rounded(7).bg(t.surface).border_1().border_color(t.border)
              .children(RANGES.map(([label, s]) => div().id(`gf-range-${label}`).px(8).h(22).flex().items_center().rounded(5).cursor_pointer()
                .text_size(11).font_medium().bg(this.range === s ? t.selected : "#00000000").text_color(this.range === s ? t.foreground : t.muted)
                .hover((x) => x.text_color(t.foreground))
                .on_click((_e, cx) => { this.range = s; localStorage.setItem("range", String(s)); this.data = {}; this.cards = {}; this.load(cx); cx.notify(); })
                .child(label))))
            .child(this.iconButton(t, "gf-reload", "refresh", "Refresh now", (cx) => { this.load(cx); cx.notify(); }))
            .child(this.iconButton(t, "gf-browser", "external", "Open in Grafana (browser)",
              () => openInBrowser(this.region, `${d?.url ?? `/d/${this.uid}`}?from=now-${this.rangeLabel()}&to=now`))))
          .child(v_flex().id("gf-panels").flex_1().min_h(0).p(16).gap(10).overflow_y_scrollbar()
            .when(!d, (el) => el.child(div().text_size(12).text_color(t.dim).child(this.error ? "" : "Loading the dashboard…")))
            .when(Boolean(d), (el) => el.children(d.rows.map((row) => this.rowView(t, row, cardW)))))));
  }

  rowView(t, row, cardW) {
    const open = this.rowOpen(row);
    const drawn = row.panels.filter((p) => p.drawn).length;
    return v_flex().gap(8)
      .when(Boolean(row.title), (el) => el.child(h_flex().id(`gf-row-${row.id}`).gap(6).items_center().cursor_pointer()
        .text_color(t.muted).hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => {
          localStorage.setItem(`row:${this.uid}:${row.id}`, open ? "0" : "1");
          if (!open) this.load(cx); // its panels weren't queried while it was folded
          cx.notify();
        })
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).text_color(t.dim))
        .child(div().text_size(12).font_semibold().child(row.title))
        .child(div().text_size(10.5).text_color(t.dim).child(`${row.panels.length} panel${row.panels.length === 1 ? "" : "s"}${drawn < row.panels.length ? `, ${drawn} drawn` : ""}`))))
      .when(open, (el) => el.child(h_flex().flex_wrap().gap(8).children(row.panels.map((p) => this.panelCard(t, p, cardW(p.w))))));
  }

  render(_cx) {
    const t = theme();
    return this.part === "view" ? this.renderView(t) : this.renderFlags(t);
  }
}
