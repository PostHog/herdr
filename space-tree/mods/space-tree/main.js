// Spaces as one tree: each space, then its terminals and agents tab by tab, and
// under an agent the sub-agents it started. A row names its branch when it isn't
// the space's, worktrees included. Claude Code moves into a worktree without
// moving its process, so for Claude the folder comes from its transcript.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, terminals, machines, focused, run, openOverlay, exec, hc, home, readTextFile, theme, shared, setShared, setAgentOrder, layout, appHome, window } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, as in Herdr's own lists.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const RAIL_CELL = 32;

// The same avatar colors as Herdr's spaces list, from the same shared map.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

// Coder's default ssh hosts end in .coder; `hogli devbox:setup` writes coder.<workspace> instead.
const isDevbox = (machine) => /\.coder$|^coder\.[^.]/.test(machine?.target ?? "");
const devboxUi = (name) => terminals().find((t) => t.labels?.["coder-devbox.ui"] === name && t.state === "live" && !String(t.address).includes("/"));

// Layout blocks that belong to other pieces: shown while that piece's mod is installed,
// hidden otherwise, so turning a piece off leaves no empty or stale block.
const PIECE_BLOCKS = [
  { id: "back-forward", mod: "back-forward" },
  { id: "inbox", mod: "ph-inbox" },
  { id: "claude-usage", mod: "claude-usage" },
];
const PIECES_MS = 2000;
const installed = (mod) => readTextFile(`${appHome()}/mods/${mod}/main.js`).then((text) => text != null, () => false);

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const GIT_MS = 30000;
const CLAUDE_MS = 10000;
const INDENT = 14;
const AVATAR_DIR = "data/space-tree/avatars";
// Where the space-tree-icon picker unpacks Lucide (its lucide.js; Herdr doesn't import across mods).
const LUCIDE_DIR = "data/space-tree-icon/lucide-0.460.0";
const AVATAR_MS = 24 * 3600000;
const githubOwner = (url) => url.match(/github\.com[:/]([^/\s]+)\/[^/\s]+?(?:\.git)?\/?$/)?.[1] ?? null;

