// Claude sessions from the last 3 days that aren't running any more, newest first. Clicking one resumes
// it in a pane below the focused one, under the account and in the folder it ran in.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, theme, run, exec, readTextFile, appHome, home, shared, setShared } from "herdr";

// Per transcript: a header, the first user lines (cut short; the title is read from their start), the folder
// it ran in, the last model, /rename title and Claude's own short title (read from the first and last MB: a whole long transcript
// takes seconds). Then the ids of sessions still running, from each account's
// sessions folder.
const SCRIPT = `export LC_ALL=C; for d in "$HOME/.claude" "$HOME"/.claude-*; do [ -d "$d/projects" ] || continue
  find "$d/projects" -maxdepth 2 -name '*.jsonl' -mtime -3 | while read -r f; do
    printf '@@\\t%s\\t%s\\t%s\\n' "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")" "$d" "$f"
    head -c 400000 "$f" | grep '"type":"user"' | grep -v '"isMeta":true' | head -12 | cut -c1-3000
    printf 'C\\t%s\\n' "$(grep -m1 -o '"cwd":"[^"]*"' "$f" | head -1)"
    printf 'M\\t%s\\n' "$(tail -c 300000 "$f" | grep -o '"model":"claude-[^"]*"' | tail -1)"
    t=$({ head -c 1000000 "$f"; tail -c 1000000 "$f"; } | grep -E '"(customTitle|aiTitle)"')
    printf 'T\\t%s\\n' "$(printf '%s' "$t" | grep -o '"customTitle":"[^"]*"' | tail -1)"
    printf 'A\\t%s\\n' "$(printf '%s' "$t" | grep -o '"aiTitle":"[^"]*"' | tail -1)"
  done
  cat "$d"/sessions/*.json 2>/dev/null | grep -o '"sessionId":"[^"]*"' | sed 's/^/L\\t/'
done`;

const unescape = (s) => { try { return JSON.parse(`"${s.replace(/\\+$/, (m) => m.length % 2 ? m.slice(1) : m)}"`); } catch { return s; } };
const lensField = (line, name) => { const m = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)`).exec(line); return m ? unescape(m[1]) : null; };

// The first thing you typed, skipping slash commands, their output and compaction summaries.
function firstPrompt(lines) {
  for (const line of lines) {
    let text = lensField(line, "content") ?? lensField(line, "text");
    if (!text) continue;
    text = text.replace(/<\/?pasted_content[^>]*>/g, " ").trim();
    if (!text || text.startsWith("<") || text.startsWith("This session is being continued") || text.startsWith("[Request interrupted")) continue;
    return text.replace(/\s+/g, " ").slice(0, 120);
  }
  return null;
}

// The last list, shown at once while the scan (a second or two) runs again.
const CACHE = "squirrel.closed-sessions";

function ago(ms) {
  const m = (Date.now() - ms) / 60000;
  if (m < 1) return "<1m";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 60 / 24)}d`;
}

async function closedSessions() {
  const r = await exec("/bin/sh", ["-c", SCRIPT], { timeout: 30000 });
  const live = new Set(), out = [];
  let cur = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("@@\t")) {
      const [, mtime, dir, path] = line.split("\t");
      cur = { at: Number(mtime) * 1000, dir, id: path.split("/").pop().replace(/\.jsonl$/, ""), lines: [] };
      out.push(cur);
    } else if (line.startsWith("L\t")) live.add(lensField(line, "sessionId"));
    else if (!cur) continue;
    else if (line.startsWith("M\t")) cur.model = lensField(line, "model");
    else if (line.startsWith("T\t")) cur.title = lensField(line, "customTitle");
    else if (line.startsWith("A\t")) cur.aiTitle = lensField(line, "aiTitle");
    else if (line.startsWith("C\t")) cur.cwd = lensField(line, "cwd");
    else cur.lines.push(line);
  }
  return out.filter((s) => !live.has(s.id)).map((s) => ({ ...s, prompt: firstPrompt(s.lines), lines: undefined }))
    .filter((s) => s.cwd && (s.title || s.aiTitle || s.prompt)).sort((a, b) => b.at - a.at).slice(0, 60);
}

// Account names from squirrel.json's claudeProfiles, so a second account shows as "work-2", not a folder.
async function accountNames() {
  try {
    const s = JSON.parse(await readTextFile(`${appHome()}/squirrel.json`) ?? "{}");
    return new Map((s.claudeProfiles ?? []).map((p) => [p.configDir.replace(/^~/, home()), p.name]));
  } catch { return new Map(); }
}

