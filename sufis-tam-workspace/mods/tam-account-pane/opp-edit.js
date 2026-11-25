// The Edit opportunity dialog: the pencil on an opp card opens this mod again as
// a dialog (props.editOpp). Save sends only the fields that changed to
// Salesforce, through a one-off headless Claude run that may call nothing but
// the Salesforce update tool, then updates the account's opps.json to match.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, props, closeOverlay, exec, readTextFile, writeTextFile, home } from "herdr";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UPDATE_TOOL = "mcp__claude_ai_Salesforce_sobject-mutations__updateSobjectRecord";

// Opportunity Type: label shown, value stored (Salesforce's picklist).
export const TYPES = [
  ["Annual contract - upfront pay", "Annual contract"],
  ["Monthly contract", "Monthly contract"],
  ["Annual contract - quarterly payment plan", "Annual contract - quarterly payment plan"],
  ["Annual contract - self serve", "Annual contract - self serve"],
  ["One time services", "One time services"],
];
// Stages depend on the record type: "New revenue – existing customer" opps use
// the lifecycle stages; the others (renewals, convert to annual, new revenue…)
// use the agreement stages.
const EXISTING = ["Awareness / Learning", "Implementation / Usage", "See the Value / Outcome", "Spend / Procurement", "Closed Won", "Closed Lost"];
const AGREEMENT = ["Problem Agreement", "Solution Agreement", "Priority Agreement", "Commercial Agreement", "Vendor Approval", "Closed Won", "Closed Lost"];
export function stagesFor(o) {
  const list = /existing customer/i.test(o.recordType ?? "") ? EXISTING : AGREEMENT;
  return o.stage && !list.includes(o.stage) ? [o.stage, ...list] : list;
}

// Each editable field: its key in opps.json, its Salesforce API name, and kind.
const FIELDS = [
  { key: "name", api: "Name", label: "Name", kind: "text", required: true },
  { key: "type", api: "Type", label: "Type", kind: "select" },
  { key: "stage", api: "StageName", label: "Stage", kind: "select", required: true },
  { key: "probability", api: "Probability", label: "Probability", kind: "percent" },
  { key: "totalCredit", api: "Total_Credit_Amount__c", label: "Total credit", kind: "money" },
  { key: "discountRate", api: "Discount_Rate__c", label: "Discount rate", kind: "percent" },
  { key: "closeDate", api: "CloseDate", label: "Close date", kind: "date", required: true },
  { key: "nextStepDate", api: "Next_Step_Date__c", label: "Next step date", kind: "date" },
  { key: "nextStep", api: "Next_Steps_USE_THIS_ONE__c", label: "Next steps", kind: "long" },
];

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

