// PostHog inbox and tasks. One mod, shown several ways by its props:
//   (none)             the sidebar block: Tasks over Inbox      sidebar.js
//   { view: "report" } a pane that shows the chosen report      report.js
//   { view: "pickup" | "cloud" | "new" | "action" | "menu" | "report-menu" }  dialogs.js
//   { view: "triage" } the inbox by keyboard, one at a time   triage.js
// PostHog is reached through phmcp.py (ph.js); tasks live in shared state (store.js).

import { View } from "gpui-kit";
import { props } from "herdr";
import { Sidebar } from "./sidebar.js";
import { ReportPane } from "./report.js";
import { Pickup, Cloud, NewTask, Action, Menu, ReportMenu } from "./dialogs.js";
import { Triage } from "./triage.js";

const VIEWS = { report: ReportPane, pickup: Pickup, cloud: Cloud, new: NewTask, action: Action, menu: Menu, "report-menu": ReportMenu, triage: Triage };

export default class PhInbox extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.view = new (VIEWS[p.view] ?? Sidebar)();
    this.view.init(p, cx);
  }

  render(cx) {
    return this.view.render(cx);
  }
}