// Liquid lens: one slow field behind the whole list, like ink turning in water. Two vortices orbit each
// other and twist the colour around them; the colour comes from a shifting iridescent palette at a few
// percent opacity, with clear gaps, so text stays easy to read. Between rows, a hairline of the same field
// carries a pulse of light along it. Elements take only flat colours, so the field is a grid of cells.
const LENS_W = 460, LENS_H = 370, LENS_CELL = 12;
const LENS_TAU = Math.PI * 2;
const hexByte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
// Cosine palette: smooth, saturated, drifting through every hue over about a minute.
const lensTint = (n, t, alpha, lift = 0) => "#" + [0, 0.33, 0.67].map((d) => hexByte(0.5 + lift + (0.5 - lift) * Math.cos(LENS_TAU * (n * 0.9 + t * 0.05 + d)))).join("") + hexByte(alpha);
function swirl(x, y, t) {
  const wx = x + 18 * Math.sin(y * 0.021 + t * 1.3), wy = y + 18 * Math.cos(x * 0.018 - t * 1.1);
  const vortex = (cx, cy, turns, k) => {
    const dx = wx - cx, dy = wy - cy, r = Math.hypot(dx, dy);
    return Math.sin(Math.atan2(dy, dx) * turns + 2.4 * Math.exp(-r / 150) * Math.sin(t * 0.5) * turns + r * k - t * 2);
  };
  const v = vortex(LENS_W / 2 + 120 * Math.cos(t * 0.7), LENS_H / 2 + 90 * Math.sin(t * 0.9), 3, 0.035)
    + vortex(LENS_W / 2 - 120 * Math.cos(t * 0.7), LENS_H / 2 - 90 * Math.sin(t * 0.9), 2, -0.03)
    + 0.6 * Math.sin((wx + wy) * 0.012 + t);
  return (v / 2.6 + 1) / 2;
}
const smoothstep = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
function lensLayer(t) {
  const rows = [];
  for (let y = 0; y < LENS_H; y += LENS_CELL) {
    const cells = [];
    for (let x = 0; x < LENS_W; x += LENS_CELL) {
      const n = swirl(x + LENS_CELL / 2, y + LENS_CELL / 2, t);
      cells.push(div().w(LENS_CELL).h(LENS_CELL).flex_none().bg(lensTint(n, t, 0.035 + 0.075 * smoothstep(0.35, 0.95, n))));
    }
    rows.push(h_flex().children(cells));
  }
  return div().absolute().top(0).left(0).w(LENS_W).h(LENS_H).children(rows);
}
const THREAD_SEGMENTS = 36;
function lensThread(y, i, t) {
  const pulse = (((t * 0.35 + i * 0.23) % 1.4) - 0.2) * LENS_W;
  return h_flex().h(1).mx(9).flex_none().children(Array.from({ length: THREAD_SEGMENTS }, (_, k) => {
    const x = ((k + 0.5) / THREAD_SEGMENTS) * (LENS_W - 18) + 9, glow = Math.exp(-(((x - pulse) / 40) ** 2));
    return div().h_full().flex_1().bg(lensTint(swirl(x, y, t), t, 0.2 + 0.5 * glow, 0.15 * glow));
  }));
}
const ACCOUNT_PHASE = [0.1, 0.6];

export default class SquirrelReopen extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.sessions = shared(CACHE) ?? null;
    cx.spawn(async (cx) => { for (;;) { await cx.sleep(66); cx.notify(); } });
    cx.spawn(async (cx) => {
      try {
        const [sessions, names] = await Promise.all([closedSessions(), accountNames()]);
        this.sessions = sessions.map((s) => ({ ...s, account: names.get(s.dir) ?? s.dir.split("/").pop() }));
        setShared(CACHE, this.sessions);
      }
      catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  reopen(s) {
    closeOverlay(props().overlay);
    const account = s.dir === `${home()}/.claude` ? [] : ["env", `CLAUDE_CONFIG_DIR=${s.dir}`];
    run("pane.split", { direction: "down", argv: ["/bin/sh", "-c", 'cd "$1" || exit 1; shift; "$@"; exec "$SHELL" -l', "sh", s.cwd,
      ...account, "claude", ...(s.model ? ["--model", s.model] : []), "--resume", s.id] });
  }

  render() {
    const th = theme();
    const list = this.sessions ?? [];
    const others = new Set(list.map((s) => s.dir)).size > 1;
    const t = Date.now() / 1000 * 0.18;
    const accounts = [...new Set(list.map((s) => s.dir))].sort();
    const pill = (s) => {
      const c = lensTint(ACCOUNT_PHASE[accounts.indexOf(s.dir) % 2], t, 0.9, 0.2), edge = lensTint(ACCOUNT_PHASE[accounts.indexOf(s.dir) % 2], t, 0.4);
      return div().flex_none().px(5).rounded(4).border_1().border_color(edge).text_size(10.5).text_color(c).child(s.account ?? s.dir.split("/").pop());
    };
    const row = (s, i) => [
      ...(i ? [lensThread(40 + i * 31, i, t)] : []),
      h_flex().id(s.id).h(30).px(9).gap(10).rounded(6).items_center().flex_none().cursor_pointer()
        .hover((el) => el.bg("#ffffff0e")).on_click(() => this.reopen(s))
        .child(div().flex_1().min_w(0).truncate().text_color(th.foreground).child(s.title || s.aiTitle || s.prompt))
        .when(others, (el) => el.child(pill(s)))
        .child(div().w(32).flex_none().text_size(11).text_color(th.dim).text_right().child(ago(s.at))),
    ];
    return v_flex().id("squirrel-reopen").track_focus(this.handle).relative().overflow_hidden().w_full().h(LENS_H).min_h(0).p(5).bg(th.popover).text_size(12.5)
      .child(lensLayer(t))
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().px(9).pt(6).pb(4).text_size(11).text_color(th.dim).child("Closed Claude panes, last 3 days"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(list.flatMap(row))
        .when(!this.sessions || list.length === 0 || Boolean(this.error), (el) => el.child(div().px(9).py(6).text_color(th.dim)
          .child(this.error ? `Couldn't read sessions: ${this.error}` : !this.sessions ? "Loading…" : "Nothing closed in the last 3 days"))));
  }
}
