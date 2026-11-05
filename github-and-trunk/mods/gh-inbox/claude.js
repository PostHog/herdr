// Starts Claude Code on a pull request: a new tab in the shown space, with what the
// panel knows about the PR in Claude's system prompt and an empty input to type into.

import { run, spaces, shared, knownAgents, notify } from "herdr";
import { TRUNK_REPO } from "./data.js";

// Herdr ships the agent icons in its own icons/ folder.
export const CLAUDE_ICON = "icons/claude.svg";

/**
 * @param pr       A PR as data.js shapes it. Queue rows for other people's PRs only
 *                 have repo, number, title and url; every other field is optional.
 * @param context  me: your GitHub login. review: the PR asks for your review.
 *                 status: the panel's next-step label. stack: the PR's stack group.
 *                 asOf: when the panel last refreshed (ms since the epoch).
 */
export async function startClaude(pr, context) {
  const space = spaces().find((s) => s.active);
  const name = `PR ${ref(pr)}`;
  try {
    const claude = await claudeArgv(space?.machine);
    run("tab.new", { name, space: space?.id, argv: [...claude, "--name", name, "--append-system-prompt", systemPrompt(pr, context)] });
  } catch (e) {
    notify({ title: `Couldn't start Claude Code on ${name}`, body: String(e?.message ?? e), level: "error" });
  }
}

const ref = (pr) => (pr.repo === TRUNK_REPO ? `#${pr.number}` : `${pr.repo}#${pr.number}`);

// How the space's machine starts Claude Code: the new-menu mod's cached agent list
// when it has one, else a fresh look, else plain `claude` from the shell's PATH.
async function claudeArgv(machine) {
  const find = (agents) => agents?.find((a) => a.key === "claude" && a.installed)?.run;
  const cached = find(shared("new-menu.agents")?.[machine ?? ""]);
  if (cached) return cached;
  try {
    return find(await knownAgents({ on: machine })) ?? ["claude"];
  } catch {
    return ["claude"];
  }
}

export function systemPrompt(pr, { me = null, review = false, status = null, stack = null, asOf = null } = {}) {
  const lines = [`We're in PR ${ref(pr)}: ${pr.title}`, pr.url, ""];
  lines.push(...facts(pr, { me, review, status }).map((fact) => `- ${fact}`));
  if (stack?.members.length > 1) lines.push("", ...stackLines(pr, stack));
  const when = asOf ? ` at ${new Date(asOf).toISOString()}` : "";
  lines.push("", `This is what the PR panel showed${when}. Check \`gh\` for anything newer.`);
  return lines.join("\n");
}

function facts(pr, { me, review, status }) {
  const out = [];
  if (pr.author) out.push(`Author: ${pr.author}${pr.author === me ? " (the user)" : ""}`);
  if (review) out.push("The user's review is requested.");
  if (pr.draft) out.push("Draft");
  if (pr.head) out.push(`Branch: ${pr.head} into ${pr.base}`);
  if (pr.additions != null) out.push(`Size: +${pr.additions} -${pr.deletions}`);
  if (status) out.push(`Next step: ${status}`);
  if (pr.checks?.total) out.push(ciLine(pr.checks));
  if (pr.approvedBy?.length) out.push(`Approved by: ${pr.approvedBy.join(", ")}`);
  if (pr.changesBy?.length) out.push(`Changes requested by: ${pr.changesBy.join(", ")}`);
  if (pr.requested?.length) out.push(`Review requested from: ${pr.requested.join(", ")}`);
  if (pr.unresolved) out.push(`Unresolved review threads: ${pr.unresolved}`);
  if (pr.conflicts) out.push("Has merge conflicts with its base branch");
  for (const v of pr.visual ?? []) out.push(visualLine(v));
  return out;
}

function ciLine({ pass, fail, running, cancelled, total }) {
  const parts = [`${pass} of ${total} passed`];
  if (fail) parts.push(`${fail} failing`);
  if (running) parts.push(`${running} running`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return `CI: ${parts.join(", ")}`;
}

function visualLine(v) {
  const what = { approve: `changes waiting for approval (${v.summary})`, running: "running", error: "errored" }[v.kind];
  return `Visual review, ${v.type}${v.partial ? " (partial)" : ""}: ${what} ${v.url}`;
}

// The stack only covers the user's own open PRs, chained by head and base branch.
function stackLines(pr, stack) {
  const n = stack.members.length;
  const layer = stack.members.findIndex((m) => m.pr.key === pr.key) + 1;
  return [
    `Layer ${layer} of a stack of ${n}, bottom first:`,
    ...stack.members.map(({ pr: p }, i) => `${i + 1}. ${ref(p)} ${p.title} (${p.head})${p.key === pr.key ? " <- this PR" : ""}`),
  ];
}