// The pull-requests piece's PR state, shortened to what a space row has room for.
const PR_TONES = { ok: "ansi2", bad: "ansi1", warn: "ansi3", run: "working", info: "ansi6", dim: "dim" };
function prState(pr) {
  const c = pr.checks ?? {};
  if (pr.queue?.active) return { label: `In the merge queue (${pr.queue.state.replace(/_/g, " ")})`, tone: "info" };
  if (pr.queue && ["failed", "cancelled"].includes(pr.queue.state)) return { label: `Merge queue ${pr.queue.state}`, tone: "bad" };
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") return { label: "Conflicts", tone: "bad" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "bad" };
  if (c.failed > 0 && pr.mergeState !== "UNSTABLE") return { label: `${c.failed} of ${c.total} checks failing`, tone: "bad" };
  if (c.inProgress > 0) return { label: `${c.inProgress} of ${c.total} checks running`, tone: "run" };
  if (pr.isDraft) return { label: "Draft", tone: "dim" };
  if (pr.mergeState === "BEHIND") return { label: "Behind its base", tone: "warn" };
  if (pr.mergeState === "BLOCKED" && pr.reviewDecision !== "APPROVED") return { label: "Waiting on review", tone: "warn" };
  return { label: "Ready to merge", tone: "ok" };
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const quiet = (b) => !b || b === "main" || b === "master";

function icon(p, size, color) {
  if (!p?.icon) return svg("mods/workspace-chrome/terminal.svg").size(size).flex_none().text_color(color);
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// What a terminal's row says: a tab someone named, else what its program set as
// its title when that tells more than the program's name or a path.
function label(tab, p, many) {
  const prog = p.program?.name ?? "";
  const live = clean(p.title);
  const path = /^[~/]/.test((p.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== p.program?.key;
  const own = telling ? live : prog || tab.name;
  if (many) return tab.named ? `${tab.name} · ${own}` : own;
  return tab.named ? tab.name : own;
}

export default class SpaceTree extends View {
  init(_props, cx) {
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.showTerminals = localStorage.getItem("terminals") === "shown";
    this.git = {}; // "machine\0cwd" -> { branch, linked } | null
    this.gitAt = {};
    this.claude = {}; // terminal address -> the folder its Claude session is in now
    this.remotes = {}; // "machine\0top" -> the GitHub owner of its origin remote, or null
    this.avatars = JSON.parse(localStorage.getItem("avatars") ?? "{}"); // owner -> { path, at }
    this.termCwd = {}; // terminal address -> its folder, for panes that report none (another machine's)
    this.homes = {}; // machine -> its home folder
    this.machines = []; // `hc machine ls`, without temporary ones
    this.busy = false;
    this.devboxMenu = false;
    this.pieceShown = {}; // block id -> shown, as last applied
    cx.timer.every(CLAUDE_MS, (cx) => this.refresh(cx));
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    this.refresh(cx);
    this.refreshMachines(cx);
    cx.timer.every(PIECES_MS, (cx) => this.syncPieces(cx));
    this.syncPieces(cx);
  }

  syncPieces(cx) {
    cx.spawn(async (cx) => {
      const devboxMenu = await installed("coder-devbox");
      if (devboxMenu !== this.devboxMenu) { this.devboxMenu = devboxMenu; cx.notify(); }
      // Applied on a change and once at start, not compared with layout(): its `hidden` is the
      // file's, while the shown state Herdr keeps from earlier show and hide commands can differ.
      for (const block of PIECE_BLOCKS) {
        const on = await installed(block.mod);
        if (this.pieceShown[block.id] === on || !find(layout(), block.id)) continue;
        this.pieceShown[block.id] = on;
        run(on ? "layout.show" : "layout.hide", { id: block.id });
      }
    });
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      cx.notify();
    });
  }

  async homeOf(on) {
    if (!on) return home();
    if (!this.homes[on]) {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
      if (r.code === 0 && r.stdout) this.homes[on] = r.stdout;
    }
    return this.homes[on] ?? null;
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  toggleTerminals(cx) {
    this.showTerminals = !this.showTerminals;
    localStorage.setItem("terminals", this.showTerminals ? "shown" : "hidden");
    cx.notify();
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.findClaudeFolders();
        await this.readGit();
        await this.findAvatars();
        if (!this.lucide) this.lucide = await readTextFile(`${appHome()}/${LUCIDE_DIR}/tags.json`).then(Boolean, () => false);
      } catch (e) {
        console.log(`space-tree: ${e}`);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  // Claude Code writes ~/.claude/sessions/<pid>.json while it runs, and each
  // transcript line carries the folder it worked in, a worktree after EnterWorktree.
  async findClaudeFolders() {
    const found = {};
    const machineOf = new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, s.machine ?? null])));
    for (const p of panes()) {
      if (!p.terminal || p.program?.key !== "claude") continue;
      const on = machineOf.get(p.tab) ?? null;
      const r = await hc(["get", p.terminal, "--json"]);
      if (r.code !== 0) continue;
      let pid;
      try { pid = JSON.parse(r.stdout).foreground?.pid; } catch { continue; }
      const dir = await this.homeOf(on);
      const text = pid && dir && (await readTextFile(`${dir}/.claude/sessions/${pid}.json`, { on }));
      if (!text) continue;
      let s;
      try { s = JSON.parse(text); } catch { continue; }
      if (!s.sessionId || !s.cwd) continue;
      const project = s.cwd.replace(/[^A-Za-z0-9]/g, "-");
      const tail = await exec("tail", ["-c", "200000", `${dir}/.claude/projects/${project}/${s.sessionId}.jsonl`], { on });
      const folders = tail.code === 0 ? [...tail.stdout.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)] : [];
      const last = folders.length ? JSON.parse(`"${folders.at(-1)[1]}"`) : s.cwd;
      found[p.terminal] = last;
    }
    this.claude = found;
  }

  // Branch, and whether the folder is a linked worktree, per folder in view.
  async readGit() {
    const now = Date.now();
    const sp = spaces();
    const machineOf = new Map(sp.flatMap((s) => s.tabs.map((t) => [t.id, s.machine ?? null])));
    const wanted = new Map();
    this.termCwd = Object.fromEntries(terminals().filter((k) => k.cwd).map((k) => [k.address, k.cwd]));
    for (const p of panes()) {
      if (!p.terminal) continue;
      const cwd = this.claude[p.terminal] ?? this.cwdOf(p);
      if (!cwd) continue;
      const on = machineOf.get(p.tab) ?? null;
      wanted.set(`${on ?? ""}\0${cwd}`, { on, cwd });
    }
    for (const [key, { on, cwd }] of wanted) {
      if (now - (this.gitAt[key] ?? 0) < GIT_MS) continue;
      this.gitAt[key] = now;
      try {
        const r = await exec("git", ["rev-parse", "HEAD", "--abbrev-ref", "HEAD", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], { cwd, on: on ?? undefined });
        if (r.code !== 0) { this.git[key] = null; continue; }
        const [sha, branch, gitDir, common, top] = r.stdout.trim().split("\n");
        this.git[key] = { branch: branch === "HEAD" ? "detached" : branch, linked: gitDir !== common, sha, top };
      } catch {
        this.git[key] ??= null;
      }
    }
    for (const key of Object.keys(this.git)) if (!wanted.has(key)) { delete this.git[key]; delete this.gitAt[key]; }
  }

  cwdOf(p) {
    return p.cwd ?? this.termCwd[p.terminal] ?? null;
  }

  colors(sp) {
    const ids = new Set(sp.map((s) => s.id));
    const stored = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(stored).length;
    for (const s of sp) {
      if (kept[s.id] || s.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[s.id] = PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return kept;
  }

  status(t, st) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (st === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (st === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (st === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return null;
  }

  chevron(t, id, open, count, top) {
    return div()
      .id(`fold-${id}`)
      .w(16)
      .h(18)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.fold(id, cx); })
      .when(count > 0, (el) => el.child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11)))
      .when(!open && Boolean(top) && top !== "idle", (el) => el.text_color(t[top] ?? t.dim));
  }

  // The branch tag: only when it says something the space row doesn't.
  branchTag(t, g, spaceBranch) {
    if (!g) return null;
    const differs = g.branch !== spaceBranch && !(quiet(g.branch) && quiet(spaceBranch));
    if (!g.linked && !differs) return null;
    return h_flex().flex_none().max_w(140).gap(3).items_center().text_size(11).text_color(g.linked ? t.ansi5 ?? t.dim : t.dim)
      .tooltip(g.linked ? `Worktree on ${g.branch}` : `On ${g.branch}`)
      .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none())
      .child(div().min_w(0).truncate().child(g.branch));
  }

  prChip(t, key, prs) {
    const [pr, ...more] = prs;
    const state = prState(pr);
    return h_flex()
      .id(`pr-${key}`)
      .flex_none()
      .gap(3)
      .px(5)
      .h(18)
      .rounded(5)
      .items_center()
      .text_size(11.5)
      .text_color(t[PR_TONES[state.tone]] ?? t.dim)
      .hover((st) => st.bg(t.hover))
      .tooltip(`#${pr.number} ${pr.title}\n${state.label}${more.length ? `\nAlso ${more.map((p) => `#${p.number}`).join(", ")}` : ""}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [pr.url]); })
      .child(svg("mods/workspace-chrome/git-compare.svg").size(11).flex_none())
      .child(`#${pr.number}${more.length ? ` +${more.length}` : ""}`);
  }

  // The GitHub owner of the repo a space's first terminal is in.
  spaceRepo(s, ps) {
    const tabs = new Set(s.tabs.map((tab) => tab.id));
    for (const p of ps) {
      if (!tabs.has(p.tab) || !p.terminal) continue;
      const top = this.git[`${s.machine ?? ""}\0${this.claude[p.terminal] ?? this.cwdOf(p)}`]?.top;
      if (top) return `${s.machine ?? ""}\0${top}`;
    }
    return null;
  }

  // A space's default icon is its repo owner's GitHub avatar, downloaded once a day.
  async findAvatars() {
    const ps = panes();
    const now = Date.now();
    let changed = false;
    for (const s of spaces()) {
      const repo = this.spaceRepo(s, ps);
      if (!repo || repo in this.remotes) continue;
      const [machine, top] = repo.split("\0");
      const r = await exec("git", ["remote", "get-url", "origin"], { cwd: top, on: machine || undefined });
      this.remotes[repo] = r.code === 0 ? githubOwner(r.stdout.trim()) : null;
    }
    for (const owner of new Set(Object.values(this.remotes).filter(Boolean))) {
      const seen = this.avatars[owner];
      if (seen && now - seen.at < AVATAR_MS) continue;
      const path = `${AVATAR_DIR}/${owner.toLowerCase()}.png`;
      await exec("mkdir", ["-p", `${appHome()}/${AVATAR_DIR}`]);
      const r = await exec("curl", ["-fsSL", "--max-time", "10", "-o", `${appHome()}/${path}`, `https://github.com/${owner}.png?size=64`]);
      this.avatars[owner] = { path: r.code === 0 ? path : seen?.path ?? null, at: now };
      changed = true;
    }
    if (changed) localStorage.setItem("avatars", JSON.stringify(this.avatars));
    const bySpace = Object.fromEntries(spaces().map((s) => [s.id, this.avatars[this.remotes[this.spaceRepo(s, ps)]]?.path ?? null]).filter(([, path]) => path));
    if (JSON.stringify(bySpace) !== JSON.stringify(shared("space-tree.avatars") ?? {})) setShared("space-tree.avatars", bySpace);
  }

  spaceRow(t, s, color, count, top, glyph, avatar) {
    const open = !this.folded.has(s.id);
    const fill = color?.startsWith("#") ? color : (MARK[color] ?? t[color] ?? t.accent);
    const id = `space-${s.id}`;
    const newTab = div()
      .id(`new-${s.id}`)
      .size(18)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .text_color(t.dim)
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip("New tab here")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        // Herdr's new-tab menu opens in the shown space.
        run("space.select", { id: s.id });
        openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
      })
      .child(svg("mods/workspace-chrome/plus.svg").size(12));
    return this.hoverable(h_flex().id(id), id)
      .h(30)
      .pl(2)
      .pr(8)
      .mt(4)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(8)
      .when(s.active, (el) => el.bg(t.selected))
      .when(!s.active, (el) => el.hover((st) => st.bg(t.hover)))
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => openOverlay({ mod: "space-tree-menu", kind: "popup", width: 200, height: 260, props: { space: s.id } }))
      .child(this.chevron(t, s.id, open, count, top))
      .child(!glyph && avatar
        ? image(avatar).size(18).flex_none().rounded(5)
        : h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_color("#ffffff")
          .child(glyph ? svg(`${LUCIDE_DIR}/icons/${glyph}.svg`).size(12) : div().text_size(10.5).font_bold().child([...s.name][0]?.toUpperCase() ?? "?")))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name))
      .when(!open && Boolean(top), (el) => el.child(this.status(t, top)))
      .when(this.hovered === id, (el) => el.child(newTab));
  }

  // Tracks the pointer for the close buttons, which show on hover and on the focused row.
  hoverable(el, id) {
    return el.on_hover((on, cx) => {
      if (on) this.hovered = id;
      else if (this.hovered === id) this.hovered = null;
      cx.notify();
    });
  }

  closeButton(t, id, action) {
    return div()
      .id(`close-${id}`)
      .size(18)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.hovered = null;
        action();
        cx.notify();
      })
      .child(svg("mods/pane/close.svg").size(12));
  }

  // The same as a tab in Herdr's tab bar: click to show it, double-click to rename,
  // drag onto another row of the space to move the tab there, right-click for the
  // tab menu, the X to close. A tab split into panes closes one pane at a time.
  terminalRow(t, s, tab, p, many, kids, depth, g, prs) {
    const st = p.program?.agent || p.status ? p.status : null;
    const open = !this.folded.has(p.terminal);
    const top = kids.reduce((m, k) => ((RANK[k.st] ?? 0) > (RANK[m] ?? 0) ? k.st : m), null);
    const on = s.active && tab.active && p.focused;
    const id = `term-${p.terminal}`;
    const dragging = this.pressed && this.pressed.tab !== tab.id && this.pressed.space === s.id;
    const target = dragging && this.over === tab.id;
    const fromIndex = this.pressed ? s.tabs.findIndex((x) => x.id === this.pressed.tab) : -1;
    return this.hoverable(h_flex().id(id), id)
      .relative()
      .h(28)
      .pl(2 + INDENT * depth)
      .pr(6)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.raised))
      .hover((st) => st.bg(t.hover))
      .when(this.pressed?.tab === tab.id && Boolean(this.over) && this.over !== tab.id, (el) => el.opacity(0.5))
      .when(target, (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(fromIndex < tab.index - 1, (line) => line.bottom(0))
        .when(fromIndex > tab.index - 1, (line) => line.top(0))))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count === 2) { run("tab.rename", { id: tab.id }); return; }
        this.pressed = { tab: tab.id, space: s.id };
        this.over = tab.id;
      })
      .on_mouse_move((_e, cx) => {
        if (!this.pressed || this.pressed.space !== s.id || this.over === tab.id) return;
        this.over = tab.id;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        this.over = null;
        if (from && from.space === s.id && from.tab !== tab.id) run("tab.move", { id: from.tab, index: tab.index });
        else if (from) run("pane.focus", { pane: p.pane });
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: s.id } } });
      })
      .child(this.chevron(t, p.terminal, open, kids.length, top))
      .child(icon(p.program, 14, t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(st || on ? t.foreground : t.muted).child(tab.zoomed && on ? `${label(tab, p, many)} Z` : label(tab, p, many)))
      .child(prs.length ? this.prChip(t, p.terminal, prs) : this.branchTag(t, g, s.branch) ?? div())
      .child(this.status(t, st) ?? div())
      .when(on || this.hovered === id, (el) => el.child(this.closeButton(t, id, () => (many ? run("pane.close", { pane: p.pane }) : run("tab.close", { id: tab.id })))));
  }

  subRow(t, k, lines) {
    const id = `sub-${k.t.address}`;
    return this.hoverable(h_flex().id(id), id)
      .h(26)
      .pl(2 + INDENT * 2)
      .pr(6)
      .flex_none()
      .items_center()
      .rounded(8)
      .hover((s) => s.bg(t.hover))
      .on_click(() => (k.pane ? run("pane.focus", { pane: k.pane }) : run("terminal.peek", { terminal: k.t.address })))
      .children(lines.map((l) => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .child(div().mr(6).child(icon(k.t.program, 13, t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(k.t.name || k.t.template || k.t.program?.name || k.t.address))
      .child(this.status(t, k.st) ?? div())
      .when(this.hovered === id, (el) => el.child(this.closeButton(t, id, () => (k.pane ? run("pane.close", { pane: k.pane }) : run("terminal.kill", { terminal: k.t.address })))));
  }

  render() {
    const t = theme();
    const sp = spaces();
    const colors = this.colors(sp);
    const glyphs = this.lucide ? shared("space-tree.icons") ?? {} : {};
    const avatars = shared("space-tree.avatars") ?? {};
    const openPrs = (shared("prs.cache.mine")?.prs ?? []).filter((pr) => pr.state === "OPEN" && pr.mine);
    if (narrow()) return this.rail(t, sp);

    const ps = panes();
    const all = terminals().filter((k) => k.state === "live");
    const paneOf = new Map(ps.filter((p) => p.terminal).map((p) => [p.terminal, p]));
    const statusOf = (k) => {
      const s = paneOf.get(k.address)?.status ?? k.status;
      return s === "error" ? "blocked" : s;
    };
    // Sub-agents of `addr`, depth first, with the tree lines in front of each.
    const tree = (addr, lead = []) => {
      const kids = all.filter((k) => k.parent === addr);
      return kids.flatMap((k, i) => {
        const last = i === kids.length - 1;
        return [{ t: k, st: statusOf(k), pane: paneOf.get(k.address)?.pane, lines: [...lead, last ? "└" : "├"] }, ...tree(k.address, [...lead, last ? "" : "│"])];
      });
    };
    // A sub-agent with a pane of its own shows under its parent, not twice.
    const nested = new Set(all.filter((k) => k.parent && all.some((p) => p.address === k.parent)).map((k) => k.address));

    const isAgent = (p) => Boolean(p.program?.agent || p.status);
    const shown = (p) => this.showTerminals || isAgent(p) || all.some((k) => k.parent === p.terminal);

    const order = [];
    const spaceRows = (s) => {
      const tabs = s.tabs.filter((tab) => !tab.settled || tab.active);
      const groups = tabs.map((tab) => {
        const mine = ps.filter((p) => p.tab === tab.id && p.terminal && !nested.has(p.terminal) && shown(p));
        return { tab, mine };
      });
      const count = groups.reduce((n, g) => n + g.mine.length, 0);
      const head = this.spaceRow(t, s, colors[s.id], count, s.status, glyphs[s.id], avatars[s.id]);
      if (this.folded.has(s.id)) return [head];
      return [head, ...groups.flatMap(({ tab, mine }) => mine.flatMap((p) => {
        if (isAgent(p)) order.push(p.terminal);
        const kids = tree(p.terminal);
        const g = this.git[`${s.machine ?? ""}\0${this.claude[p.terminal] ?? this.cwdOf(p)}`];
        const prs = g ? openPrs.filter((pr) => (!quiet(g.branch) && pr.headRef === g.branch) || pr.headSha === g.sha) : [];
        const row = this.terminalRow(t, s, tab, p, mine.length > 1, kids, 1, g, prs);
        if (this.folded.has(p.terminal)) return [row];
        return [row, ...kids.map((k) => this.subRow(t, k, k.lines))];
      }))];
    };
    // Spaces under a header per machine, once there is more than this computer.
    const remote = [...new Set([...sp.map((s) => s.machine).filter(Boolean), ...this.machines.map((m) => m.name)])].sort();
    const rows = !remote.length ? sp.flatMap(spaceRows) : [null, ...remote].flatMap((m) => {
      const mine = sp.filter((s) => (s.machine ?? null) === m);
      const head = this.machineRow(t, m, mine);
      if (this.folded.has(`machine:${m ?? ""}`)) return [head];
      return [head, ...(mine.length ? mine.flatMap(spaceRows) : [this.emptyMachineRow(t, m)])];
    });
    setAgentOrder(order);

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).flex_none().items_center().justify_between().text_size(11.5).text_color(t.dim)
        .child("Spaces")
        .child(h_flex().gap(2).items_center()
          .child(div().id("space-terminals").size(26).flex_none().flex().items_center().justify_center().rounded(6)
            .text_color(this.showTerminals ? t.foreground : t.dim)
            .when(this.showTerminals, (el) => el.bg(t.raised))
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(this.showTerminals ? "Hide terminals that aren't agents" : "Show every terminal")
            .on_click((_e, cx) => this.toggleTerminals(cx)).child(svg("mods/workspace-chrome/terminal.svg").size(14)))
          .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(v_flex().id("tree").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.over = null; cx.notify(); })
        .children(rows));
  }

  machineRow(t, m, mine) {
    const machine = this.machines.find((k) => k.name === m);
    const layoutState = machines().find((k) => k.name === m)?.layout;
    const connected = !m || machine?.state === "connected";
    const state = !m ? null : layoutState === "loading" ? "loading" : connected ? null : (machine?.state ?? "asleep").replace(/_/g, " ");
    const key = `machine:${m ?? ""}`;
    const open = !this.folded.has(key);
    const top = mine.reduce((acc, s) => ((RANK[s.status] ?? 0) > (RANK[acc] ?? 0) ? s.status : acc), null);
    return h_flex()
      .id(`machine-${m ?? "local"}`)
      .h(26)
      .mt(6)
      .pl(4)
      .pr(8)
      .gap(7)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_size(11)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.fold(key, cx))
      .when(this.devboxMenu && isDevbox(machine), (el) => el.on_mouse_down("right", () => this.devbox(machine)))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(m ?? "This computer"))
      .when(Boolean(state), (el) => el.child(div().flex_none().child(state)))
      .when(!open && Boolean(top), (el) => el.child(this.status(t, top) ?? div()))
      .when(Boolean(m) && connected && this.devboxMenu && isDevbox(machine), (el) => el.child(this.devboxChip(machine, t)))
      .when(connected, (el) => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`New space on ${m ?? "this computer"}`)
        .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); })
        .child("+")))
      .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim));
  }

  devbox(machine, action = null) {
    openOverlay({ mod: "coder-devbox", kind: "popup", width: 240, height: 620, props: { machine: machine.name, target: machine.target, action } });
  }

  // The coder-devbox piece's globe: forwards the box's PostHog UI, then opens it.
  devboxChip(machine, t) {
    const forward = devboxUi(machine.name);
    const port = Number(forward?.labels?.["coder-devbox.port"]) || null;
    const icon = forward && !port
      ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900)
      : svg("mods/coder-devbox/globe.svg").size(13);
    return div().id(`machine-ui-${machine.name}`).flex_none().p(2).rounded(4)
      .text_color(port ? t.accent : t.dim).hover((s) => s.bg(t.hover).text_color(port ? t.accent : t.foreground))
      .tooltip(port ? `PostHog UI at http://localhost:${port}` : forward ? "Forwarding the PostHog UI…" : "Forward the PostHog UI and open it")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (port) exec(window().platform === "macos" ? "open" : "xdg-open", [`http://localhost:${port}`]);
        else this.devbox(machine, "ui");
      })
      .child(icon);
  }

  emptyMachineRow(t, m) {
    return h_flex()
      .id(`machine-new-${m ?? "local"}`)
      .h(26)
      .pl(24)
      .gap(7)
      .flex_none()
      .items_center()
      .rounded(7)
      .text_size(12)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("space.new", { machine: m ?? "" }))
      .child(svg("mods/workspace-chrome/plus.svg").size(12))
      .child("New space there");
  }

  // Narrow sidebar: one numbered cell per space, its most urgent agent beside it.
  rail(t, sp) {
    return v_flex().size_full().min_h(0).bg(t.chrome).pt(8).gap(2).items_center().text_size(13)
      .children(sp.map((s, i) => h_flex()
        .id(`rail-${s.id}`)
        .relative()
        .w(RAIL_CELL)
        .h(26)
        .rounded(6)
        .justify_center()
        .items_center()
        .when(s.active, (el) => el.bg(t.selected))
        .when(!s.active, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click(() => run("space.select", { id: s.id }))
        .child(div().text_color(s.active ? t.foreground : t.muted).child(String(i + 1)))
        .child(div().absolute().right(5).text_color(t[s.status] ?? t.unknown).child(s.status === "blocked" || s.status === "done" ? "●" : "·"))));
  }
}
