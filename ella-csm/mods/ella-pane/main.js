// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "ella-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// Claude and Codex panes get the ask buttons from asks.js, pinned to the left
// so a narrow pane truncates the name and folder rather than the buttons. Claude panes also
// get a "?" chip (hover: session summary; click: refresh it).

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, hc, spaces, exec, openOverlay, nextCommand, shared, setShared } from "herdr";
import { KEY as MINIMISED, addMinimised } from "./minimised.js";
import { ASKS, withContext } from "./asks.js";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// Closing goes through mods/close-guard: it asks first, and ticks off the pane's
// to-do if it's a to-do helper.
const closePane = (pane) => openOverlay({ mod: "ella-close-guard", kind: "dialog", width: 420, height: 230, props: { pane } });

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false; this.sent = null; this.gist = null; this.gistAt = 0; this.gistBusy = false;
    // Button colours follow the background style (shared "style.buttons", set by
    // mods/ella-status); shared state doesn't redraw, so look for a change.
    this.seenButtons = JSON.stringify(shared("style.buttons") ?? null);
    cx.timer.every(2000, (cx) => {
      const now = JSON.stringify(shared("style.buttons") ?? null);
      if (now !== this.seenButtons) { this.seenButtons = now; cx.notify(); }
    });
    // cmd-shift-w sends "ella-pane.close" to every header; the focused pane's one acts.
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "close" && this.me()?.focused) closePane(this.me().pane);
      }
    });
  }

  // Hover "gist" on Claude panes: one sentence on what the session is doing,
  // from ~/.local/bin/pane-gist (Haiku over the transcript, cached per session).
  // Hover reads the cache, which pane-gist-all refreshes every 2 minutes
  // (launchd com.ella-csm.pane-gist); only with no cache does it wait on Haiku.
  showCachedGist(p, cx) {
    exec("zsh", [`${home()}/.local/bin/pane-gist`, "--cached", p.terminal], { timeout: 5000 })
      .then((r) => {
        if (r.code === 0 && r.stdout.trim()) { this.gist = r.stdout.trim(); cx.notify(); }
        else this.loadGist(p, cx);
      })
      .catch(() => this.loadGist(p, cx));
  }

  loadGist(p, cx) {
    if (this.gistBusy || Date.now() - this.gistAt < 30000) return;
    this.gistBusy = true;
    exec("zsh", [`${home()}/.local/bin/pane-gist`, p.terminal], { timeout: 90000 })
      .then((r) => { this.gist = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : (this.gist ?? "Couldn't find this session's transcript."); })
      .catch(() => { this.gist = this.gist ?? "Couldn't read this session."; })
      .finally(() => { this.gistBusy = false; this.gistAt = Date.now(); cx.notify(); });
  }

  gistChip(t, p) {
    const text = this.gistBusy && !this.gist ? "Reading this session…" : this.gist ?? "Reading this session…";
    const help = (shared("style.buttons") ?? {}).help ?? t.ansi6;
    return div().id(`gist-${p.pane}`).flex_none().size(19).flex().items_center().justify_center().rounded(10)
      .border_1().border_color(help).bg(help)
      .text_size(11).font_bold().text_color(t.background).cursor_pointer()
      .hover((s) => s.bg(help + "cc"))
      .on_hover((hovered, cx) => { if (hovered) this.showCachedGist(p, cx); })
      .on_click((_e, cx) => { cx.stop_propagation(); this.gistAt = 0; this.loadGist(p, cx); })
      .tooltip(text)
      .child("?");
  }

  // Each ask button types its request into the target agent's session.
  ask(t, p, a) {
    const sent = this.sent === a.key;
    const c = sent ? t.done : (shared("style.buttons") ?? {})[a.key] ?? t[a.tint] ?? t.accent;
    return div().id(`ask-${a.key}-${p.pane}`).flex_none().px(7).h(19).flex().items_center().rounded(5)
      .border_1().border_color(c).bg(c)
      .text_size(11).font_semibold().text_color(t.background).cursor_pointer()
      .hover((s) => s.bg(c + "cc"))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        const space = spaces().find((s) => s.tabs.some((tab) => tab.id === p.tab));
        hc(["send", p.terminal, withContext(a.text, space?.name, a.plain)]);
        this.sent = a.key;
        cx.notify();
        cx.timer.after(2000, (cx) => { this.sent = null; cx.notify(); });
      })
      .child(sent ? "sent ✓" : a.label);
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args, onClick) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (onClick) onClick(); else run(command, args);
      })
      .child(svg(`mods/ella-pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(["claude-code", "codex"].includes(p.app) && Boolean(p.terminal), el => el.child(h_flex().gap(5).flex_none()
        .when(p.app === "claude-code", row => row.child(this.gistChip(t, p)))
        .children(ASKS.map((a) => this.ask(t, p, a)))))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_shrink_1().min_w_0().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w_0().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        // Minimise: take the pane away but keep its terminal running; the tab bar's
        // "minimised" chip brings it back (mods/minimised).
        .when(Boolean(p.terminal), row => row.child(this.button(t, `ph-m-${pane}`, "minimise", null, { pane }, () => {
          const space = spaces().find((s) => s.tabs.some((tab) => tab.id === p.tab));
          setShared(MINIMISED, addMinimised(shared(MINIMISED), { terminal: p.terminal, name, space: space?.id, spaceName: space?.name, at: Date.now() }));
          run("terminal.park", { terminal: p.terminal });
        })))
        .child(this.button(t, `ph-x-${pane}`, "close", null, { pane }, () => closePane(pane))));
  }
}
