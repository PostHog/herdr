import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, closeOverlay, notify, props, run, spaces, theme, window as appWindow } from "herdr";
import {
  boxName, commandInTab, findCheckout, loginShell, openInBrowser,
  runDetached, startUiForward, stopUiForward, uiForward,
} from "./hogli.js";

const COMMANDS = [
  { label: "Status", args: ["devbox:status"] },
  { label: "Logs", args: ["devbox:logs", "-f"] },
  { label: "Sync my checkout", args: ["devbox:sync"] },
  { label: "Open in VS Code", args: ["devbox:open", "--vscode"], detached: true },
  { label: "Open in Cursor", args: ["devbox:open", "--cursor"], detached: true },
  { label: "Restart", args: ["devbox:restart"] },
  { label: "Update template", args: ["devbox:update"] },
  { label: "Free disk space", args: ["devbox:cleanup:disk"] },
  { label: "Doctor", args: ["devbox:doctor"], targeted: false },
  { label: "Stop devbox", args: ["devbox:stop"], danger: true },
];

export default class DevboxMenu extends View {
  init(_props, cx) {
    const { machine = null, target = "", action = null } = props() ?? {};
    this.machineName = machine;
    this.box = target ? boxName({ target }) : "";
    this.checkout = undefined;
    this.shell = null;
    this.starting = false;
    this.error = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      [this.checkout, this.shell] = await Promise.all([findCheckout(), loginShell()]);
      cx.notify();
      if (action === "ui") this.openUi(cx);
    });
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  openUi(cx) {
    const running = uiForward(this.machineName);
    if (running?.port) {
      openInBrowser(running.port, appWindow().platform);
      this.close();
      return;
    }
    if (running || !this.checkout || this.starting) return;
    this.starting = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const port = await startUiForward({ machineName: this.machineName, box: this.box, checkout: this.checkout, shell: this.shell, cx });
        await openInBrowser(port, appWindow().platform);
        this.close();
      } catch (error) {
        this.error = String(error.message ?? error);
        this.starting = false;
        cx.notify();
      }
    });
  }

  stopUi(cx) {
    const running = uiForward(this.machineName);
    if (!running) return;
    cx.spawn(async (cx) => { await stopUiForward(running.address); cx.notify(); });
  }

  runCommand(command, cx) {
    const request = { args: command.args, box: this.box, checkout: this.checkout, shell: this.shell, targeted: command.targeted !== false };
    if (command.detached) {
      cx.spawn(async () => {
        try {
          await runDetached(request);
        } catch (error) {
          notify({ title: `${command.label} failed`, body: String(error.message ?? error), level: "error" });
        }
      });
      this.close();
      return;
    }
    const argv = commandInTab(request);
    const name = `${this.box} · ${command.label}`;
    const home = spaces().find((s) => !s.machine && s.folder === this.checkout);
    if (home) run("tab.new", { space: home.id, folder: this.checkout, name, argv });
    else run("space.new", { name: "PostHog", folder: this.checkout, argv });
    this.close();
  }

  render(_cx) {
    const t = theme();
    const running = uiForward(this.machineName);
    const ready = Boolean(this.checkout && this.shell);

    const item = (id, label, { detail = null, detailColor = t.dim, color = t.foreground, enabled = ready, onClick }) =>
      h_flex().id(id).h(28).px(10).gap(8).items_center().rounded(6).text_size(12.5)
        .text_color(enabled ? color : t.dim)
        .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
        .child(div().flex_1().truncate().child(label))
        .when(Boolean(detail), (el) => el.child(div().flex_none().text_size(11.5).text_color(detailColor).child(detail)));

    const uiDetail = this.starting ? "starting…" : running?.port ? `localhost:${running.port}` : running ? "starting…" : null;
    const menu = v_flex().w_full().p(5).gap(1).bg(t.popover).text_color(t.foreground)
      .child(h_flex().h(26).px(10).items_center().text_size(11.5).text_color(t.dim).child(div().truncate().child(this.box)))
      .child(item("ui", "Open PostHog UI", {
        detail: uiDetail,
        detailColor: running?.port ? t.accent : t.dim,
        enabled: ready || Boolean(running?.port),
        onClick: (cx) => this.openUi(cx),
      }));

    if (running) menu.child(item("ui-stop", "Stop forwarding", { enabled: true, onClick: (cx) => this.stopUi(cx) }));
    if (this.error) menu.child(div().id("error").px(10).py(4).text_size(11.5).text_color(t.blocked).child(this.error));
    if (this.checkout === null) {
      menu.child(div().px(10).py(4).text_size(11.5).text_color(t.blocked)
        .child("No PostHog checkout with bin/hogli found in ~/workspace/posthog, ~/posthog or your local spaces."));
    } else if (this.checkout === undefined) {
      menu.child(div().px(10).py(4).text_size(11.5).text_color(t.dim).child("Looking for your PostHog checkout…"));
    }

    menu.child(div().h(1).mx(6).my(4).bg(t.border));
    for (const command of COMMANDS) {
      menu.child(item(`cmd-${command.args.join("-")}`, command.label, {
        color: command.danger ? t.blocked : t.foreground,
        onClick: (cx) => this.runCommand(command, cx),
      }));
    }
    return menu;
  }
}
