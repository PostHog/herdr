// A dialog for the update lag: Herdr and herdr-core update by themselves, but only to
// releases that have been public for a number of days. lag.py does the work.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, props, closeOverlay, updates, checking } from "herdr";

const LAGS = [3, 7, 14];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NAMES = { app: "Herdr", core: "herdr-core" };

const day = (iso) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

export default class UpdateLag extends View {
  init(_props, cx) {
    this.status = null;
    this.busy = null;
    this.error = null;
    this.confirm = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.read();
      cx.notify();
    });
  }

  lag(args, timeout = 30000) {
    return exec("/usr/bin/python3", ["-I", `${appHome()}/mods/update-lag/lag.py`, ...args], { timeout });
  }

  async read() {
    try {
      this.status = JSON.parse((await this.lag(["status", "--json"])).stdout);
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
  }

  // Letting a release through downloads and checks it, so allow ten minutes.
  act(label, args, cx) {
    if (this.busy) return;
    this.busy = label;
    this.error = null;
    this.confirm = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.lag(args, 600000);
        if (result.code) this.error = (result.stderr || result.stdout || `lag.py ended with ${result.code}`).trim().split("\n").pop();
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      await this.read();
      this.busy = null;
      cx.notify();
    });
  }

  // A second click within the same dialog confirms.
  twice(key, label, args, cx) {
    if (this.confirm === key) return this.act(label, args, cx);
    this.confirm = key;
    cx.notify();
  }

  button(t, id, label, onClick, { danger = false, active = false } = {}) {
    const idle = !this.busy;
    return div()
      .id(id)
      .px(12)
      .py(5)
      .rounded(7)
      .border_1()
      .border_color(active ? t.accent : t.border)
      .bg(t.raised)
      .text_size(13)
      .text_color(danger ? t.blocked : t.foreground)
      .opacity(idle ? 1 : 0.5)
      .when(idle, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .child(label);
  }

  row(t, kind) {
    const running = updates()[kind]?.version;
    const k = this.status.kinds[kind];
    const next = k.waiting[k.waiting.length - 1];
    const behind = next ? `${next.version} from ${day(next.due)}` : "nothing newer is waiting";
    return h_flex()
      .w_full()
      .py(9)
      .gap(12)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(div().w(96).text_size(14).text_color(t.foreground).child(NAMES[kind]))
      .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.muted).truncate().child(`running ${running ?? "?"}, allowed up to ${k.offers ?? "?"}`))
      .child(div().flex_none().text_size(12.5).text_color(next ? t.foreground : t.dim).child(behind));
  }

  render() {
    const t = theme();
    const s = this.status;
    const done = this.button(t, "ul-done", "Done", () => closeOverlay(props().overlay));
    const note = (text, color = t.dim) => div().text_size(12.5).line_height("18px").text_color(color).child(text);
    const root = v_flex()
      .id("root")
      .w_full()
      .p(20)
      .gap(12)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Update lag"))
          .when(Boolean(this.busy), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.working).spin(900))),
      );

    if (!s) return root.child(note(this.error ?? "Reading…", this.error ? t.blocked : t.dim)).child(h_flex().justify_end().child(done));

    if (!s.supported) {
      return root.child(note("This piece works on macOS with Apple Silicon only.")).child(h_flex().justify_end().child(done));
    }

    if (!s.installed) {
      const u = updates();
      const args = ["install", "--app", u.app.version, ...(u.core.version ? ["--core", u.core.version] : [])];
      return root
        .child(note("Herdr downloads every release as soon as it ships and installs it on the next quit."))
        .child(note(`Set this up and Herdr and herdr-core still update by themselves, but only to a release that has been out for ${s.lag_days} days. Each one is checked against Herdr's signature first.`))
        .child(note("It adds a background job for your user and sets one environment variable. Remove takes both away."))
        .when(Boolean(this.error), (el) => el.child(note(this.error, t.blocked)))
        .child(h_flex().gap(8).justify_end().child(this.button(t, "ul-setup", this.busy ? "Setting up…" : "Set up", (_e, cx) => this.act("install", args, cx))).child(done));
    }

    const newest = ["app", "core"].flatMap((kind) => s.kinds[kind].waiting.slice(-1).map((w) => `${NAMES[kind]} ${w.version}`)).join(" and ");
    return root
      .child(note(s.hold ? "On hold: no release is let through until you resume." : `Herdr and herdr-core update by themselves, ${s.lag_days} days behind.`, s.hold ? t.ansi3 : t.dim))
      .when(s.app_uses_mirror === false, (el) => el.child(note("Quit and reopen Herdr to start. This window still reads the live feed.", t.ansi3)))
      .child(v_flex().child(this.row(t, "app")).child(this.row(t, "core")))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().text_size(12.5).text_color(t.dim).child("Days behind"))
          .children(LAGS.map((n) => this.button(t, `ul-lag-${n}`, String(n), (_e, cx) => this.act("lag", ["set-lag", String(n)], cx), { active: n === s.lag_days }))),
      )
      .when(Boolean(this.error), (el) => el.child(note(this.error, t.blocked)))
      .when(this.busy === "latest", (el) => el.child(note("Downloading and checking the newest releases. This can take a minute.")))
      .child(
        h_flex()
          .gap(8)
          .child(s.hold
            ? this.button(t, "ul-resume", "Resume", (_e, cx) => this.act("resume", ["resume"], cx))
            : this.button(t, "ul-hold", "Hold", (_e, cx) => this.act("hold", ["hold"], cx)))
          .when(Boolean(newest) && !s.hold, (el) => el.child(this.button(t, "ul-latest", this.confirm === "latest" ? `Take ${newest} now?` : "Take the latest now", (_e, cx) => this.twice("latest", "latest", ["sync", "--lag-days", "0"], cx))))
          .child(this.button(t, "ul-remove", this.confirm === "remove" ? "Remove the lag?" : "Remove", (_e, cx) => this.twice("remove", "remove", ["uninstall"], cx), { danger: true }))
          .child(div().flex_1())
          .child(done),
      );
  }
}
