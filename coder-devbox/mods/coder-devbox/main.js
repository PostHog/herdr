import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, closeOverlay, machines, props, run, spaces, theme, window as appWindow } from "herdr";
import {
  browserOpener, coderUsername, coderWorkspace, collectEndedForward, commandInTab, findCheckout,
  hogliCommands, hogliTarget, loginShell, openInBrowser, runDetached, startUiForward, stopUiForward, uiForward,
} from "./hogli.js";

const COMMANDS = [
  { label: "Status", args: ["devbox:status"] },
  { label: "Logs", args: ["devbox:logs", "-f"] },
  { label: "Sync my checkout", args: ["devbox:sync"] },
  { label: "Log in to Claude", args: ["devbox:claude:login"] },
  { label: "Log in to GitHub", args: ["devbox:gh:login"] },
  { label: "Open in VS Code", args: ["devbox:open", "--vscode"], detached: true },
  { label: "Open in Cursor", args: ["devbox:open", "--cursor"], detached: true },
  { label: "Restart", args: ["devbox:restart"] },
  { label: "Update template", args: ["devbox:update"] },
  { label: "Free disk space", args: ["devbox:cleanup:disk"] },
  { label: "Doctor", args: ["devbox:doctor"], targeted: false },
  { label: "Stop devbox", args: ["devbox:stop"], danger: true },
];

const START_WATCH_MS = 500;
const REMOTE_CONTROL_TAB = "Claude Remote Control";
// Remote Control lives as long as the terminal that runs it, so it gets its own tab on the box.
const REMOTE_CONTROL_ARGV = ["bash", "-lc", "cd ~/posthog 2>/dev/null; claude remote-control; exec bash -l"];

export default class DevboxMenu extends View {
  init(_props, cx) {
    const { machine = null, target = "", action = null } = props() ?? {};
    this.machineName = machine;
    this.box = target ? coderWorkspace(target) : { workspace: "", owner: null };
    this.target = null;
    this.checkout = undefined;
    this.commands = null;
    this.shell = null;
    this.starting = false;
    this.busyCommand = null;
    this.error = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      const [checkout, shell, me] = await Promise.all([findCheckout(), loginShell(), coderUsername()]);
      this.checkout = checkout;
      this.shell = shell;
      this.commands = checkout ? await hogliCommands(checkout) : null;
      try {
        this.target = hogliTarget(this.box, me);
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      cx.notify();
      if (action === "ui") this.openUi(cx);
    });
  }

  ready() {
    return Boolean(this.checkout && this.shell && this.target);
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
    if (running || !this.ready() || this.starting) return;
    this.starting = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await collectEndedForward(this.machineName);
        await startUiForward({
          machineName: this.machineName, target: this.target, checkout: this.checkout,
          shell: this.shell, opener: browserOpener(appWindow().platform),
        });
        for (;;) {
          await cx.sleep(START_WATCH_MS);
          const forward = uiForward(this.machineName);
          if (forward?.port) return this.close();
          if (!forward) {
            this.error = (await collectEndedForward(this.machineName)) ?? "hogli devbox:forward stopped.";
            break;
          }
        }
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      this.starting = false;
      cx.notify();
    });
  }

  stopUi(cx) {
    const running = uiForward(this.machineName);
    if (!running) return;
    cx.spawn(async (cx) => { await stopUiForward(running.address); cx.notify(); });
  }

  runCommand(command, cx) {
    const request = { args: command.args, target: command.targeted === false ? null : this.target, checkout: this.checkout, shell: this.shell };
    if (command.detached) {
      this.busyCommand = command.label;
      this.error = null;
      cx.notify();
      cx.spawn(async (cx) => {
        try {
          await runDetached(request);
          this.close();
        } catch (error) {
          this.error = `${command.label} failed: ${error.message ?? error}`;
        }
        this.busyCommand = null;
        cx.notify();
      });
      return;
    }
    const argv = commandInTab(request);
    const name = `${this.box.workspace} · ${command.label}`;
    const home = spaces().find((s) => !s.machine && s.folder === this.checkout);
    if (home) run("tab.new", { space: home.id, folder: this.checkout, name, argv });
    else run("space.new", { name: "PostHog", folder: this.checkout, argv, machine: "" });
    this.close();
  }

  remoteControlSpace() {
    return spaces().find((s) => s.machine === this.machineName && s.name === REMOTE_CONTROL_TAB);
  }

  startRemoteControl() {
    const running = this.remoteControlSpace();
    if (running) run("space.select", { id: running.id });
    else run("space.new", { name: REMOTE_CONTROL_TAB, machine: this.machineName, argv: REMOTE_CONTROL_ARGV });
    this.close();
  }

  render(_cx) {
    const t = theme();
    const running = uiForward(this.machineName);
    const ready = this.ready();

    const item = (id, label, { detail = null, detailColor = t.dim, color = t.foreground, enabled = ready, onClick }) =>
      h_flex().id(id).h(28).px(10).gap(8).items_center().rounded(6).text_size(12.5)
        .text_color(enabled ? color : t.dim)
        .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
        .child(div().flex_1().truncate().child(label))
        .when(Boolean(detail), (el) => el.child(div().flex_none().text_size(11.5).text_color(detailColor).child(detail)));

    const uiDetail = running?.port ? `localhost:${running.port}` : running || this.starting ? "starting…" : null;
    const menu = v_flex().w_full().p(5).gap(1).bg(t.popover).text_color(t.foreground)
      .child(h_flex().h(26).px(10).items_center().text_size(11.5).text_color(t.dim).child(div().truncate().child(this.box.workspace)))
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

    menu.child(item("remote-control", "Claude Remote Control", {
      detail: this.remoteControlSpace() ? "open" : null,
      detailColor: t.accent,
      enabled: machines().some((m) => m.name === this.machineName && m.state === "connected"),
      onClick: () => this.startRemoteControl(),
    }));

    menu.child(div().h(1).mx(6).my(4).bg(t.border));
    for (const command of COMMANDS) {
      if (this.commands && !this.commands.has(command.args[0])) continue;
      menu.child(item(`cmd-${command.args.join("-")}`, command.label, {
        color: command.danger ? t.blocked : t.foreground,
        detail: this.busyCommand === command.label ? "opening…" : null,
        enabled: (command.targeted === false ? Boolean(this.checkout && this.shell) : ready) && !this.busyCommand,
        onClick: (cx) => this.runCommand(command, cx),
      }));
    }
    return menu;
  }
}
