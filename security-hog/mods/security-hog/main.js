import { View } from "gpui-kit";
import { props } from "herdr";
import { Sidebar } from "./sidebar.js";
import { FindingPane } from "./finding.js";

export default class SecurityHog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.view = p.view === "finding" ? new FindingPane() : new Sidebar();
    this.view.init(p, cx);
  }

  render(cx) {
    return this.view.render(cx);
  }
}