// A field's text as shown in the dialog, and back to a value (undefined: not valid).
function show(f, v) {
  if (v === null || v === undefined) return "";
  if (f.kind === "money") return String(Math.round(v * 100) / 100);
  return String(v);
}
function parse(f, text) {
  const s = (f.kind === "long" ? text.replace(/\r\n/g, "\n") : text).trim();
  if (f.kind === "text" || f.kind === "select" || f.kind === "long") return s || null;
  if (!s) return null;
  if (f.kind === "date") return validDate(s) ? s : undefined;
  const n = Number(s.replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (f.kind === "percent" && n > 100) return undefined;
  return n;
}

export const editMethods = {
  initEdit(cx) {
    const { editOpp: o, overlay } = props();
    // Keep the overlay id: props() after an await can belong to another copy of this mod.
    this.edit = { o, overlay, values: {}, open: null, cal: null, saving: false, error: null };
    this.inputs = {};
    for (const f of FIELDS) {
      this.edit.values[f.key] = show(f, o[f.key]);
      if (f.kind === "select") continue;
      const state = f.kind === "long"
        ? TextareaState.new({ value: this.edit.values[f.key], placeholder: "Oct 30 - What happened, and what's next", rows: 6 })
        : InputState.new({ value: this.edit.values[f.key], placeholder: f.kind === "date" ? "YYYY-MM-DD" : f.kind === "money" ? "0" : f.kind === "percent" ? "0–100" : "" });
      state.on("change", (_e, cx) => { this.edit.values[f.key] = state.value(); this.edit.error = null; cx.notify(); });
      this.inputs[f.key] = state;
    }
    this.handle = cx.focus_handle();
    this.inputs.name.focus();
  },

  // What changed, as Salesforce fields; or the first problem.
  editChanges() {
    const { o, values } = this.edit;
    const body = {};
    const local = {};
    for (const f of FIELDS) {
      const v = parse(f, values[f.key] ?? "");
      if (v === undefined) return { problem: `${f.label}: ${f.kind === "date" ? "use a date like 2026-12-31" : f.kind === "percent" ? "use a number from 0 to 100" : "use a number"}` };
      if (v === null && f.required) return { problem: `${f.label} can't be empty` };
      const before = parse(f, show(f, o[f.key]));
      if (v === before) continue;
      body[f.api] = v;
      local[f.key] = v;
    }
    return { body, local };
  },

  async saveEdit(cx) {
    const { body, local, problem } = this.editChanges();
    if (problem) { this.edit.error = problem; cx.notify(); return; }
    if (!Object.keys(body).length) { closeOverlay(this.edit.overlay); return; }
    const o = this.edit.o;
    this.edit.saving = true;
    this.edit.error = null;
    cx.notify();
    const ask = [
      `Load the tool ${UPDATE_TOOL} with ToolSearch, then call it exactly once to update the Salesforce Opportunity ${o.id}`,
      `(sobject-name "Opportunity", id "${o.id}") with this body, exactly as given: ${JSON.stringify(body)}.`,
      "Don't change any other field and don't call any other tool.",
      "Salesforce answers a successful update with an empty response such as {\"value\":\"\"}; that counts as success.",
      "Reply with exactly OK if the update succeeded, or ERROR: followed by Salesforce's error message if it failed.",
    ].join(" ");
    let reply = "";
    try {
      const r = await exec("/bin/sh", ["-c", 'cd "$HOME" && PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" exec claude -p "$0" --allowedTools "$1" --model claude-haiku-5-5 --output-format json --no-session-persistence',
        ask, UPDATE_TOOL], { timeout: 120000 });
      reply = String(JSON.parse(r.stdout || "{}").result ?? "").trim();
    } catch (e) {
      reply = `ERROR: ${e?.message ?? e}`;
    }
    if (!/^OK\b/.test(reply)) {
      this.edit.saving = false;
      this.edit.error = reply.replace(/^ERROR:\s*/, "") || "Salesforce didn't confirm the update.";
      cx.notify();
      return;
    }
    // Keep the pane in step until the next sync.
    const path = `${home()}/work/accounts/${o.folder}/opps.json`;
    try {
      const text = await readTextFile(path);
      const data = JSON.parse(text ?? "{}");
      const row = (data.rows ?? []).find((x) => x.id === o.id);
      if (row) {
        Object.assign(row, local);
        await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", text);
      }
    } catch {}
    closeOverlay(this.edit.overlay);
  },

  // A month grid for a date field; picking a day fills it in.
  calendar(f) {
    const t = theme();
    const cal = this.edit.cal;
    const first = new Date(Date.UTC(cal.y, cal.m, 1));
    const days = new Date(Date.UTC(cal.y, cal.m + 1, 0)).getUTCDate();
    const cells = [...Array(first.getUTCDay()).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
    const today = new Date().toISOString().slice(0, 10);
    const picked = this.edit.values[f.key];
    const step = (n) => (_e, cx) => { const d = new Date(Date.UTC(cal.y, cal.m + n, 1)); cal.y = d.getUTCFullYear(); cal.m = d.getUTCMonth(); cx.notify(); };
    const nav = (id, icon, fn) => div().id(id).size(22).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(fn).child(svg(ICON(icon)).size(12).text_color(t.dim));
    const rows = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return v_flex().ml(96).w(232).p(8).gap(2).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12)
      .child(h_flex().items_center().justify_between().mb(2)
        .child(nav(`cal-prev-${f.key}`, "chevron-left", step(-1)))
        .child(div().font_medium().child(`${MONTHS[cal.m]} ${cal.y}`))
        .child(nav(`cal-next-${f.key}`, "chevron-right", step(1))))
      .child(h_flex().children(["S", "M", "T", "W", "T", "F", "S"].map((d) => div().w(30).text_center().text_size(10.5).text_color(t.dim).child(d))))
      .children(rows.map((row, r) => h_flex().children(Array.from({ length: 7 }, (_, c) => {
        const d = row[c];
        if (!d) return div().w(30).h(24);
        const value = iso(cal.y, cal.m, d);
        const on = value === picked;
        return div().id(`cal-${f.key}-${r}-${c}`).w(30).h(24).flex().items_center().justify_center().rounded(4).cursor_pointer()
          .when(on, (el) => el.bg(t.accent).text_color("#ffffff"))
          .when(!on && value === today, (el) => el.border_1().border_color(t.accent))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.inputs[f.key].set_value(value); this.edit.values[f.key] = value; this.edit.cal = null; cx.notify(); })
          .child(String(d));
      }))));
  },

  renderEdit() {
    const t = theme();
    const e = this.edit;
    const o = e.o;
    const label = (s) => div().w(88).flex_none().text_size(12).text_color(t.dim).child(s);
    const box = (el, focused = false) => el.h(28).px(8).rounded(6).border_1().border_color(focused ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    const row = (f, control) => h_flex().gap(8).items_center().child(label(f.label)).child(control);
    const unit = (f, sign, before) => h_flex().flex_1().min_w(0).items_center().gap(4)
      .when(before, (el) => el.child(div().text_size(12.5).text_color(t.dim).child(sign)))
      .child(box(Input.new(this.inputs[f.key]).w(120)))
      .when(!before, (el) => el.child(div().text_size(12.5).text_color(t.dim).child(sign)));
    const select = (f, options) => {
      const value = e.values[f.key];
      const shown = options.find(([, v]) => v === value)?.[0] ?? value;
      return [row(f, h_flex().id(`sel-${f.key}`).flex_1().min_w(0).h(28).px(8).gap(6).items_center().rounded(6)
        .border_1().border_color(e.open === f.key ? t.accent : t.input).bg(t.raised).text_size(12.5).cursor_pointer()
        .hover((s) => s.border_color(t.accent))
        .on_click((_e, cx) => { e.open = e.open === f.key ? null : f.key; e.cal = null; cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().text_color(shown ? t.foreground : t.dim).child(shown || "--None--"))
        .child(svg(ICON("chevron-down")).size(12).text_color(t.dim).flex_none())),
      ...(e.open === f.key ? [v_flex().ml(96).p(4).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12.5)
        .children([...(f.required ? [] : [["--None--", ""]]), ...options].map(([text, v]) => h_flex().id(`opt-${f.key}-${v || "none"}`).h(26).px(8).gap(6).items_center().rounded(5)
          .cursor_pointer().hover((s) => s.bg(t.hover)).when(v === value, (el) => el.bg(t.selected))
          .on_click((_e, cx) => { e.values[f.key] = v; e.open = null; e.error = null; cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().child(text))
          .when(v === value, (el) => el.child(svg(ICON("check")).size(11).text_color(t.accent).flex_none()))))] : [])];
    };
    const date = (f) => {
      const v = e.values[f.key];
      const bad = v.trim() && !validDate(v.trim());
      return [row(f, h_flex().flex_1().items_center().gap(6)
        .child(Input.new(this.inputs[f.key]).w(120).h(28).px(8).rounded(6).border_1().border_color(bad ? t.blocked : t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(div().id(`cal-btn-${f.key}`).size(28).flex().items_center().justify_center().rounded(6).cursor_pointer()
          .border_1().border_color(e.cal?.key === f.key ? t.accent : t.input).bg(t.raised).hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => {
            const base = validDate(v.trim()) ? v.trim() : new Date().toISOString().slice(0, 10);
            e.cal = e.cal?.key === f.key ? null : { key: f.key, y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) - 1 };
            e.open = null;
            cx.notify();
          })
          .child(svg("mods/tam-account-pane/calendar.svg").size(14).text_color(t.dim)))),
      ...(e.cal?.key === f.key ? [this.calendar(f)] : [])];
    };
    const F = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
    const { body, problem } = this.editChanges();
    const changed = Object.keys(body ?? {}).length;
    const button = (id, text, primary, fn, off) => h_flex().id(id).h(28).px(12).items_center().rounded(6)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(off, (el) => el.opacity(0.5)).when(!off, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(fn))
      .child(text);
    // "+ Dated update" starts a new line at the top, the way these notes are kept.
    const stamp = () => {
      const now = new Date();
      const line = `${MONTHS[now.getMonth()]} ${now.getDate()} - `;
      const cur = this.inputs.nextStep.value();
      this.inputs.nextStep.set_value(cur.trim() ? `${line}\n\n${cur}` : line);
      e.values.nextStep = this.inputs.nextStep.value();
      this.inputs.nextStep.focus();
    };
    return v_flex().id("opp-edit").track_focus(this.handle)
      .on_key_down((ev, cx) => {
        if (ev.key !== "escape") return;
        cx.stop_propagation();
        if (e.open || e.cal) { e.open = null; e.cal = null; cx.notify(); } else closeOverlay(this.edit.overlay);
      })
      .w_full().p(16).gap(8).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_baseline().gap(6)
        .child(div().text_size(14).font_semibold().child("Edit opportunity"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(o.recordType ?? "")))
      .child(row(F.name, box(Input.new(this.inputs.name).flex_1().min_w(0))))
      .children(select(F.type, TYPES))
      .children(select(F.stage, stagesFor(o).map((s) => [s, s])))
      .child(row(F.probability, unit(F.probability, "%", false)))
      .child(row(F.totalCredit, unit(F.totalCredit, "$", true)))
      .child(row(F.discountRate, unit(F.discountRate, "%", false)))
      .children(date(F.closeDate))
      .children(date(F.nextStepDate))
      .child(h_flex().gap(8).items_start()
        .child(div().w(88).flex_none().pt(4).text_size(12).text_color(t.dim).child("Next steps (use this one)"))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(Textarea.new(this.inputs.nextStep).w_full().min_h(120).p(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
          .child(div().id("stamp").text_size(11.5).text_color(t.accent).cursor_pointer().hover((s) => s.underline())
            .on_click((_e, cx) => { stamp(); cx.notify(); }).child("+ Dated update"))))
      .when(Boolean(e.error ?? problem), (el) => el.child(div().text_size(12).text_color(t.blocked).child(e.error ?? problem)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim)
          .child(e.saving ? "Saving to Salesforce…" : changed ? `${changed} change${changed > 1 ? "s" : ""} to save to Salesforce` : "No changes yet"))
        .child(button("e-cancel", "Cancel", false, () => closeOverlay(this.edit.overlay), e.saving))
        .child(button("e-save", e.saving ? "Saving…" : "Save", true, (_e, cx) => this.saveEdit(cx), e.saving || !changed || Boolean(problem))));
  },
};
