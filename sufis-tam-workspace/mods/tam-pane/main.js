// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "tam-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// Claude panes also get a Share button: a popup (this mod again, props.share)
// picks a format and where it goes, then asks the chat for it (hc send).

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, openOverlay, closeOverlay, exec } from "herdr";
import { FORMATS, DESTINATIONS, sharePrompt } from "./share.js";

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

export default class Pane extends View {
  init() {
    this.hovered = false;
    this.share = props()?.share ?? null;
    if (this.share) {
      try { this.format = localStorage.getItem("share.format") ?? FORMATS[0].key; } catch { this.format = FORMATS[0].key; }
    }
  }

  // Type the ask into the chat and submit it. Detached, since hc send waits
  // for a draft I'm still typing.
  async send(dest) {
    const format = FORMATS.find((f) => f.key === this.format) ?? FORMATS[0];
    try { localStorage.setItem("share.format", format.key); } catch {}
    await exec("/bin/sh", ["-c", '"$0" send "$1" "$2" >/dev/null 2>&1 &', `${home()}/.local/bin/hc`, this.share.terminal, sharePrompt(format, dest)]);
    run("pane.focus", { pane: this.share.pane });
    closeOverlay(props().overlay);
  }

  renderShare() {
    const t = theme();
    const head = (s) => div().px(10).pt(8).pb(4).text_size(11).text_color(t.dim).child(s);
    const item = (id, on, label, hint, fn) => h_flex().id(id).mx(4).px(6).h(hint ? 34 : 26).gap(8).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => fn(cx))
      .child(div().w(12).flex_none().text_color(t.accent).child(on ? "✓" : ""))
      .child(div().flex_1().min_w(0).flex().flex_col()
        .child(div().text_size(12.5).text_color(t.foreground).child(label))
        .when(Boolean(hint), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(hint))));
    return div().size_full().flex().flex_col().pb(6).bg(t.raised ?? t.background)
      .child(head("Share this chat as"))
      .children(FORMATS.map((f) => item(`sf-${f.key}`, this.format === f.key, f.label, f.hint, (cx) => { this.format = f.key; cx.notify(); })))
      .child(div().mx(10).my(5).h(1).bg(t.border))
      .child(head("Send to"))
      .children(DESTINATIONS.map((d) => item(`sd-${d.key}`, false, d.label, null, () => this.send(d))));
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
      .child(svg(`mods/tam-pane/${icon}.svg`).size(14));
  }

  render(cx) {
    if (this.share) return this.renderShare();
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
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(p.program?.agent) && /claude/i.test(name) && Boolean(p.terminal), el => el.child(div().id(`ph-share-${pane}`)
        .flex_none().flex().items_center().gap(4).px(6).h(20).rounded(5).text_size(11.5).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "tam-pane", kind: "popup", width: 250, height: 2 * 28 + FORMATS.length * 34 + DESTINATIONS.length * 26 + 30, props: { share: { terminal: p.terminal, pane } } });
        })
        .child(svg("mods/tam-pane/share.svg").size(13))
        .child("Share")))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
