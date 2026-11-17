// A task whose last session closed keeps going: Herdr closes a space with no tabs, so its last
// tab becomes this one (the tasks mod's tasks.close-tab opens it). It offers a new session; the
// tasks mod closes this tab once the task has a session again (it may not be drawn by then).
// Props: { space }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, props, run, theme, shared, home } from "herdr";

// The account new Claude sessions start as, from the tasks mod's switcher: plain `claude` for main,
// else its launcher (~/.claude-accounts/claude-as <account>).
function claudeArgv() {
  const name = shared("tasks.account");
  const known = (shared("tasks.accounts") ?? []).some((a) => a.name === name);
  return name && name !== "main" && known ? [`${home()}/.claude-accounts/claude-as`, name] : ["claude"];
}


export default class TaskEmpty extends View {
  render() {
    const t = theme();
    const space = spaces().find((s) => s.id === props()?.space);
    return v_flex().size_full().items_center().justify_center().gap(10).bg(t.background)
      .child(div().text_size(15).font_medium().text_color(t.foreground).child(space?.name ?? "This task"))
      .child(div().text_size(12.5).text_color(t.muted).child("No sessions open. The task, its PRs and worktrees stay."))
      .child(h_flex().gap(8)
        .child(div().id("te-claude").h(30).px(12).flex().items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground)
          .text_size(12.5).font_medium().cursor_pointer().hover((x) => x.opacity(0.9))
          // On a devbox there's only its own claude (accounts are this Mac's).
          .on_click(() => { if (space) run("tab.new", { space: space.id, argv: space.machine ? ["claude"] : claudeArgv() }); })
          .child("New Claude session"))
        .child(div().id("te-shell").h(30).px(12).flex().items_center().rounded(7).border_1().border_color(t.input).bg(t.raised)
          .text_size(12.5).text_color(t.foreground).cursor_pointer().hover((x) => x.bg(t.hover))
          .on_click(() => { if (space) run("tab.new", { space: space.id }); })
          .child(space?.machine ? "Shell on the devbox" : "Shell")));
  }
}
