const KNOWN = new Set([
  "Signals", "Tickets", "Features", "Memory", "Feature requests", "Team", "Slack context",
  "Internal Slack", "Gong calls", "Call candidates", "Meetings and tasks", "Snapshots",
]);
const OPEN = new Set(["Signals", "Memory"]);
const LABELS = { "This period": "Period", "Warehouse sources": "Sources", "Billing limits": "Limits" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WORDS = { mrr: "MRR", arr: "ARR", ai: "AI", mcp: "MCP", cdp: "CDP", llm: "LLM", usd: "USD", posthog: "PostHog", ff: "flag" };

export function shortDates(s, year) {
  return String(s ?? "").replace(/(?<![\w/=.-])(\d{4})-(\d\d)-(\d\d)(?![\w-])/g, (m, y, mo, d) => {
    const name = MONTHS[Number(mo) - 1];
    if (!name) return m;
    return Number(y) === year ? `${name} ${Number(d)}` : `${name} ${Number(d)}, ${y}`;
  });
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function compact(n, money = false) {
  const a = Math.abs(n);
  const [v, u] = a >= 1e9 ? [n / 1e9, "B"] : a >= 1e6 ? [n / 1e6, "M"] : a >= 1e3 ? [n / 1e3, "k"] : [n, ""];
  const digits = u && Math.abs(v) < 100 ? 1 : u ? 0 : Number.isInteger(n) ? 0 : 2;
  const text = `${Number(v.toFixed(digits))}${u}`;
  return money ? (text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`) : text;
}

function tree(lines) {
  const root = { children: [] };
  const notes = [];
  let container = root;
  let stack = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0 && body.startsWith("## ")) {
      container = { kind: "group", text: body.slice(3).trim(), children: [] };
      root.children.push(container);
      stack = [];
      continue;
    }
    if (indent === 0 && /^_[^_].*_$/.test(body)) {
      notes.push(body.slice(1, -1));
      continue;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : container;
    if (body.startsWith("- ")) {
      const node = { kind: "item", text: body.slice(2), children: [] };
      parent.children.push(node);
      stack.push({ indent, node });
    } else if (body.startsWith("> ") || /^".*"$/.test(body)) {
      parent.children.push({ kind: "quote", text: body.replace(/^> /, "").replace(/^"|"$/g, ""), children: [] });
    } else {
      parent.children.push({ kind: "text", text: body, children: [] });
    }
  }
  return { nodes: root.children, notes };
}

function tagged(text, year) {
  const tags = [];
  let t = text.replace(/\s*_\(([^)]*)\)_/g, (_m, inner) => {
    for (let part of inner.split(/,\s*/)) {
      part = part.trim().replace(/: read live.*$/, "");
      if (part) tags.push({ text: part, warn: /recheck|due|next step|pay-as-you-go|confirm it/.test(part) });
    }
    return "";
  });
  t = t.replace(/(\s*\[([^\]]+)\](?!\())+\s*$/, (m) => {
    for (const [, s] of m.matchAll(/\[([^\]]+)\]/g)) {
      const src = s.replace(/-/g, " ");
      tags.push({ text: src.length > 36 ? `${src.slice(0, 35)}…` : src, warn: false });
    }
    return "";
  });
  return { text: shortDates(t.replace(/\*\*/g, "").trim(), year), tags: tags.map((g) => ({ ...g, text: shortDates(g.text, year) })) };
}

function linkify(text) {
  return text.replace(/(^|\s)(https?:\/\/\S+)$/, "$1[open]($2)");
}

const hasMarkdown = (s) => /\]\(|`|\*\*|(^|\s)_\S.*\S_(\s|$)/.test(s);

function row(node, year) {
  const { text, tags } = tagged(node.text.replace(/^`[^`]+`\s*/, ""), year);
  const out = { text: linkify(text), markdown: false, tags, sub: [], quotes: [], children: [] };
  out.markdown = hasMarkdown(out.text);
  for (const c of node.children) {
    if (c.kind === "quote") out.quotes.push(shortDates(c.text, year));
    else if (c.kind === "text") out.sub.push(shortDates(c.text, year));
    else out.children.push(row(c, year));
  }
  return out;
}

function cleanMeta(meta, year) {
  const parts = [];
  for (let p of String(meta ?? "").split(" · ")) {
    p = p.trim();
    if (!p || /^cite as|never the subject|needs a live read|^ask the owner$|^human-said$/.test(p)) continue;
    if (/informs, not fact/.test(p)) p = "unconfirmed";
    p = p.replace(/^thin: .*/, "thin").replace(/^captured through /, "through ")
      .replace(/^(from [^,]+|Gong's AI summary|Customer Analytics)(, |$)/, "")
      .replace(/ bound to a product or feature$/, "").replace(/^links only$/, "");
    for (const q of p.split(/, (?=(?:checked|synced|fetched|read) )/)) if (q && !parts.includes(q)) parts.push(q);
  }
  const dated = (q) => /^(checked|synced|fetched|read) /.test(q);
  return shortDates([...parts.filter((q) => !dated(q)), ...parts.filter(dated)].join(" · "), year);
}

function signal(node, year) {
  const [head, ...segs] = node.text.split(" · ");
  const out = { text: shortDates(head, year), markdown: false, tags: [], sub: [], quotes: [], children: [], stake: null };
  const rest = [];
  for (const s of segs) {
    const why = s.match(/^(likely why|why)(?: \(model-linked\))?: (.*)$/);
    const stake = s.match(/^\$([\d.,]+)(k|M)? ARR at stake$/);
    if (why) out.sub.push(`${cap(why[1])}: ${shortDates(why[2], year)}`);
    else if (stake) {
      out.stake = Number(stake[1].replace(/,/g, "")) * (stake[2] === "M" ? 1e6 : stake[2] === "k" ? 1e3 : 1);
      out.chip = `$${stake[1]}${stake[2] ?? ""} ARR`;
    } else if (/^unexplained/.test(s)) out.tags.push({ text: s, warn: true });
    else if (/^[a-z0-9_]+$/.test(s)) continue;
    else rest.push(shortDates(s, year));
  }
  if (rest.length) out.sub.unshift(rest.join(" · "));
  for (const c of node.children) {
    if (c.kind === "quote") { out.quotes.push(c.text); continue; }
    const m = c.text.match(/^([a-z ]+?)(?: \(model-linked\))?: (.*)$/);
    const r = row({ ...c, text: m ? m[2] : c.text }, year);
    r.label = m ? cap(m[1]) : null;
    out.children.push(r);
  }
  return out;
}

function grouped(nodes, year) {
  const rows = [];
  for (const n of nodes) {
    if (n.kind === "group") {
      rows.push({ heading: cap(n.text) });
      for (const c of n.children) rows.push(row(c, year));
    } else if (n.kind === "item" && /^\*\*[^*]+\*\*/.test(n.text)) {
      const { text, tags } = tagged(n.text, year);
      const count = tags.map((g) => g.text.replace(/(\d+) more under --query/, "+$1 more")).join(" · ");
      rows.push({ heading: text, note: count });
      for (const c of n.children) rows.push(row(c, year));
    } else rows.push(row(n, year));
  }
  return rows;
}

const METRIC = /^(\S+): (\S+)(?: ([a-z]+))?(.*)$/;

export function metricLabel(key) {
  const words = key.replace(/^x:/, "").split("_");
  const span = /^\d+d$/.test(words[words.length - 1]) ? words.pop() : null;
  const text = cap(words.map((w) => WORDS[w] ?? w).join(" "));
  return span ? `${text}, ${span}` : text;
}

function metric(line) {
  const m = line.match(METRIC);
  if (!m) return null;
  const [, key, raw, unit, tail] = m;
  if (raw === "--") return { label: metricLabel(key), missing: true };
  const n = Number(raw.replace(/,/g, ""));
  const value = !Number.isFinite(n) ? raw
    : unit === "usd" ? compact(n, true)
    : unit === "count" ? compact(n)
    : unit === "ratio" ? `${Math.round(n * 100)}%`
    : raw + (unit && unit !== "score" ? ` ${unit}` : "");
  const tags = [...tail.matchAll(/_\(([^)]*)\)_/g)].map((x) => x[1]);
  const obs = tags.find((t) => t.startsWith("obs ")) ?? "";
  const change = ["MoM", "WoW", "QoQ"]
    .map((p) => tail.match(new RegExp(`${p} ([+-]?[\\d.,]+%)`))?.[1]?.concat(` ${p}`))
    .find(Boolean) ?? "";
  const flag = /held /.test(tail) ? "outlier" : obs.match(/\b(drift|mismatch)\b/)?.[1] ?? null;
  return { label: metricLabel(key), value, change, age: obs.match(/^obs (\d+d)/)?.[1] ?? "", flag, status: [obs, ...tags.filter((t) => t !== obs)].join("; ") };
}

function header(lines, year) {
  const out = { name: "", orgId: null, caId: null, inactive: false, facts: [] };
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("## ")) { out.name = line.slice(3).trim(); continue; }
    if (line.startsWith("`")) {
      const ids = [...line.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
      out.orgId = ids[0] ?? null;
      out.caId = ids[1] ?? null;
      continue;
    }
    if (/^_\(inactive\)_$/.test(line.trim())) { out.inactive = true; continue; }
    if (/^\w+=/.test(line)) {
      for (const kv of line.split(" · ")) {
        const [k, ...v] = kv.split("=");
        out.facts.push({ label: cap(k.replace(/_/g, " ")), note: "", value: shortDates(v.join("="), year) });
      }
      continue;
    }
    const m = line.match(/^([A-Z][^:(]*?)(?: \(([^)]*)\))?: (.*)$/);
    if (!m) { out.facts.push({ label: "", note: "", value: shortDates(line, year) }); continue; }
    const value = m[3].split(" · ").filter((p) => !/^read live/.test(p.trim())).join(" · ");
    out.facts.push({ label: LABELS[m[1]] ?? m[1], note: shortDates(m[2] ?? "", year), value: shortDates(value, year) });
  }
  return out;
}

export function parseCard(text, { year = new Date().getFullYear() } = {}) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const starts = [];
  lines.forEach((l, i) => { if (/^\*\*[^*]+\*\*/.test(l)) starts.push(i); });
  const card = { ...header(lines.slice(0, starts[0] ?? lines.length), year), sections: [] };
  starts.forEach((start, i) => {
    const body = lines.slice(start + 1, starts[i + 1] ?? lines.length);
    const m = lines[start].match(/^\*\*([^*]+)\*\*(?:\s+_\((.*)\)_)?\s*$/);
    const title = m?.[1] ?? lines[start].replace(/\*\*/g, "");
    const section = { title, meta: cleanMeta(m?.[2], year), open: OPEN.has(title), kind: "list", rows: [], notes: [] };
    if (!m || !KNOWN.has(title)) {
      card.sections.push({ ...section, kind: "raw", meta: "", markdown: [lines[start], ...body].join("\n").trim() });
      return;
    }
    const { nodes, notes } = tree(body);
    section.notes = notes.filter((n) => !/^none open$/.test(n)).map((n) => shortDates(n
      .replace(/^\+(\d+) withheld \(char budget\).*$/, "+$1 more facts · ask Claude about a topic")
      .replace(/^\+(\d+) ad-hoc metrics withheld.*$/, "+$1 more metrics"), year));
    if (title === "Snapshots") {
      section.kind = "metrics";
      const all = nodes.flatMap((n) => (n.kind === "group" ? n.children : [n])).map((n) => metric(n.text)).filter(Boolean);
      section.rows = all.filter((r) => !r.missing);
      section.missing = all.length - section.rows.length;
      section.meta = [`${section.rows.length} metrics`, section.missing ? `${section.missing} need a live read` : null].filter(Boolean).join(" · ");
    } else if (title === "Signals") {
      section.rows = nodes.filter((n) => n.kind === "item").map((n) => signal(n, year));
    } else if (title === "Memory" || title === "Features") {
      section.rows = grouped(nodes, year);
    } else {
      section.rows = nodes.map((n) => row(n, year));
    }
    if (!section.meta.split(" · ").some((q) => /^\d/.test(q))) section.meta = [String(section.rows.filter((r) => !r.heading).length), section.meta].filter(Boolean).join(" · ");
    card.sections.push(section);
  });
  return card;
}
