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
const field = (line, name) => { const m = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)`).exec(line); return m ? unescape(m[1]) : null; };

// The first thing you typed, skipping slash commands, their output and compaction summaries.
function firstPrompt(lines) {
  for (const line of lines) {
    let text = field(line, "content") ?? field(line, "text");
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
    } else if (line.startsWith("L\t")) live.add(field(line, "sessionId"));
    else if (!cur) continue;
    else if (line.startsWith("M\t")) cur.model = field(line, "model");
    else if (line.startsWith("T\t")) cur.title = field(line, "customTitle");
    else if (line.startsWith("A\t")) cur.aiTitle = field(line, "aiTitle");
    else if (line.startsWith("C\t")) cur.cwd = field(line, "cwd");
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

export default class SquirrelReopen extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.sessions = shared(CACHE) ?? null;
    cx.spawn(async (cx) => {
      try {
        [this.sessions, this.names] = await Promise.all([closedSessions(), accountNames()]);
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
    const t = theme();
    const list = this.sessions ?? [];
    const others = new Set(list.map((s) => s.dir)).size > 1;
    const row = (s) => h_flex().id(s.id).h(30).px(9).gap(10).rounded(6).items_center().flex_none().cursor_pointer()
      .hover((el) => el.bg(t.selected)).on_click(() => this.reopen(s))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.title || s.aiTitle || s.prompt))
      .when(others, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(this.names?.get(s.dir) ?? s.dir.split("/").pop())))
      .child(div().w(32).flex_none().text_size(11).text_color(t.dim).text_right().child(ago(s.at)));
    return v_flex().id("squirrel-reopen").track_focus(this.handle).size_full().min_h(0).p(5).bg(t.popover).text_size(12.5)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().px(9).pt(6).pb(4).text_size(11).text_color(t.dim).child("Closed Claude panes, last 3 days"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(list.map(row))
        .when(!this.sessions || list.length === 0 || Boolean(this.error), (el) => el.child(div().px(9).py(6).text_color(t.dim)
          .child(this.error ? `Couldn't read sessions: ${this.error}` : !this.sessions ? "Loading…" : "Nothing closed in the last 3 days"))));
  }
}
