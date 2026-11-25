// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "squirrel-pane-header" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, theme, home, layout, shared, setShared } from "herdr";

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

const UNFOCUSED_FILL = "#99339959";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// A collapsed pane (only its header showing) whose agent replied since you last had it open gets a
// glowing "Unread" chip on its header, so it stands out when you're flipping between panes. Herdr's own
// "done" clears as soon as a header is on screen, so this goes by the core's turn count instead: a turn
// counts as seen once its pane is opened past its header after the turn ended. Selecting a collapsed pane
// doesn't count, so you can step through collapsed panes without clearing them.
const SEEN = "squirrel.reply-seen";
const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
// Takes a position n (wraps every 1) and an alpha, and blends between the colour stops.
const stops = (list) => (n, alpha) => {
  const f = (((n % 1) + 1) % 1) * list.length, i = Math.floor(f), k = f - i;
  const a = list[i], b = list[(i + 1) % list.length];
  return "#" + [0, 1, 2].map((j) => hex2((a[j] + (b[j] - a[j]) * k) / 255)).join("") + hex2(alpha);
};
const UNREAD = stops([[80, 220, 255], [80, 130, 255], [140, 255, 230]]);

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.shiny = false;
    cx.spawn(async (cx) => { for (;;) { await cx.sleep(this.shiny ? 50 : 500); cx.notify(); } });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/squirrel-pane-header/${icon}.svg`).size(14));
  }

  // A see-through glow that fades out at both ends into the header, with rings of light pulsing out from the centre.
  chip(pal, now, label) {
    const N = 44;
    return h_flex().relative().flex_none().h(20).w(120)
      .child(h_flex().absolute().top(0).left(0).size_full().children(Array.from({ length: N }, (_, i) => {
        const d = Math.abs((i + 0.5) / N * 2 - 1);
        const fade = Math.pow(1 - d, 1.6);
        const pulse = 0.5 + 0.5 * Math.cos(Math.PI * 2 * (d * 1.4 - now * 0.7));
        return div().h_full().flex_1().bg(pal(d * 0.6 - now * 0.08, fade * (0.12 + 0.3 * pulse)));
      })))
      .child(div().absolute().top(0).left(0).size_full().flex().items_center().justify_center().text_size(10.5).font_semibold().text_color(pal(0.15 - now * 0.08, 1)).child(label));
  }


  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const live = (p.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const name = shared("squirrel.pane-names")?.[p.pane] || (p.program?.agent && live) || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const claude = (p.program?.agent && shared("squirrel.terminal-claude")?.[p.terminal]) || {};
    const about = [claude.model, claude.effort].filter(Boolean).join(" · ");
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    // Stand-in for Ghostty's unfocused-split-fill: Herdr can't tint a terminal, so the header carries it.
    const unfocused = !p.focused;
    const core = terminals().find((x) => x.address === p.terminal);
    const coreState = core?.status?.state ?? core?.status, turn = core?.turn;
    const said = core?.report?.msg ?? "";
    const background = /still running$/.test(said) ? said.replace(/ still running$/, " in background") : null;
    // The core's row count: the pane's own scroll length doesn't follow its height.
    const open = (core?.rows ?? 0) > 1;
    const seen = shared(SEEN) ?? {};
    if (open && coreState !== "working" && turn != null && seen[p.terminal] !== turn) setShared(SEEN, { ...seen, [p.terminal]: turn });
    this.shiny = Boolean(p.program?.agent) && !open && coreState === "done" && turn != null && seen[p.terminal] !== turn;
    const now = Date.now() / 1000;
    const head = h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(unfocused ? UNFOCUSED_FILL : t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      // The dragon moves this conversation to the other subscription, after asking (squirrel-topbar switch.js).
      .when(Boolean(claude.account), (el) => el.child(div().id(`ph-acct-${pane}`).flex_none().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip("Move this conversation to the other subscription")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); setShared("squirrel.switch-target", { terminal: p.terminal, at: Date.now() }); run("squirrel-topbar.switch_ask"); })
        .child(image(`mods/squirrel-dragon/dragon-${(claude.account - 1) % 2}.svg`).w(24).h(15))))
      .when(Boolean(about), (el) => el.child(div().flex_none().text_color(unfocused ? t.dim : t.muted).child(about)))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(unfocused ? t.muted : t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      // Claude counts as working while a shell or agent it left running in the background is still going
      // ("1 shell still running"); that shows as quiet text, so the spinner only means it's actually replying.
      .when(st === "working" && !background, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "working" && Boolean(background), el => el.child(div().id(`ph-bg-${pane}`).flex_none().text_size(11).text_color(t.dim)
        .tooltip(Object.values(core?.records ?? {}).map((r) => r.title).filter(Boolean).join("\n") || background).child(background)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done" && !this.shiny, el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.shiny, el => el.child(this.chip(UNREAD, now, "Unread")))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
    return head;
  }
}
