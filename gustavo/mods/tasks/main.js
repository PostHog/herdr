// Tasks: each space is a task. A task lists its sessions (the space's tabs and the agents in them)
// and its pull requests, with what happens next for each PR.
// PRs reach a task two ways: the Claude Code hook ~/.claude/hooks/herdr-task-pr.sh labels the
// terminal that ran `gh pr create` with `task-pr/<owner>/<repo>#<n>=<url>`, and "+ PR" attaches
// one by hand. Either way the PR is kept in shared "tasks.prs" until the task closes, merged or not.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { MAIN, ACCOUNTS, SESSION_ACCOUNTS, claudeArgv, defaultAccount, readAccounts, ensureLauncher, sessionAccount } from "./accounts.js";
import { readSlack, readAlerts, SlackError, channelName } from "./slack.js";
import { readTickets, needsTeam, SupportError, viewUrl as supportViewUrl, readShifts, heroAt, scheduleUrl } from "./support.js";
import { PRIVATE, loadPrivate } from "./private.js";
import { SIDE_DRAG, UNPINNING, columns, pinned, pin, unpin, prune } from "./side.js";
import { spaces, agents, terminals, panes, machines, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, exec, props, layout, notify, home, appHome, readTextFile, writeTextFile, nextCommand, pickFolder, playSound } from "herdr";

const PRS = "tasks.prs"; // { [spaceId]: { [prKey]: url } }
const HIDDEN = "tasks.hidden"; // { [spaceId]: [prKey] }: detached by hand, so a hook label can't bring it back
// { [spaceId]: { [worktreePath]: true | false } }: attached by hand (true), or removed by hand from
// the ones a task gets on its own (false): those whose branch is one of its PRs', or where hogli
// was started for it (shared "hogli.links").
const WORKTREES = "tasks.worktrees";
// [{ id, name, machine, folder, at, prs, worktrees, sessions: [{ name, title, claude, sessionId, cwd }] }],
// newest first: archived tasks. Archiving closes the space (its programs end); restoring makes it
// again and resumes each Claude conversation (`claude --resume`). Only here can a task be deleted.
const ARCHIVE = "tasks.archive";
// [repo folder]: the repos whose worktrees the Worktrees section (and a task's + list) shows,
// added by hand. Default: PostHog's own checkout.
const REPOS = "tasks.repos";
// The tab tasks.close-tab closes (set just before running it: commands take no arguments here).
const CLOSING = "tasks.closing";
const RESTARTING = "tasks.restarting"; // the tab to restart, set by other mods before run("tasks.restart-tab")
// { [spaceId]: { created, updated } } (ms): when each task was made and last changed, for sorting.
// Herdr doesn't keep either: created is when the panel first saw the task (its terminals' start,
// for tasks from before), updated the latest change of state in any of its sessions.
const TIMES = "tasks.times";
// { space, tab, at }: a session opened from elsewhere (the Inbox); the tree opens its task.
const REVEAL = "tasks.reveal";
const SORTS = [
  { id: "manual", label: "Manual", tip: "Your order: drag a task's title to move it" },
  { id: "updated", label: "Updated", tip: "Last updated first" },
  { id: "created", label: "Created", tip: "Newest first" },
];
const SETUP = "tasks.setup"; // [spaceId]: spaces that aren't tasks (configuring Herdr, say), listed apart under Setup
const PARENTS = "tasks.parents"; // { [tabId]: parentTabId }: a session dragged onto another one in its task
const DEVBOX_SPACE = "tasks.devboxSpace"; // the space holding one tab per devbox (its start, stop, a shell)
const DEVBOX_SPACE_NAME = "Devboxes";
// Loose Claude sessions, tied to no task (a quick question): one tab each in this space, listed
// under Sessions below the tasks. Dragging one onto a task's title moves it into that task.
const LOOSE_SPACE = "tasks.looseSpace";
const CARD_EXTRA = 2 + 8 + 6; // sectionCard: border, padding, margin under it
const LOOSE_SPACE_NAME = "Sessions";
// Devboxes are off for now (the user's call, 2026-11-05: they didn't work reliably). The code
// stays; this turns off the sidebar section, Run in, Send to a devbox and the machine sync.
const DEVBOXES_ON = false;
const DEVBOXES = "tasks.devboxes"; // [{ name, label, status }]: your devboxes, for the bottom block
// A new task can run on a devbox made for it alone (the user's call, 2026-11-05): Archive stops
// that devbox, Clean up deletes it. Separate from DEVBOXES_ON, which stays off.
const DEVBOX_TASKS = true;
// The Devboxes section alone (the user's ask, 2026-11-09): each devbox's state in Coder, whether
// Herdr reaches it, Start/Stop and Reconnect. Separate from DEVBOXES_ON (Send to a devbox, machine
// sync), which stays off.
const DEVBOX_LIST = true;
// { [machine]: workspace }: the devboxes made for a task, the only ones a task's end stops or deletes.
const TASK_DEVBOXES = "tasks.taskDevboxes";
const BRANCHES = "tasks.branches"; // { [spaceId]: [branch] }: its PRs' head branches, so the hogli panel can tell a worktree's task
const ATTACH = "tasks.attach"; // [{ name, key, url, at }]: PRs for a task being created, attached once it exists
const TODOS = "tasks.todos"; // [{ id, text, done, at }]: the to-do list, open ones first
const PRINFO = "tasks.prinfo"; // { [prKey]: what GitHub says }, shared so the inbox needn't ask again
const ASKING = "tasks.asking"; // { [terminal address]: question }: sessions whose last message asks you something
// { at, items, errors, error, setup, busy }: what waits on you in Slack (slack.js), read by the top
// part every SLACK_EVERY_MS; the Inbox shows it and counts it.
const SLACK = "tasks.slack";
// Slack is still read and shared (tasks.slack), but its items stay out of the Inbox and its count
// until they're right (user, 2026-11-06). True brings back its sections, note and Connect card.
const SLACK_IN_INBOX = false;
const SLACK_ASK = "tasks.slackAsk"; // ms: the Inbox asked for a fresh read now
const SLACK_EVERY_MS = 3 * 60000; // a read is a few Slack API calls (slack.js), seconds and free
// the team's alerts channel on its own, read by the top part every ALERTS_EVERY_MS: { at, items, error },
// items = each alert's newest message (firing or resolved). Firing ones show in the Inbox even with
// SLACK_IN_INBOX off, and every change is a Herdr toast (announceAlerts).
const ALERTS = "tasks.alerts";
const ALERTS_SEEN = "tasks.alertsSeen"; // { [alert id]: { key, firing } }: what the toasts already said
const ALERTS_EVERY_MS = 60000; // one Slack API call
const ALERT_FRESH_S = 15 * 60; // on a first read, only alerts this recent get a toast
// Support hero (support.js): Team Feature Flags' unresolved PostHog support tickets, read through
// PostHog's MCP server by the top part every SUPPORT_EVERY_MS: { at, items, error, setup, busy }.
// The Support hero section lists them all; the Inbox shows and counts the ones that wait on the
// team (new, or with unread customer messages), and each new one is a toast.
const SUPPORT = "tasks.support";
const SUPPORT_ASK = "tasks.supportAsk"; // ms: the Inbox or the section asked for a fresh read now
const SUPPORT_SEEN = "tasks.supportSeen"; // { [ticket id]: unread count }: what the toasts already said
const SUPPORT_EVERY_MS = 60000; // in your support hero weeks; a read is one MCP session, a few seconds
const SUPPORT_IDLE_MS = 5 * 60000; // the other weeks
// The support hero rotation (incident.io, support.js readShifts), read by the top part every
// HERO_EVERY_MS: { at, shifts: [{ name, me, start, end }], error, setup }. In your weeks the
// tickets get a card at the top of the sidebar, count in the Inbox and make toasts; the other
// weeks they show without counting.
const HERO = "tasks.hero";
const HERO_ASK = "tasks.heroAsk"; // ms: asked for a fresh read now
const HERO_EVERY_MS = 15 * 60000;
// { key: version }: Inbox items from outside the sessions (Slack, review requests) put aside until
// they change (a new message, an edit, a new push).
const EXT_DISMISSED = "tasks.extDismissed";
const VIEWS = "main-stack"; // the layout stack of the main area: "main" (the tab and the sessions beside it), "drop" (where a dragged session goes), "inbox" (a row: this mod's inbox, then gh-inbox's merge part)
const DRAG_PX = 5;
const SECTION_DRAG = "sidebar.drag"; // shared: { block, at }: a sidebar section being dragged, across blocks
const LISTS = "sidebar-lists"; // the layout column whose blocks the sections are, in their order

// PostHog devboxes (Coder workspaces "devbox-<user>[-<label>]"), reached over `ssh coder.<name>`
// as `hogli devbox:setup` configures it. A task can run on one: its space lives on that machine.
const CODER = () => `${home()}/.hogli/bin/coder`;
// How Herdr reaches a devbox: Coder's ssh (as ~/.ssh/config's "coder.*") with --disable-autostart,
// given as options so ~/.ssh/config stays as hogli made it. Herdr reconnects its machines on its
// own, and a plain `ssh coder.<ws>` starts a devbox that was stopped (by Archive, or Coder's
// schedule). Machines added before point at "coder.<workspace>".
const DEVBOX_SSH_OPTS = () => ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR", "-o", `ProxyCommand=${CODER()} ssh --stdio --disable-autostart --ssh-host-prefix coder. %h`];
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const devboxVia = (ws) => `ssh ${DEVBOX_SSH_OPTS().map(shq).join(" ")} coder.${ws}`;
const addDevboxArgs = (ws, name) => ["machine", "add", "--via", devboxVia(ws), "--name", name, "--install", "--json"];
const reachesDevbox = (target, ws) => target === `coder.${ws}` || String(target ?? "").endsWith(` coder.${ws}`);
const POSTHOG = () => `${home()}/dev/posthog/posthog`; // where bin/hogli is
const DEVBOX_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const devboxMachine = (label) => `devbox-${label}`;
// A task name as a devbox label: lowercase letters, digits and dashes, at most 24.
const labelFor = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "") || "task";
// A task's own devbox: its name, cut so "devbox-<user>-<label>" fits Coder's 32 characters, and 4
// random hex digits so two tasks never share one (hex can't end in hogli's reserved "-eu").
const CODER_NAME_MAX = 32;
const taskDevboxLabel = (name, user) => {
  const room = CODER_NAME_MAX - `devbox-${user}-`.length - 5;
  const base = labelFor(name).slice(0, Math.max(room, 1)).replace(/-+$/, "") || "task";
  return `${base}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
};
// Installs the PR hook on a devbox: $1 its text, $2 the matcher, $3 the command. `hc` there may
// be off the hook's PATH, so the hook gets its full path.
const PR_HOOK_MATCHER = "Bash|mcp__github__create_pull_request";
const PR_HOOK_COMMAND = "~/.claude/hooks/herdr-task-pr.sh 2>/dev/null || true";
const INSTALL_PR_HOOK = `set -e
mkdir -p "$HOME/.claude/hooks"
f="$HOME/.claude/hooks/herdr-task-pr.sh"
printf '%s' "$1" > "$f"
hc_bin=$(command -v hc || true)
if [ -n "$hc_bin" ]; then sed -i.bak "s|hc label|\\"$hc_bin\\" label|" "$f" && rm -f "$f.bak"; fi
chmod +x "$f"
s="$HOME/.claude/settings.json"
[ -s "$s" ] || echo '{}' > "$s"
jq --arg m "$2" --arg c "$3" 'if ([.hooks.PostToolUse[]?.hooks[]?.command] | index($c)) then . else .hooks.PostToolUse += [{matcher: $m, hooks: [{type: "command", command: $c, timeout: 10}]}] end' "$s" > "$s.tmp"
mv "$s.tmp" "$s"`;
// git's ssh signer on a devbox (gpg.ssh.program). The key stays on the Mac and signs through the
// agent the connection forwards (~/.ssh/config's "Host coder.*" IdentityAgent: the one that holds
// the signing key). Herdr's sessions outlive the connection that started them, so their
// SSH_AUTH_SOCK may be gone: it uses the newest live forwarded agent that holds the key.
const GIT_SSH_SIGN = `#!/bin/sh
# git's ssh signer (gpg.ssh.program), set up by Herdr's Tasks mod: signs through the newest live
# forwarded agent that holds the signing key, as a session's own SSH_AUTH_SOCK may be gone.
key=$(git config --get user.signingkey | sed 's/^key:://' | cut -d' ' -f2)
found=
for s in "$SSH_AUTH_SOCK" $(ls -t /tmp/auth-agent*/listener.sock 2>/dev/null); do
  if [ -S "$s" ] && SSH_AUTH_SOCK="$s" timeout 5 ssh-add -L 2>/dev/null | grep -qF -- "$key"; then
    export SSH_AUTH_SOCK="$s"
    found=1
    break
  fi
done
[ -n "$found" ] || echo "No forwarded ssh agent holds the signing key: is the Mac connected (Herdr, or ssh coder.<devbox>)?" >&2
exec ssh-keygen "$@"
`;
const INSTALL_GIT_SIGNER = `set -e
mkdir -p "$HOME/.local/bin"
f="$HOME/.local/bin/git-ssh-sign"
printf '%s' "$1" > "$f.tmp" && chmod +x "$f.tmp" && mv "$f.tmp" "$f"
git config --global gpg.ssh.program "$f"`;
// Where Claude Code keeps a conversation for a folder: ~/.claude/projects/<folder, non-alnum → ->.
const projectDir = (folder) => folder.replace(/[^A-Za-z0-9]/g, "-");

// Types `cd <cwd> && <argv>` into a terminal sitting at its shell.
async function typeInShell(terminal, cwd, argv) {
  const q = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);
  const line = `${cwd ? `cd ${q(cwd)} && ` : ""}${argv.map(q).join(" ")}`;
  // Without HC_TERMINAL_ID, so hc types the line as is (from inside a terminal it tags who sent it).
  const r = await exec("env", ["-u", "HC_TERMINAL_ID", "hc", "send", "--force", terminal, line]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc send exited ${r.code}`);
}

// Resuming Claude after a reboot. The hook ~/.claude/hooks/herdr-claude-session.sh labels each
// terminal with its Claude session (claude.session, claude.cwd, claude.account, claude.at = when it
// started, ms) and drops the labels when the user quits Claude. A reboot (or core crash) brings
// every kept terminal back as a plain shell with the same address and labels, so a labelled
// terminal at its shell whose session started before the core did lost its Claude.
const RESUMED = "tasks.resumed"; // { terminal address: core start (ms) it was resumed after }, so once per boot
const SHELL = /^-?(zsh|bash|sh|fish)$/;
const LABEL = /^task-pr\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const DEFAULT_OWNER = "PostHog";
const DEFAULT_REPO = "posthog";
// Offered in a PR's "Request review" list; picked when no owner file covers the PR.
const shortReviewer = (r) => r.replace(/^PostHog\//, "");
const DISMISSED = "tasks.dismissed"; // { terminal address: its seq when dismissed }: Inbox items put aside until the session changes
const NEWTASK = "tasks.newtask"; // { id, at, message, title, repo, where }: the New task dialog's ask, which the top block carries out
// An image in a task's message: Claude gets its path and reads it, as with one dropped in its prompt.
const IMAGE_REF = /\[Image #\d+: [^\]]+\]/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|tiff?)$/i;
// The clipboard's image as a PNG file (screenshots copy as PNG; AppleScript converts the rest).
const SAVE_CLIPBOARD_PNG = `on run argv
  set f to POSIX file (item 1 of argv)
  set d to the clipboard as «class PNGf»
  set h to open for access f with write permission
  set eof h to 0
  write d to h
  close access h
end run`;
// A task named after its first message: the first line, cut at a word near 48 characters.
const titleFrom = (message) => {
  const line = message.replace(IMAGE_REF, "").split("\n").find((x) => x.trim())?.trim() ?? "";
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 24 ? cut.lastIndexOf(" ") : 48).trim()}…`;
};
const REFRESH_MS = 60000;
const ICON = (name) => `mods/tasks/icons/${name}.svg`;
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

const prKey = (owner, repo, number) => `${owner}/${repo}#${number}`;
const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null));

// The system browser, through macOS `open`: "Open on GitHub" did nothing with cx.open_url, and
// a failure here says why instead of doing nothing.
function openInBrowser(url) {
  if (!url) return notify({ title: "Couldn't open the link", body: "It isn't known yet: see data/gustavo/private.json in Herdr's folder.", level: "error", timeout: 5000 });
  exec("open", [url]).then(
    (r) => { if (r.code !== 0) notify({ title: "Couldn't open the link", body: r.stderr?.trim() || url, level: "error", timeout: 5000 }); },
    (e) => notify({ title: "Couldn't open the link", body: String(e?.message ?? e), level: "error", timeout: 5000 }));
}

// The tab a PR's comments session runs in: "#123 comments", "charts#123 comments" outside
// posthog. The pull requests panel names it the same way, so either panel finds it.
export function commentsTab(key) {
  const { repo, number } = splitKey(key);
  return `${repo === DEFAULT_REPO ? "" : repo}#${number} comments`;
}

// The open comments session for a PR, if one is running.
// Found by the command it started with (its first message names the PR), which no rename changes.
export function findCommentsTab(key) {
  const { owner, repo, number } = splitKey(key);
  const marker = `review comments on ${prUrl(owner, repo, number)}`;
  const term = terminals().find((x) => x.state === "live" && (x.argv ?? []).some((a) => String(a).startsWith("Resolve the unresolved") && String(a).includes(marker)));
  const labels = term?.labels ?? {};
  if (!labels["herdr.space"] || !labels["herdr.tab"]) return null;
  // Remote terminals' labels hold ids local to their machine; the app's carry "<machine>/".
  const space = spaces().find((s) => s.id === labels["herdr.space"] || s.id.endsWith(`/${labels["herdr.space"]}`));
  const tab = space?.tabs.find((t) => t.id === labels["herdr.tab"] || t.id.endsWith(`/${labels["herdr.tab"]}`));
  return space && tab ? { space: space.id, tab: tab.id } : null;
}

// The first message of a session started to work through a PR's open review threads.
// It commits, but stops before anything leaves the machine.
export const resolvePrompt = (url) => `Resolve the unresolved review comments on ${url}.
List its unresolved review threads (gh api graphql, reviewThreads where isResolved is false). Find the checkout or worktree for the PR's branch, or make a worktree.
For each thread: read it with the code around it, then make the change it asks for, or decide it shouldn't change and say why. Commit the fixes.
Before pushing or replying on GitHub, show me each thread with what you changed or the reply you'd post, and wait for my go-ahead.`;
const prUrl = (owner, repo, number) => `https://github.com/${owner}/${repo}/pull/${number}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// "Fri 21 Nov", local time.
function dayName(ms) {
  if (!ms) return "?";
  const d = new Date(ms);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`;
}

// "https://github.com/o/r/pull/1", "o/r#1", "r#1" (PostHog's) or "#1" / "1" (PostHog/posthog).
// Claude Code's notes under a finished turn ("※ recap: …", wrapped over a few lines): not part of
// its message, so they're dropped before looking for the message's end.
function withoutNotes(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*※/.test(lines[i])) { out.push(lines[i]); continue; }
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s*[─━❯>]/.test(lines[i + 1])) i++;
  }
  return out;
}

// The question a Claude session ended its turn with, if it did: the last paragraph of its last
// message, read off the screen above the prompt box and status lines.
export function lastQuestion(lines) {
  lines = withoutNotes(lines);
  const ui = (l) => /^\s*$/.test(l) || /^[\s─━═╭╰╮╯│┃]+$/.test(l) || /^\s*[❯>]\s?/.test(l)
    || /^\s*[✻✶✳✢·*]\s+\S/.test(l) || /(auto mode|shift\+tab|esc to|for shortcuts|bypass permissions|accept edits)/i.test(l);
  let i = lines.length - 1;
  while (i >= 0 && ui(lines[i])) i--;
  if (i < 0) return "";
  const asked = /\?["')\]]?\s*$/.test(lines[i]);
  const para = [];
  for (; i >= 0 && lines[i].trim() && para.length < 6; i--) para.unshift(lines[i].trim());
  const text = para.join(" ").replace(/^[⏺●•]\s*/, "");
  return asked || ASKS.test(text) ? text : "";
}
// A last paragraph that waits on you without a question mark: "Let me know…", "your go-ahead".
const ASKS = /\b(let me know|tell me (if|whether|which|what)|your call|go-ahead|should I|shall I|want me to|would you like|waiting for (you|your)|me avis[ae]|me diga|quer que eu|posso seguir|aguardo)\b/i;

// A blocked Claude session's dialog (a permission ask, or a question with choices), read off the
// screen: what it's about (the tool and its command), the question, and its numbered options.
// Pressing an option's number answers it, as on the keyboard.
export function parsePrompt(lines) {
  const clean = lines.map((l) => l.replace(/^\s*[│┃]\s?/, "").replace(/\s*[│┃]\s*$/, ""));
  const opt = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
  let last = -1;
  for (let i = clean.length - 1; i >= 0; i--) if (opt.test(clean[i])) { last = i; break; }
  if (last < 0) return null;
  let first = last;
  // Up through the options and their wrapped lines (indented further than the question above them).
  while (first > 0 && (opt.test(clean[first - 1]) || /^\s{3,}\S/.test(clean[first - 1]))) first--;
  while (first < last && !opt.test(clean[first])) first++;
  const options = [];
  for (let i = first; i <= last; i++) {
    const m = clean[i].match(opt);
    if (m) options.push({ n: Number(m[1]), label: m[2] });
    else if (options.length && clean[i].trim()) options[options.length - 1].label += ` ${clean[i].trim()}`;
  }
  let q = first - 1;
  while (q >= 0 && !clean[q].trim()) q--;
  const question = q >= 0 ? clean[q].trim() : "";
  const context = [];
  for (let i = q - 1; i >= 0 && context.length < 10; i--) {
    if (/^[\s─━═╌]+$/.test(clean[i]) && clean[i].trim()) break;
    context.unshift(clean[i].replace(/\s+$/, ""));
  }
  while (context.length && !context[0].trim()) context.shift();
  while (context.length && !context[context.length - 1].trim()) context.pop();
  return options.length ? { question, options, context } : null;
}

// The end of a Claude session's last message, read off the screen above its prompt box: up to
// `max` lines, from its last "⏺" block.
export function lastMessage(lines, max = 8) {
  lines = withoutNotes(lines);
  const ui = (l) => /^\s*$/.test(l) || /^[\s─━═╭╰╮╯│┃]+$/.test(l) || /^\s*[❯>]\s?/.test(l)
    || /^\s*[✻✶✳✢·*]\s+\S/.test(l) || /(auto mode|shift\+tab|esc to|for shortcuts|bypass permissions|accept edits)/i.test(l);
  let end = lines.length - 1;
  while (end >= 0 && ui(lines[end])) end--;
  let start = end;
  while (start > 0 && !/^\s*⏺/.test(lines[start])) start--;
  if (end < 0 || !/^\s*⏺/.test(lines[start] ?? "")) return [];
  const block = lines.slice(start, end + 1).map((l) => l.replace(/^\s*⏺\s?/, "").replace(/\s+$/, ""));
  while (block.length && !block[0].trim()) block.shift();
  return block.length > max ? ["…", ...block.slice(-max)] : block;
}

export function parsePr(text) {
  const s = text.trim();
  let m = s.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  m = s.match(/^(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)#(\d+)$/);
  if (m) return { owner: m[1] ?? DEFAULT_OWNER, repo: m[2], number: Number(m[3]) };
  m = s.match(/^#?(\d+)$/);
  if (m) return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, number: Number(m[1]) };
  return null;
}

// A task's PRs in the order to show them: each stack (a PR whose base is another's branch, in
// the same repo) bottom first, with its place in it ({ i, n }, 1-based), then the rest by key.
export function stackOrder(keys, info) {
  const repoOf = (k) => k.split("#")[0];
  const byHead = new Map(keys.filter((k) => info[k]?.branch).map((k) => [`${repoOf(k)}:${info[k].branch}`, k]));
  const below = new Map();
  for (const k of keys) {
    const b = info[k]?.base && byHead.get(`${repoOf(k)}:${info[k].base}`);
    if (b && b !== k) below.set(k, b);
  }
  const above = new Map();
  for (const [k, b] of below) above.set(b, [...(above.get(b) ?? []), k].sort());
  const out = [];
  const seen = new Set();
  for (const root of [...keys].sort().filter((k) => !below.has(k))) {
    const chain = [];
    const walk = (k) => { if (seen.has(k)) return; seen.add(k); chain.push(k); for (const c of above.get(k) ?? []) walk(c); };
    walk(root);
    chain.forEach((k, i) => out.push({ key: k, stack: chain.length > 1 ? { i: i + 1, n: chain.length, root } : null }));
  }
  for (const k of [...keys].sort()) if (!seen.has(k)) out.push({ key: k, stack: null }); // a cycle, if GitHub ever says so
  return out;
}

const FLOX_LOCK = ".flox/env/manifest.lock";
// Agent harnesses (Codex, PostHog Code) write their config into every checkout: not work to keep.
const TOOL_WRITTEN = [".codex/", ".agents/"];
const WT_SIZE_MS = 30 * 60 * 1000; // how long a worktree's measured size holds

// A worktree's uncommitted changes, from git status. `real` is work that removing it would lose:
// modified, added and untracked files. Deleted tracked files lose nothing (git has them), and flox
// rewrites its lock file on activation and agent tools write their config (TOOL_WRITTEN), so none
// of those count; git still needs --force for them (`any`).
// A worktree whose folder is already gone (git lists it as prunable) has nothing to lose: `gone`.
async function worktreeChanges(path) {
  if (!(await folderExists(path))) return { any: false, real: [], deleted: 0, gone: true };
  const r = await exec("git", ["-C", path, "status", "--porcelain"]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (r.code !== 0) return { any: false, real: [], deleted: 0, error: r.stderr.trim().split("\n").pop() || `git exited ${r.code}` };
  const lines = r.stdout.split("\n").filter(Boolean);
  const gone = (l) => l.slice(0, 2).trim() === "D";
  return { any: lines.length > 0, deleted: lines.filter(gone).length,
    real: lines.filter((l) => !gone(l)).map((l) => l.slice(3)).filter((f) => f !== FLOX_LOCK && !TOOL_WRITTEN.some((d) => f.startsWith(d))) };
}

// New worktrees go in ~/.worktrees/<repo>/gustavo/<task id>/<name> (the `task-worktree` script),
// where the task id is the first 8 hex of the Herdr space id: the path alone names their task.
const taskFolderId = (spaceId) => spaceId.split("/").pop().replace(/^sp/, "").slice(0, 8);
const inTaskFolder = (path, spaceId) => path.includes(`/gustavo/${taskFolderId(spaceId)}/`);

async function folderExists(path) {
  return (await exec("test", ["-d", path]).catch(() => ({ code: 1 }))).code === 0;
}

// 1536 (KB) → "1.5 GB".
function diskSize(kb) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(kb >= 10 * 1024 * 1024 ? 0 : 1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

// `git worktree list --porcelain`: the first entry is the repo's own checkout, not a worktree.
function parseWorktrees(text, repo) {
  return text.split("\n\n").map((block, i) => {
    const line = (k) => block.split("\n").find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
    const path = line("worktree");
    const locked = block.split("\n").some((l) => l === "locked" || l.startsWith("locked "));
    return path && { path, repo, main: i === 0, locked, branch: (line("branch") ?? "").replace("refs/heads/", "") || "(detached)" };
  }).filter(Boolean);
}

const splitKey = (key) => {
  const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
};

const FIELDS = `number title url state isDraft mergeable reviewDecision headRefName headRefOid baseRefName
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) {
    checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }`;

// Check counts by bucket, as the pull requests panel counts them.
function checks(rollup) {
  const c = { pass: 0, fail: 0, running: 0, total: 0 };
  const ctx = rollup?.contexts;
  for (const { state, count } of [...(ctx?.checkRunCountsByState ?? []), ...(ctx?.statusContextCountsByState ?? [])]) {
    if (!count) continue;
    if (state === "SUCCESS" || state === "NEUTRAL") c.pass += count;
    else if (["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"].includes(state)) c.fail += count;
    else if (["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "EXPECTED", "REQUESTED"].includes(state)) c.running += count;
    else continue;
    c.total += count;
  }
  return c;
}

// Every attached PR in one GraphQL call, one alias each. A PR that's gone comes back null.
async function fetchPrs(keys) {
  if (!keys.length) return {};
  const parts = keys.map((k, i) => {
    const { owner, repo, number } = splitKey(k);
    return `p${i}: repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${number}) { ${FIELDS} } }`;
  });
  const r = await exec("gh", ["api", "graphql", "-f", `query=query { ${parts.join("\n")} }`]);
  const body = JSON.parse(r.stdout || "{}");
  if (!body.data) throw new Error(body.errors?.[0]?.message ?? (r.stderr.trim().split("\n").pop() || `gh exited ${r.code}`));
  const out = {};
  keys.forEach((k, i) => {
    const pr = body.data[`p${i}`]?.pullRequest;
    out[k] = pr ? {
      title: pr.title,
      branch: pr.headRefName,
      head: pr.headRefOid,
      base: pr.baseRefName,
      url: pr.url,
      state: pr.state,
      draft: pr.isDraft,
      conflicts: pr.mergeable === "CONFLICTING",
      decision: pr.reviewDecision,
      unresolved: (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
      checks: checks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    } : { missing: true };
  });
  return out;
}

export default class Tasks extends View {
  init(_props, cx) {
    // One mod, two blocks: "tasks" (the list) and "setup" (spaces that aren't tasks, at the
    // foot of the sidebar). Only the list reads GitHub and takes commands.
    this.part = props()?.part ?? "tasks";
    if (this.part === "new-task") return this.initNewTask(cx);
    this.info = {};
    this.error = null;
    this.fetchedSig = null;
    this.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.hovered = null;
    this.width = 300;
    this.adding = null; // "task", or the space id getting a PR
    this.press = null; // { tab, space, x, y }: a session pressed, maybe about to be dragged
    this.dragging = null; // the same, once it moved DRAG_PX
    this.input = InputState.new({ placeholder: "" });
    // A task's name, edited in place (double-click its title, or the pencil).
    this.renameInput = InputState.new({ placeholder: "" });
    this.renameInput.on("submit", (_e, cx) => this.finishRename(cx, true));
    this.renameInput.on("blur", (_e, cx) => { if (this.renamingTask) this.finishRename(cx, false); });
    // A repo's folder, typed into the Worktrees section's + list.
    this.repoInput = InputState.new({ placeholder: "~/dev/some-repo" });
    this.repoInput.on("submit", (_e, cx) => { this.addRepo(this.repoInput.value(), cx); this.repoInput.set_value(""); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    // An empty field closes when left.
    this.input.on("blur", (_e, cx) => { if (!this.input.value().trim()) { this.adding = null; cx.notify(); } });
    if (this.part === "top") {
      cx.timer.every(300, (cx) => this.takeNewTask(cx));
      // Slack: every few minutes, and at once when the Inbox's Refresh asks.
      this.slackAsked = shared(SLACK_ASK) ?? 0;
      cx.timer.every(SLACK_EVERY_MS, (cx) => this.readSlackNow(cx));
      cx.timer.every(1000, (cx) => { const at = shared(SLACK_ASK) ?? 0; if (at > this.slackAsked) { this.slackAsked = at; this.readSlackNow(cx); } });
      // On start, only when the last read is old: a mod reload shouldn't start another claude run.
      cx.timer.after(2000, (cx) => { if (Date.now() - (shared(SLACK)?.at ?? 0) > SLACK_EVERY_MS) this.readSlackNow(cx); });
      cx.timer.every(ALERTS_EVERY_MS, (cx) => this.readAlertsNow(cx));
      cx.timer.after(1000, (cx) => this.readAlertsNow(cx));
      this.supportAsked = shared(SUPPORT_ASK) ?? 0;
      cx.timer.every(SUPPORT_EVERY_MS, (cx) => { if (this.isHero() || Date.now() - (shared(SUPPORT)?.at ?? 0) >= SUPPORT_IDLE_MS - 5000) this.readSupportNow(cx); });
      this.heroAsked = shared(HERO_ASK) ?? 0;
      cx.timer.every(HERO_EVERY_MS, (cx) => this.readHeroNow(cx));
      cx.timer.every(1000, (cx) => { const at = shared(HERO_ASK) ?? 0; if (at > this.heroAsked) { this.heroAsked = at; this.readHeroNow(cx); } });
      cx.timer.after(1500, (cx) => { if (Date.now() - (shared(HERO)?.at ?? 0) > HERO_EVERY_MS) this.readHeroNow(cx); });
      cx.timer.every(1000, (cx) => { const at = shared(SUPPORT_ASK) ?? 0; if (at > this.supportAsked) { this.supportAsked = at; this.readSupportNow(cx); } });
      cx.timer.after(3000, (cx) => { if (Date.now() - (shared(SUPPORT)?.at ?? 0) > SUPPORT_EVERY_MS) this.readSupportNow(cx); });
    }
    cx.timer.every(30000, (cx) => cx.notify()); // the "waiting 6m" times
    // The Devboxes section reads Coder itself, so its error (Coder unreachable) shows where it's drawn.
    if (this.part === "setup" && DEVBOX_LIST) {
      cx.timer.every(60000, (cx) => this.loadDevboxes(cx));
      this.loadDevboxes(cx);
    }
    if (this.part === "drop") {
      this.dropHover = null; // { index } of the slot under the pointer, or "copy"
      this.dropEntered = false;
      // A drag released outside both the sidebar and this view (the tab bar, say) reaches no one:
      // give up if the pointer never came here, and never leave this view up without a drag.
      cx.timer.every(400, (cx) => {
        const d = shared(SIDE_DRAG);
        const here = this.view() === "drop";
        if (here && !d) this.showWork();
        else if (d && !here) setShared(SIDE_DRAG, null);
        else if (d && !this.dropEntered && Date.now() - d.at > 1500) this.endSideDrag();
        else return;
        this.dropHover = null;
        this.dropEntered = false;
        cx.notify();
      });
    }
    if (this.part === "inbox") {
      this.asks = {}; // terminal address -> the question on its screen
      this.prompts = {}; // terminal address -> its dialog (parsePrompt), while blocked
      this.lastMsgs = {}; // terminal address -> the end of its last message
      this.replyTo = null; // the session the reply box is open on
      this.replyInput = InputState.new({ placeholder: "Reply to this session" });
      this.replyInput.on("submit", (_e, cx) => this.sendReply(cx));
      cx.timer.every(5000, (cx) => this.readAsks(cx));
      this.readAsks(cx);
    }
    if (this.part !== "tasks") return;
    // After a reboot the kept terminals' shells take a moment to come back.
    cx.timer.after(4000, (cx) => this.resumeLostSessions(cx));
    // Sessions shown side by side whose terminal ended lose their column.
    cx.timer.every(5000, (cx) => cx.spawn(async () => prune()));
    // Side by side lasts until another session is opened (the user's call): the shown tab
    // changing (a click in the sidebar, the tab bar, the Inbox…) takes the columns away. A session
    // already on screen is focused where it is instead (sessionRow), so the tab doesn't change.
    this.shownTab = null;
    cx.timer.every(300, (cx) => {
      const sp = spaces().find((x) => x.active);
      const now = `${sp?.id}/${sp?.tabs.find((x) => x.active)?.id}`;
      const was = this.shownTab;
      this.shownTab = now;
      if (was && was !== now && pinned().size) cx.spawn(async () => unpin([...pinned()]).catch(() => null));
    });
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    // Claude accounts: who each is logged in as, and which one each session runs as.
    cx.timer.every(15000, (cx) => this.trackAccounts(cx));
    this.trackAccounts(cx);
    if (DEVBOXES_ON) {
      cx.timer.every(60000, (cx) => this.syncDevboxMachines(cx));
      cx.timer.after(3000, (cx) => this.syncDevboxMachines(cx));
    }
    // tasks.archive (the shown task), tasks.restore (the last archived), tasks.close-tab (closes the
    // tab in shared CLOSING, after a confirm), tasks.confirm-close (asks about it) and
    // tasks.close-session (asks about the shown one), for keys.json or `herdr-app do`.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const setup = new Set(shared(SETUP) ?? []);
        const shown = spaces().find((x) => x.active && !setup.has(x.id) && x.id !== shared(DEVBOX_SPACE) && x.id !== shared(LOOSE_SPACE));
        if (c === "new") this.openNewTask(); // tasks.new: the New task dialog
        if (c === "new-session") this.newLooseSession(); // tasks.new-session: a Claude session tied to no task
        if (c === "show-inbox") this.showView("inbox"); // tasks.show-inbox: an alert toast's click
        // tasks.clean-worktrees: lists the merged worktrees under Worktrees, to remove with one click.
        // Any copy may get it; the Worktrees copy picks it up from shared state.
        if (c === "clean-worktrees") setShared("tasks.cleanWorktrees", Date.now());
        if (c === "archive" && shown) this.archiveTask(shown, cx);
        // tasks.send-active: the shown task to the first running devbox.
        const box = (shared(DEVBOXES) ?? []).find((b) => b.status === "running");
        if (DEVBOXES_ON && c === "send-active" && shown && !shown.machine && box) this.sendToDevbox(shown, box, cx);
        if (c === "bring-home" && shown?.machine) this.bringHome(shown, cx); // tasks.bring-home: the shown devbox task here
        if (c === "restore" && (shared(ARCHIVE) ?? [])[0]) this.restoreTask(shared(ARCHIVE)[0], cx);
        if (c === "close-tab" && shared(CLOSING)) { this.closeSession(shared(CLOSING)); setShared(CLOSING, null); }
        // tasks.confirm-close: asks about the tab in shared CLOSING (the tab bar, the right-click menu).
        if (c === "confirm-close" && shared(CLOSING)) {
          const id = shared(CLOSING);
          const tab = spaces().flatMap((x) => x.tabs).find((x) => x.id === id);
          const title = (agents().find((a) => a.tab === id)?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
          if (tab) this.confirmCloseSession(id, tab.named ? tab.name : title || tab.name);
        }
        // tasks.restart-tab: restarts the tab in shared RESTARTING (pane header, right-click menu);
        // tasks.restart-session: the shown one, for a key.
        // tasks.only: shows the session in shared UNPINNING alone (a column header's "only this", or
        // the open tab's, which takes every column away).
        if (c === "only" && shared(UNPINNING)) {
          const addr = shared(UNPINNING);
          setShared(UNPINNING, null);
          const p = panes().find((x) => x.terminal === addr);
          const sp = p && spaces().find((x) => x.tabs.some((tab) => tab.id === p.tab));
          unpin([...pinned()]).catch(() => null);
          if (sp) { run("space.select", { id: sp.id }); run("tab.select", { id: p.tab }); run("pane.focus", { pane: p.pane }); }
        }
        // tasks.unpin: takes the session in shared UNPINNING off the side-by-side view (session-head's ×).
        if (c === "unpin" && shared(UNPINNING)) {
          const addr = shared(UNPINNING);
          setShared(UNPINNING, null);
          unpin([addr]).catch((e) => notify({ title: "Couldn't take the session off the view", body: String(e?.message ?? e), level: "error" }));
        }
        if (c === "restart-tab" && shared(RESTARTING)) { const id = shared(RESTARTING); setShared(RESTARTING, null); this.restartSession(id, cx); }
        if (c === "restart-session") {
          const tab = spaces().find((x) => x.active)?.tabs.find((x) => x.active);
          if (tab) this.restartSession(tab.id, cx);
        }
        // tasks.close-session: the shown session, for a key (⌘W, say) that shouldn't close a task.
        if (c === "close-session") {
          const tab = spaces().find((x) => x.active)?.tabs.find((x) => x.active);
          const title = (agents().find((a) => a.tab === tab?.id)?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
          if (tab) this.confirmCloseSession(tab.id, tab.named ? tab.name : title || tab.name);
        }
        cx.notify();
      }
    });
  }

  // ---- data ----

  prs() { return shared(PRS) ?? {}; }

  // Picks up PRs the hook labelled on any terminal of a task, and forgets closed tasks.
  sync() {
    const all = this.prs();
    const hidden = shared(HIDDEN) ?? {};
    let next = null;
    const edit = () => (next ??= JSON.parse(JSON.stringify(all)));
    for (const t of terminals()) {
      const labels = t.labels ?? {};
      // A devbox's terminals ("<machine>/t3") carry its own space ids; the app's are "<machine>/<id>".
      const at = String(t.address ?? "").split("/");
      const raw = labels["herdr.space"];
      const space = raw && at.length > 1 && !raw.includes("/") ? `${at[0]}/${raw}` : raw;
      if (!space) continue;
      for (const [k, url] of Object.entries(labels)) {
        const m = k.match(LABEL);
        if (!m) continue;
        const key = prKey(m[1], m[2], m[3]);
        if (all[space]?.[key] || hidden[space]?.includes(key)) continue;
        (edit()[space] ??= {})[key] = url;
      }
    }
    // Only once this machine's layout is read: before that, spaces() is empty, not closed.
    const here = machines().find((m) => m.name === null);
    if (here?.layout === "ready") {
      const live = new Set(spaces().map((s) => s.id));
      for (const id of Object.keys(all)) if (!live.has(id)) delete edit()[id];
    }
    if (next) setShared(PRS, next);
    const setup = shared(SETUP) ?? [];
    if (here?.layout === "ready" && setup.length) {
      const live = new Set(spaces().map((s) => s.id));
      if (setup.some((id) => !live.has(id))) setShared(SETUP, setup.filter((id) => live.has(id)));
    }
    // A nesting holds while both sessions are in the same task.
    const parents = shared(PARENTS) ?? {};
    if (here?.layout === "ready" && Object.keys(parents).length) {
      const spaceOf = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, s.id])));
      const kept = Object.fromEntries(Object.entries(parents).filter(([c, p]) => spaceOf.has(c) && spaceOf.get(c) === spaceOf.get(p)));
      if (Object.keys(kept).length !== Object.keys(parents).length) setShared(PARENTS, kept);
    }
    // PRs waiting for a task that was being created (Resolve comments on a PR with no task).
    const waiting = shared(ATTACH) ?? [];
    if (waiting.length) {
      const left = waiting.filter((w) => {
        const s = spaces().find((x) => x.named && x.name === w.name);
        if (s) { this.attach(s.id, splitKey(w.key)); return false; }
        return Date.now() - w.at < 5 * 60000;
      });
      if (left.length !== waiting.length) setShared(ATTACH, left);
    }
  }

  // ---- sessions inside sessions ----

  // Sessions are siblings. One nests under another when it was started from inside it (its
  // terminal's parent, as `hc run` records it, is in that session's tab), or when dragged onto it.
  parentsOf(s) {
    const picked = shared(PARENTS) ?? {};
    const ids = new Set(s.tabs.map((tab) => tab.id));
    const tabOf = new Map(panes().filter((p) => p.terminal && ids.has(p.tab)).map((p) => [p.terminal, p.tab]));
    const started = {};
    for (const term of terminals()) {
      const tab = tabOf.get(term.address);
      const from = term.parent && tabOf.get(term.parent);
      if (tab && from && from !== tab) started[tab] ??= from;
    }
    const out = {};
    for (const tab of s.tabs) {
      const parent = ids.has(picked[tab.id]) ? picked[tab.id] : started[tab.id];
      if (parent) out[tab.id] = parent;
    }
    return out;
  }

  // A task's sessions in order, each followed by the ones nested under it.
  sessions(s) {
    const parents = this.parentsOf(s);
    const placeholder = new Set(panes().filter((p) => p.mod === "task-empty").map((p) => p.tab));
    const tabs = s.tabs.filter((tab) => (!tab.settled || tab.status === "blocked") && !placeholder.has(tab.id));
    const ids = new Set(tabs.map((tab) => tab.id));
    const out = [];
    const seen = new Set();
    const walk = (tab, depth) => {
      if (seen.has(tab.id)) return;
      seen.add(tab.id);
      out.push({ tab, depth });
      for (const c of tabs) if (parents[c.id] === tab.id) walk(c, depth + 1);
    };
    for (const tab of tabs.filter((x) => !ids.has(parents[x.id]))) walk(tab, 0);
    // A loop of nestings reaches no root: show those at the top rather than lose them.
    for (const tab of tabs) if (!seen.has(tab.id)) walk(tab, 0);
    return out;
  }

  isUnder(s, tabId, ancestorId) {
    const parents = this.parentsOf(s);
    for (let p = parents[tabId], n = 0; p && n < 50; p = parents[p], n++) if (p === ancestorId) return true;
    return false;
  }

  canNest(target) {
    const d = this.dragging;
    if (!d || target.space !== d.space || target.tab === d.tab) return false;
    const s = spaces().find((x) => x.id === d.space);
    return Boolean(s) && !this.isUnder(s, target.tab, d.tab);
  }

  // Dropped on a session: nest under it. On a task's title: back to the top of that task, or,
  // if it's another task, move the session there.
  drop(target, cx) {
    const d = this.dragging;
    this.dragging = null;
    this.press = null;
    if (!d) return;
    const parents = { ...(shared(PARENTS) ?? {}) };
    if (target.tab) {
      if (!this.canNest(target)) return cx.notify();
      parents[d.tab] = target.tab;
      setShared(PARENTS, parents);
    } else if (target.space === d.space) {
      delete parents[d.tab];
      setShared(PARENTS, parents);
    } else {
      this.moveSession(d, target.space, cx);
    }
    cx.notify();
  }

  // Herdr has no tab move between spaces: take each terminal's pane away (it keeps running),
  // then give it a pane again, a new tab in the target space. A task left empty closes,
  // so its PRs come along.
  moveSession(d, toSpace, cx) {
    const from = spaces().find((s) => s.id === d.space);
    const terms = panes().filter((p) => p.tab === d.tab && p.terminal).map((p) => p.terminal);
    if (!terms.length) return;
    if (from && from.tabs.length === 1) for (const [key] of Object.entries(this.prs()[from.id] ?? {})) this.attach(toSpace, splitKey(key));
    for (const terminal of terms) run("terminal.park", { terminal });
    // Parking is acknowledged before the machine applies it; keep after it has.
    cx.timer.after(800, (cx) => {
      run("space.select", { id: toSpace });
      for (const terminal of terms) run("terminal.keep", { terminal });
      cx.notify();
    });
  }

  // ---- renaming a task in place ----

  startRename(s, cx) {
    this.renamingTask = s.id;
    this.renameInput.set_value(s.name);
    this.renameInput.set_selected_range({ start: 0, end: s.name.length });
    this.renameInput.focus();
    cx.notify();
  }

  finishRename(cx, keep) {
    const id = this.renamingTask;
    const name = this.renameInput.value().trim();
    this.renamingTask = null;
    if (keep && id && name) run("space.rename", { id, name });
    cx.notify();
  }



  attach(spaceId, pr) {
    const all = JSON.parse(JSON.stringify(this.prs()));
    const key = prKey(pr.owner, pr.repo, pr.number);
    (all[spaceId] ??= {})[key] = prUrl(pr.owner, pr.repo, pr.number);
    setShared(PRS, all);
    const hidden = shared(HIDDEN) ?? {};
    if (hidden[spaceId]?.includes(key)) setShared(HIDDEN, { ...hidden, [spaceId]: hidden[spaceId].filter((k) => k !== key) });
  }

  // ---- sending a task to a devbox ----

  // Moves a task from this Mac to a running devbox: its worktrees' branches are pushed and checked
  // out there as worktrees (~/worktrees/<branch>, from ~/<repo>), its Claude conversations are
  // copied into the devbox's ~/.claude/projects and resumed, its PRs come along, and the task
  // here is archived (one conversation running in two places would fork).
  async sendToDevbox(s, box, cx) {
    const step = (phase) => { this.sending = { id: s.id, phase }; cx.notify(); };
    const sh = async (script, args, opts = {}) => {
      const r = await exec("sh", ["-c", script, "sh", ...args], opts);
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
      return r.stdout.trim();
    };
    const machine = devboxMachine(box.label);
    const host = `coder.${box.name}`;
    try {
      step("Connecting");
      if (!machines().some((m) => m.name === machine)) {
        const r = await exec("hc", addDevboxArgs(box.name, machine));
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "hc machine add failed");
      }
      for (let i = 0; i < 30 && machines().find((m) => m.name === machine)?.layout !== "ready"; i++) {
        await new Promise((done) => cx.timer.after(1000, () => done()));
      }
      const on = { on: machine };
      const remoteHome = await sh('printf %s "$HOME"', [], on);

      // Worktrees: committed and pushed here, then the same branch as a worktree there.
      const moved = {}; // local path -> devbox path
      for (const w of this.worktreesOf(s)) {
        step(`Pushing ${w.branch}`);
        const dirty = await sh('git -C "$1" status --porcelain', [w.path]);
        if (dirty) throw new Error(`${w.branch} has uncommitted changes (${w.path.replace(home(), "~")}): commit or stash them first.`);
        await sh('git -C "$1" push -u origin "$2"', [w.path, w.branch]);
        step(`Checking out ${w.branch} on the devbox`);
        const repoDir = `${remoteHome}/${w.repo}`;
        const dest = `${remoteHome}/worktrees/${w.branch}`;
        await sh('test -d "$1/.git" || { echo "the devbox has no $1 checkout" >&2; exit 1; }', [repoDir], on);
        await sh('git -C "$1" fetch -q origin "+refs/heads/$2:refs/remotes/origin/$2" && if [ -d "$3" ]; then git -C "$3" checkout -q "$2" && git -C "$3" merge -q --ff-only "origin/$2"; else git -C "$1" worktree add -q -B "$2" "$3" "origin/$2"; fi',
          [repoDir, w.branch, dest], on);
        moved[w.path] = dest;
      }
      const mapCwd = (cwd) => {
        const from = Object.keys(moved).filter((k) => cwd === k || cwd?.startsWith(`${k}/`)).sort((a, b) => b.length - a.length)[0];
        return from ? moved[from] + cwd.slice(from.length) : remoteHome;
      };

      // Conversations: the transcript goes where Claude Code on the devbox looks for it.
      step("Copying conversations");
      const convos = (await this.describeSessions(s)).filter((x) => x.claude);
      const enc = (path) => path.replace(/[^A-Za-z0-9]/g, "-");
      const note = `This conversation moved from my Mac to the devbox ${box.name}. Paths changed: ${
        Object.entries(moved).map(([a, b]) => `${a} is now ${b}`).join("; ") || `my home is now ${remoteHome}`
      }. Only reply "ok" for now and wait for my next message.`;
      const tabs = [];
      for (const x of convos) {
        const cwd = mapCwd(x.cwd);
        if (x.sessionId) {
          const found = await sh('find "$1" -maxdepth 2 -name "$2.jsonl" | head -1', [`${home()}/.claude/projects`, x.sessionId]);
          if (found) {
            const dir = `${remoteHome}/.claude/projects/${enc(cwd)}`;
            await sh('mkdir -p "$1"', [dir], on);
            const r = await exec("scp", ["-q", ...DEVBOX_SSH_OPTS(), found, `${host}:${dir}/${x.sessionId}.jsonl`]);
            if (r.code !== 0) throw new Error(`copying a conversation failed: ${r.stderr.trim().split("\n").pop()}`);
            tabs.push({ name: x.name, folder: cwd, argv: ["claude", "--resume", x.sessionId, note] });
            continue;
          }
        }
        tabs.push({ name: x.name, folder: cwd, argv: ["claude"] });
      }
      if (!tabs.length) tabs.push({ folder: Object.values(moved)[0] ?? `${remoteHome}/posthog`, argv: ["claude"] });

      // The task there, then archived here.
      step("Opening it on the devbox");
      const before = new Set(spaces().map((x) => x.id));
      const [first, ...rest] = tabs;
      run("space.new", { name: s.name, machine, folder: first.folder, argv: first.argv, ...(first.name ? { tab: first.name } : {}) });
      let made = null;
      for (let i = 0; i < 50 && !made; i++) {
        await new Promise((done) => cx.timer.after(300, () => done()));
        made = spaces().find((x) => !before.has(x.id) && x.name === s.name);
      }
      if (!made) throw new Error("its space on the devbox didn't appear");
      for (const x of rest) run("tab.new", { space: made.id, folder: x.folder, argv: x.argv, ...(x.name ? { name: x.name } : {}) });
      const prs = this.prs()[s.id];
      if (prs && Object.keys(prs).length) setShared(PRS, { ...this.prs(), [made.id]: prs });
      this.sending = null;
      this.archiveTask(s, cx);
      this.showWork();
      run("space.select", { id: made.id });
    } catch (e) {
      this.sending = null;
      this.error = `Send “${s.name}” to ${box.label}: ${String(e?.message ?? e)}`;
    }
    cx.notify();
  }

  // ---- bringing a devbox task to this Mac ----

  // The way back from a devbox (the user's ask, 2026-11-09): the devbox is started if it stopped;
  // each session's branch is pushed from there and checked out here (the repo's checkout for its
  // default branch, else a worktree in ~/.worktrees/<repo>/<branch>); its Claude conversations are
  // copied into ~/.claude/projects here and resumed; PRs and worktrees come along; the devbox task
  // is archived (Archive stops a task's own devbox). Uncommitted changes there stop it.
  async bringHome(s, cx) {
    if (this.sending) return;
    const step = (phase) => { this.sending = { id: s.id, phase }; cx.notify(); };
    const sh = async (script, args, opts = {}) => {
      const r = await exec("sh", ["-c", script, "sh", ...args], opts);
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
      return r.stdout.trim();
    };
    const box = this.devboxOf(s.machine);
    const on = { on: s.machine };
    try {
      if (!box) throw new Error(`${s.machine} isn't one of your devboxes`);
      if (machines().find((m) => m.name === s.machine)?.layout !== "ready") {
        step(`Starting devbox ${box.label}`);
        await this.wakeTaskDevbox({ devbox: box.name, machine: s.machine, name: s.name }, cx);
      }
      step("Reading its sessions");
      const remoteHome = await sh('printf %s "$HOME"', [], on);
      const sessions = await this.describeSessions(s);
      // A devbox that stopped took its claude processes along: each such tab gets the newest
      // conversation of its folder that no other tab claimed (shell tabs, devboxShell's, aside).
      const claimed = new Set(sessions.map((x) => x.sessionId).filter(Boolean));
      for (const x of sessions.filter((x) => !x.sessionId && !["shell", "hogli"].includes(x.name))) {
        x.cwd ??= `${remoteHome}/posthog`;
        const list = await sh('ls -t "$1"/*.jsonl 2>/dev/null || true', [`${remoteHome}/.claude/projects/${projectDir(x.cwd)}`], on);
        const id = list.split("\n").filter(Boolean).map((f) => f.split("/").pop().replace(/\.jsonl$/, "")).find((id) => !claimed.has(id));
        if (id) { x.sessionId = id; x.claude = true; claimed.add(id); }
      }

      // Each git checkout the sessions ran in: its branch pushed there, then checked out here.
      const moved = {}; // devbox checkout -> its folder here
      const worktrees = {};
      for (const x of sessions) {
        if (!x.cwd) continue;
        const top = await sh('git -C "$1" rev-parse --show-toplevel 2>/dev/null || true', [x.cwd], on);
        if (!top || moved[top]) continue;
        const branch = await sh('git -C "$1" rev-parse --abbrev-ref HEAD', [top], on);
        if (await sh('git -C "$1" status --porcelain', [top], on)) {
          throw new Error(`${top.replace(remoteHome, "~")} on the devbox has uncommitted changes (${branch}): commit or stash them there first.`);
        }
        // The repo's name: the folder of its main checkout there (~/posthog for ~/worktrees/<branch>).
        const common = await sh('cd "$1" && cd "$(git rev-parse --git-common-dir)/.." && pwd', [top], on);
        const repoName = common.split("/").pop();
        const repo = this.repos().find((r) => r.split("/").pop() === repoName) ?? `${home()}/dev/posthog/${repoName}`;
        if ((await exec("test", ["-e", `${repo}/.git`]).catch(() => ({ code: 1 }))).code !== 0) {
          throw new Error(`no ${repo.replace(home(), "~")} checkout here for ${repoName}`);
        }
        const base = (await sh('git -C "$1" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/master', [repo])).replace(/^origin\//, "");
        if (branch === base || branch === "HEAD") {
          // The default branch (or a detached head): nothing to carry, the checkout here will do.
          moved[top] = repo;
          continue;
        }
        step(`Pushing ${branch} from the devbox`);
        await sh('git -C "$1" push -q -u origin "$2"', [top, branch], on);
        step(`Checking out ${branch} here`);
        // A worktree here already on that branch is used as is (fast-forwarded); else a new one.
        const listed = await sh('git -C "$1" worktree list --porcelain', [repo]);
        const here = listed.split("\n\n").map((b) => ({ path: b.match(/^worktree (.+)$/m)?.[1], branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] }))
          .find((w) => w.branch === branch)?.path;
        const dest = here ?? `${home()}/.worktrees/${repoName}/${branch}`;
        await sh('git -C "$1" fetch -q origin "+refs/heads/$2:refs/remotes/origin/$2"', [repo, branch]);
        if (here) {
          await sh('git -C "$1" merge -q --ff-only "origin/$2"', [here, branch]);
        } else if (await sh('git -C "$1" rev-parse -q --verify "refs/heads/$2" || true', [repo, branch])) {
          // A branch of that name here already: checked out, then only fast-forwarded (never reset).
          await sh('mkdir -p "$(dirname "$3")" && git -C "$1" worktree add -q "$3" "$2" && git -C "$3" merge -q --ff-only "origin/$2"', [repo, branch, dest]);
        } else {
          await sh('mkdir -p "$(dirname "$3")" && git -C "$1" worktree add -q -b "$2" "$3" "origin/$2" && git -C "$3" branch -q -u "origin/$2"', [repo, branch, dest]);
        }
        moved[top] = dest;
        worktrees[dest] = true;
      }
      const mapCwd = (cwd) => {
        const from = Object.keys(moved).filter((k) => cwd === k || cwd?.startsWith(`${k}/`)).sort((a, b) => b.length - a.length)[0];
        return from ? moved[from] + cwd.slice(from.length) : Object.values(moved)[0] ?? POSTHOG();
      };

      // Conversations: copied where Claude Code here looks for them, then resumed.
      step("Copying conversations");
      const note = `This conversation moved from the devbox ${box.name} to my Mac. Paths changed: ${
        Object.entries(moved).map(([a, b]) => `${a} is now ${b}`).join("; ") || `my home is now ${home()}`
      }. Only reply "ok" for now and wait for my next message.`;
      const tabs = [];
      for (const x of sessions) {
        const cwd = mapCwd(x.cwd);
        if (x.claude && x.sessionId) {
          const found = await sh('find "$HOME/.claude/projects" -maxdepth 2 -name "$1.jsonl" | head -1', [x.sessionId], on);
          if (found) {
            const dir = `${home()}/.claude/projects/${projectDir(cwd)}`;
            await sh('mkdir -p "$1"', [dir]);
            const r = await exec("scp", ["-q", ...DEVBOX_SSH_OPTS(), `coder.${box.name}:${found}`, `${dir}/${x.sessionId}.jsonl`]);
            if (r.code !== 0) throw new Error(`copying a conversation failed: ${r.stderr.trim().split("\n").pop()}`);
            tabs.push({ name: x.name, folder: cwd, argv: claudeArgv(MAIN, ["--resume", x.sessionId, note]) });
            continue;
          }
        }
        if (x.claude) tabs.push({ name: x.name, folder: cwd, argv: claudeArgv() });
      }
      if (!tabs.length) tabs.push({ folder: mapCwd(null), argv: claudeArgv() });

      // The task here, then archived there.
      step("Opening it here");
      const before = new Set(spaces().map((x) => x.id));
      const [first, ...rest] = tabs;
      run("space.new", { name: s.name, folder: first.folder, argv: first.argv, ...(first.name ? { tab: first.name } : {}) });
      let made = null;
      for (let i = 0; i < 50 && !made; i++) {
        await new Promise((done) => cx.timer.after(300, () => done()));
        made = spaces().find((x) => !before.has(x.id) && x.name === s.name && !x.machine);
      }
      if (!made) throw new Error("its space here didn't appear");
      for (const x of rest) run("tab.new", { space: made.id, folder: x.folder, argv: x.argv, ...(x.name ? { name: x.name } : {}) });
      const prs = this.prs()[s.id];
      if (prs && Object.keys(prs).length) setShared(PRS, { ...this.prs(), [made.id]: prs });
      if (Object.keys(worktrees).length) setShared(WORKTREES, { ...(shared(WORKTREES) ?? {}), [made.id]: worktrees });
      this.sending = null;
      this.archiveTask(s, cx);
      this.showWork();
      run("space.select", { id: made.id });
      notify({ title: `${s.name} is on this Mac`, body: `Its devbox task is archived${(shared(TASK_DEVBOXES) ?? {})[s.machine] ? " and its devbox stops" : ""}.`, level: "success", timeout: 6000 });
    } catch (e) {
      this.sending = null;
      this.error = `Bring “${s.name}” to this Mac: ${String(e?.message ?? e)}`;
    }
    cx.notify();
  }

  // Under a task's title: which devbox to send it to, and what that does.
  sendPicker(t, s) {
    const boxes = (shared(DEVBOXES) ?? []);
    const running = boxes.filter((b) => b.status === "running");
    return v_flex().mx(8).mb(6).p(8).gap(6).rounded(6).border_1().border_color(t.accent).bg(t.background)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.sendingPick = null; cx.notify(); } })
      .child(div().text_size(11.5).font_medium().text_color(t.foreground).child("Send to a devbox"))
      .child(div().text_size(11).text_color(t.muted).child("Pushes its worktrees' branches and checks them out there, moves its Claude conversations and resumes them, and archives the task here. Uncommitted changes stop it."))
      .when(!running.length, (el) => el.child(div().text_size(11).text_color(t.dim).child(boxes.length ? "No devbox is running: start one under Devboxes." : "No devboxes yet.")))
      .child(div().flex().flex_row().flex_wrap().gap(5)
        .children(running.map((b) => this.button(t, `tk-send-${s.id}-${b.name}`, "cloud", b.label, `Send it to ${b.name}`, (cx) => {
          this.sendingPick = null;
          this.sendToDevbox(s, b, cx);
        })))
        .child(this.link(t, `tk-send-cancel-${s.id}`, "Cancel", (cx) => { this.sendingPick = null; cx.notify(); })));
  }

  // ---- closing a session ----

  // Closes one session (a tab), never its task: Herdr closes a space with no tabs, so a task's
  // last session first gets a "no sessions" tab (mod task-empty) to hold the task open. Setup
  // spaces aren't tasks: their last tab closes them.
  closeSession(tabId) {
    const s = spaces().find((x) => x.tabs.some((tab) => tab.id === tabId));
    if (!s) return;
    const setup = new Set(shared(SETUP) ?? []);
    const placeholder = (tab) => panes().some((p) => p.tab === tab.id && p.mod === "task-empty");
    const left = s.tabs.filter((tab) => tab.id !== tabId && !placeholder(tab));
    if (!left.length && !setup.has(s.id) && s.id !== shared(LOOSE_SPACE) && !s.tabs.some((tab) => tab.id !== tabId && placeholder(tab))) {
      run("tab.new", { space: s.id, mod: "task-empty", props: { space: s.id } });
    }
    run("tab.close", { id: tabId, confirmed: true });
  }

  // Restarts a session's Claude in place, to pick up a reconnected MCP, say. The claude process
  // stops, and the shell it ran in (Herdr runs agents as `"$@"; exec $SHELL`) runs
  // `claude --resume <id>` as the same account in the same folder. It's the same tab, so its
  // place, name and nesting stay. With no message yet there's nothing to resume: a fresh claude.
  restartSession(tabId, cx) {
    const s = spaces().find((x) => x.tabs.some((tab) => tab.id === tabId));
    const tab = s?.tabs.find((x) => x.id === tabId);
    if (!tab) return;
    const title = (agents().find((a) => a.tab === tabId)?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const name = tab.named ? tab.name : title || tab.name;
    // A devbox Herdr lost: nothing there can be stopped or typed into until it's back, and once
    // it is, its sessions (still running there) come back with it. So: reconnect it.
    if (s.machine && machines().find((m) => m.name === s.machine)?.layout === "unavailable") {
      const box = this.devboxOf(s.machine);
      if (!box) { notify({ title: `Couldn't restart ${name}`, body: `Herdr lost ${s.machine}, which isn't one of your devboxes.`, level: "error" }); return; }
      notify({ title: `Reconnecting devbox ${box.label}…`, body: `${name} runs there; it comes back with it.`, level: "info", timeout: 4000 });
      this.reconnectDevbox(box, cx);
      return;
    }
    const on = s.machine ? { on: s.machine } : {};
    this.restarting ??= new Set();
    if (this.restarting.has(tabId)) return;
    this.restarting.add(tabId);
    cx.notify();
    cx.spawn(async (cx) => {
      const pause = (ms) => new Promise((done) => cx.timer.after(ms, () => done()));
      try {
        const [entry] = await this.describeSessions({ ...s, tabs: [tab] });
        const shell = panes().find((p) => p.tab === tabId && p.terminal)?.terminal;
        if (!entry?.claude || !entry.pid) {
          // Claude is gone (a devbox that stopped takes it along) and the tab is back at its
          // shell: the newest conversation of that folder is resumed there.
          const cwd = entry?.cwd;
          if (!shell || !cwd || ["shell", "hogli"].includes(entry?.name)) throw new Error("No Claude is running in this session.");
          const r = await exec("sh", ["-c", 'ls -t "$HOME/.claude/projects/$1"/*.jsonl 2>/dev/null | head -1', "sh", projectDir(cwd)], on);
          const id = (r.stdout ?? "").trim().split("/").pop().replace(/\.jsonl$/, "") || null;
          entry.terminal = shell;
          entry.sessionId = id;
        } else {
          await exec("kill", [String(entry.pid)], on);
          // Back at the shell once claude is no longer the terminal's foreground; a hard kill after 3s.
          let back = false;
          for (let i = 0; i < 40 && !back; i++) {
            await pause(150);
            if (i === 20) await exec("kill", ["-9", String(entry.pid)], on).catch(() => null);
            const r = await exec("hc", ["get", entry.terminal, "--json"]).catch(() => null);
            const info = r?.code === 0 ? JSON.parse(r.stdout) : null;
            if (!info || info.state !== "live") throw new Error("Its terminal closed along with Claude.");
            back = info.foreground?.pid !== entry.pid;
          }
          if (!back) throw new Error("Claude didn't stop.");
        }
        const extra = entry.sessionId ? ["--resume", entry.sessionId] : [];
        // On a devbox, its one claude (the account launcher is this Mac's).
        const argv = s.machine ? ["claude", ...extra] : claudeArgv(entry.account ?? MAIN, extra);
        await typeInShell(entry.terminal, entry.cwd, argv);
        notify({ title: `Restarted ${name}`, body: entry.sessionId ? "Same conversation, resumed." : "It had no messages yet, so it's a fresh session.", level: "info", timeout: 3000 });
      } catch (e) {
        notify({ title: `Couldn't restart ${name}`, body: String(e?.message ?? e), level: "error" });
      } finally {
        this.restarting.delete(tabId);
      }
      cx.notify();
    });
  }

  // After a reboot: `claude --resume` in every terminal that lost its Claude (see RESUMED).
  resumeLostSessions(cx) {
    cx.spawn(async () => {
      const json = async (args) => {
        const r = await exec("hc", [...args, "--json"]).catch(() => null);
        return r?.code === 0 ? JSON.parse(r.stdout) : null;
      };
      const status = await json(["server", "status"]);
      if (!status?.uptime_ms) return;
      const coreStart = Date.now() - status.uptime_ms;
      const before = shared(RESUMED) ?? {};
      const tried = {}; // only live terminals are kept
      const resumed = [];
      const failed = [];
      for (const { address } of (await json(["ls"]))?.terminals ?? []) {
        if (before[address]) tried[address] = before[address];
        const info = await json(["get", address]);
        const l = info?.labels ?? {};
        const id = l["claude.session"];
        const at = Number(l["claude.at"]);
        if (!id || !(at < coreStart) || Math.abs((tried[address] ?? 0) - coreStart) < 60000) continue;
        const fg = info.foreground?.argv?.[0]?.split("/").pop() ?? "";
        if (info.status?.app === "claude-code" || !SHELL.test(fg)) continue;
        tried[address] = coreStart;
        const where = l.where ?? address;
        const cwd = l["claude.cwd"] || null;
        const transcript = await exec("test", ["-f", `${home()}/.claude/projects/${projectDir(cwd ?? "")}/${id}.jsonl`]).catch(() => null);
        if (transcript?.code !== 0) continue; // never got a message: nothing to resume
        try {
          await typeInShell(address, cwd, claudeArgv(l["claude.account"] || MAIN, ["--resume", id]));
          resumed.push(where);
        } catch (e) {
          failed.push(`${where}: ${e?.message ?? e}`);
        }
      }
      setShared(RESUMED, tried);
      if (resumed.length) notify({ title: `Resumed ${resumed.length} Claude session${resumed.length > 1 ? "s" : ""}`, body: resumed.join("\n"), level: "info", timeout: 6000 });
      if (failed.length) notify({ title: "Couldn't resume some Claude sessions", body: failed.join("\n"), level: "error" });
    });
  }

  // The x on a session (sidebar, pane header): asks, then tasks.close-tab.
  confirmCloseSession(tabId, name) {
    setShared(CLOSING, tabId);
    openOverlay({
      mod: "confirm", kind: "dialog", width: 400, height: 190,
      props: { title: `Close ${name}?`, detail: "Its agent stops and its tab closes. The task stays.", command: { name: "tasks.close-tab", args: {} } },
    });
  }

  // ---- archive ----

  // What a task's sessions were, to resume them: each tab's Claude conversation, read from
  // Claude Code's ~/.claude/sessions/<pid>.json for the claude process in its terminal.
  async describeSessions(s) {
    const ag = agents();
    const out = [];
    // On a devbox Claude Code's files are there, read through that machine.
    const on = s.machine ? { on: s.machine } : {};
    const sh = (script, args) => exec("sh", ["-c", script, "sh", ...args], on).catch(() => null);
    for (const tab of s.tabs) {
      const terms = panes().filter((p) => p.tab === tab.id && p.terminal).map((p) => p.terminal);
      const lead = ag.find((a) => a.tab === tab.id);
      const title = (lead?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const entry = { name: tab.named ? tab.name : null, title: title || tab.name, claude: false, sessionId: null, cwd: null, account: MAIN };
      for (const addr of terms) {
        const r = await exec("hc", ["get", addr, "--json"]).catch(() => null);
        const info = r?.code === 0 ? JSON.parse(r.stdout) : null;
        const fg = info?.foreground;
        const isClaude = info?.status?.app === "claude-code" || /(^|\/)claude$/.test(fg?.argv?.[0] ?? "");
        if (!isClaude) { entry.cwd ??= fg?.cwd ?? info?.cwd ?? null; continue; }
        entry.claude = true;
        entry.terminal = addr;
        entry.pid = fg?.pid ?? null;
        entry.cwd = fg?.cwd ?? info?.cwd ?? null;
        if (!s.machine && fg?.pid) entry.account = await sessionAccount(fg.pid);
        if (fg?.pid) {
          const f = await sh('cat "$HOME/.claude/sessions/$1.json"', [String(fg.pid)]);
          try { entry.sessionId = JSON.parse(f?.stdout ?? "").sessionId ?? null; } catch { /* no file: a fresh claude on restore */ }
        }
        const resumed = fg?.argv?.indexOf("--resume") ?? -1;
        if (!entry.sessionId && resumed >= 0) entry.sessionId = fg.argv[resumed + 1] ?? null;
        // A conversation is saved from its first message on: without one there's nothing to resume.
        if (entry.sessionId) {
          const f = await sh('find "$HOME/.claude/projects" -maxdepth 2 -name "$1.jsonl"', [entry.sessionId]);
          if (!(f?.stdout ?? "").trim()) entry.sessionId = null;
        }
        break;
      }
      out.push(entry);
    }
    return out;
  }

  archiveTask(s, cx) {
    this.archiving ??= new Set();
    if (this.archiving.has(s.id)) return;
    this.archiving.add(s.id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const box = await this.archiveNow(s, cx);
        if (box) notify({ title: `Archived ${s.name}`, body: box, level: "info", timeout: 6000 });
      } catch (e) {
        notify({ title: `Couldn't archive ${s.name}`, body: String(e?.message ?? e), level: "error" });
      } finally {
        this.archiving.delete(s.id);
      }
      cx.notify();
    });
  }

  // Archives a task. One that ran on its own devbox then stops it (devbox: "stop", so Restore
  // starts it again) or, from Clean up, deletes it (devbox: "destroy") once its conversations are
  // copied here. Returns what happened to the devbox, for Clean up's toast.
  async archiveNow(s, cx, { devbox = "stop" } = {}) {
    const sessions = await this.describeSessions(s);
    const ws = s.machine ? (shared(TASK_DEVBOXES) ?? {})[s.machine] ?? null : null;
    const rec = { id: s.id, name: s.name, machine: s.machine ?? null, folder: s.folder || null, at: Date.now(),
      prs: this.prs()[s.id] ?? {}, worktrees: (shared(WORKTREES) ?? {})[s.id] ?? {}, sessions, devbox: ws };
    setShared(ARCHIVE, [rec, ...(shared(ARCHIVE) ?? []).filter((x) => x.id !== s.id)]);
    run("space.close", { id: s.id, confirmed: true });
    if (!ws) return null;
    // Only the task's own devbox, and only once no other space runs there.
    if (spaces().some((x) => x.machine === s.machine && x.id !== s.id)) return `devbox ${ws} kept: other spaces run there`;
    if (devbox === "destroy") {
      const copied = await this.bringConversationsHome(rec).catch((e) => e);
      if (copied instanceof Error) {
        this.devboxBuild(ws, "stop", cx);
        return `devbox ${ws} stopped, not deleted: copying its conversations failed (${copied.message})`;
      }
      // Nothing of the task is left there: Herdr forgets the machine now, Coder deletes the box.
      this.forgetTaskDevbox(rec.machine);
      this.devboxBuild(ws, "delete", cx);
      return `deleting devbox ${ws}`;
    }
    this.devboxBuild(ws, "stop", cx);
    return `stopping devbox ${ws}`;
  }

  // Before a task's devbox is deleted: each Claude conversation copied into this Mac's
  // ~/.claude/projects, and the archived task made a local one, so Restore resumes it here (in
  // the repo's checkout here when there's one, else home). Throws if any copy fails.
  async bringConversationsHome(rec) {
    const on = { on: rec.machine };
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], on);
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "the devbox didn't answer");
    const remoteHome = r.stdout.trim();
    const host = `coder.${rec.devbox}`;
    const exists = async (path) => (await exec("test", ["-d", path]).catch(() => ({ code: 1 }))).code === 0;
    const sessions = [];
    for (const x of rec.sessions) {
      // ~/posthog, ~/worktrees/<branch>…: the first folder under the devbox's home names the repo.
      const top = (x.cwd ?? "").startsWith(`${remoteHome}/`) ? x.cwd.slice(remoteHome.length + 1).split("/")[0] : null;
      const local = top && await exists(`${home()}/dev/posthog/${top}`) ? `${home()}/dev/posthog/${top}`
        : await exists(POSTHOG()) ? POSTHOG() : home();
      if (!x.claude || !x.sessionId) { sessions.push({ ...x, cwd: local }); continue; }
      const f = await exec("sh", ["-c", 'find "$HOME/.claude/projects" -maxdepth 2 -name "$1.jsonl" | head -1', "sh", x.sessionId], on);
      const from = f.stdout.trim();
      if (!from) throw new Error(`conversation ${x.sessionId} isn't on the devbox`);
      const dir = `${home()}/.claude/projects/${projectDir(local)}`;
      await exec("mkdir", ["-p", dir]);
      const cp = await exec("scp", ["-q", ...DEVBOX_SSH_OPTS(), `${host}:${from}`, `${dir}/${x.sessionId}.jsonl`]);
      if (cp.code !== 0) throw new Error(cp.stderr.trim().split("\n").pop() || `scp exited ${cp.code}`);
      sessions.push({ ...x, cwd: local });
    }
    setShared(ARCHIVE, (shared(ARCHIVE) ?? []).map((a) => a.id === rec.id ? { ...a, machine: null, devbox: null, folder: sessions[0]?.cwd ?? null, sessions } : a));
  }

  // ~/.claude/hooks/herdr-task-pr.sh on a devbox, with its PostToolUse entry in the devbox's
  // ~/.claude/settings.json (added once), calling that machine's hc.
  async installPrHook(machine) {
    const hook = await readTextFile(`${home()}/.claude/hooks/herdr-task-pr.sh`);
    if (!hook) throw new Error("no ~/.claude/hooks/herdr-task-pr.sh here");
    const r = await exec("sh", ["-c", INSTALL_PR_HOOK, "sh", hook, PR_HOOK_MATCHER, PR_HOOK_COMMAND], { on: machine });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
  }

  // Herdr's machine for a devbox workspace, if it has one (`hc machine ls`, kept by loadDevboxes).
  machineFor(ws) {
    return (this.hcMachines ?? []).find((m) => reachesDevbox(m.target, ws))?.name ?? null;
  }

  // The open tasks on a devbox, by name.
  tasksOnDevbox(ws) {
    const machine = this.machineFor(ws) ?? devboxMachine(ws.replace(`devbox-${this.devboxUser}-`, ""));
    return spaces().filter((s) => s.machine === machine).map((s) => s.name);
  }

  // A shell on a task's devbox: a tab in its space, which lives on that machine.
  devboxShell(s) {
    this.setSubOpen(s.id, "sessions", true);
    run("tab.new", { space: s.id, name: "shell" });
  }

  // The ☁ chip on a task that runs on a devbox: a click copies the ssh command, to reach it
  // from any terminal (or an editor's remote ssh).
  machineBadge(t, s) {
    const ws = (shared(TASK_DEVBOXES) ?? {})[s.machine];
    const ssh = ws ? `ssh coder.${ws}` : null;
    const offline = machines().find((m) => m.name === s.machine)?.layout === "unavailable";
    const lost = offline ? "\nHerdr lost it: Reconnect is on its row in Devboxes" : "";
    return div().id(`tk-machine-${s.id}`).flex_none().px(5).rounded(4).bg(t.raised)
      .text_size(10).text_color(offline ? t.ansi1 : t.muted).child(`☁ ${s.machine.replace(/^devbox-/, "")}`)
      .tooltip(ssh ? `Runs on ${ws}${lost}\nClick to copy: ${ssh}` : `Runs on ${s.machine}${lost}`)
      .when(Boolean(ssh), (el) => el.cursor_pointer().hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.stopClick(cx);
          cx.write_to_clipboard(ssh);
          notify({ title: "Copied the ssh command", body: ssh, level: "info", timeout: 2500 });
        }));
  }

  // Before a task's devbox is deleted: Herdr forgets its machine, and no task claims it any more.
  forgetTaskDevbox(machine) {
    exec("hc", ["machine", "rm", machine]).catch(() => null);
    const map = { ...(shared(TASK_DEVBOXES) ?? {}) };
    delete map[machine];
    setShared(TASK_DEVBOXES, map);
  }

  // `coder <stop|start|delete> <workspace> --yes` in the background (it takes minutes; exec ends
  // at 30 s), logged to ~/.cache/herdr-devbox/<workspace>.log. Resolves to whether it got there;
  // stop and delete also say so in a toast.
  async devboxBuild(ws, what, cx) {
    const log = `${home()}/.cache/herdr-devbox/${ws}.log`;
    const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$3")"; nohup "$0" "$1" "$2" --yes >"$3" 2>&1 </dev/null &', CODER(), what, ws, log])
      .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code !== 0) {
      notify({ title: `Couldn't ${what} devbox ${ws}`, body: r.stderr.trim(), level: "error" });
      return false;
    }
    // A start whose startup scripts failed still goes on, as hogli's does (it only warns).
    const started = (b) => b?.status === "running" && ["ready", "start_error", "start_timeout"].includes(b.agent);
    const want = { stop: (b) => b?.status === "stopped", start: started, delete: (b) => !b }[what];
    const ok = await this.untilDevbox(ws, want, cx).catch(() => false);
    const done = { stop: "stopped", start: "started", delete: "deleted" }[what];
    if (!ok) notify({ title: `Devbox ${ws}: ${what} didn't finish`, body: `See ${log.replace(home(), "~")}`, level: "error" });
    else if (what !== "start") notify({ title: `Devbox ${ws} ${done}`, level: "success", timeout: 5000 });
    return ok;
  }

  // Polls `coder list` (every 5 s, up to 20 minutes) until the workspace (or its absence) passes
  // `want`; false if its build failed or time ran out. A start counts once its startup scripts
  // ended, as hogli's does: then ~/posthog is there and ssh answers.
  async untilDevbox(ws, want, cx) {
    for (let i = 0; i < 240; i++) {
      await cx.sleep(5000);
      const boxes = await this.fetchDevboxes();
      if (!boxes) continue;
      const b = boxes.find((x) => x.name === ws);
      if (want(b)) return true;
      if (b?.status === "failed") return false;
    }
    return false;
  }

  // Once every PR of a task is merged: archives the task, then removes its worktrees and deletes
  // its merged PRs' local branches. A worktree with changes, or the one hogli runs in, stays. A
  // branch goes only while its tip is the PR's last commit: PostHog squash-merges, so
  // `git branch -d` can't tell a merged branch from one with newer commits.
  cleanTask(s, cx) {
    this.cleaning ??= new Set();
    if (this.cleaning.has(s.id)) return;
    this.cleaning.add(s.id);
    cx.notify();
    const merged = Object.keys(this.prs()[s.id] ?? {}).map((k) => ({ repo: splitKey(k).repo, ...this.info[k] }))
      .filter((i) => i.state === "MERGED" && i.branch && i.head);
    const wts = this.worktreesOf(s);
    const hog = shared("hogli.running");
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", args).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      const why = (r) => r.stderr.trim().split("\n").pop() || `git exited ${r.code}`;
      const short = (path) => path.replace(home(), "~");
      const done = [], kept = [];
      try {
        const box = await this.archiveNow(s, cx, { devbox: "destroy" });
        done.push("archived");
        if (box) done.push(box);
        for (const w of wts) {
          if (hog?.path === w.path) { kept.push(`${short(w.path)}: hogli runs there`); continue; }
          const changes = await worktreeChanges(w.path);
          if (changes.error) { kept.push(`${short(w.path)}: ${changes.error}`); continue; }
          const real = changes.real;
          if (real.length) { kept.push(`${short(w.path)}: uncommitted changes (${real.slice(0, 3).join(", ")}${real.length > 3 ? ", …" : ""})`); continue; }
          // Not `git worktree remove`: on a 4 GB checkout it outlives exec's 30 s and is killed
          // halfway, leaving a half-deleted folder that git still lists.
          try { await this.dropWorktree(w); } catch (e) { kept.push(`${short(w.path)}: ${String(e?.message ?? e)}`); continue; }
          done.push(`removed ${short(w.path)}`);
        }
        for (const pr of merged) {
          const repoDir = wts.find((w) => w.repo === pr.repo)?.repoDir ?? `${home()}/dev/posthog/${pr.repo}`;
          const tip = await git(["-C", repoDir, "rev-parse", "--verify", "-q", `refs/heads/${pr.branch}`]);
          if (tip.code !== 0) continue; // no local branch
          if (tip.stdout.trim() !== pr.head) { kept.push(`branch ${pr.branch}: has commits that aren't in the PR`); continue; }
          const del = await git(["-C", repoDir, "branch", "-D", pr.branch]);
          if (del.code !== 0) kept.push(`branch ${pr.branch}: ${why(del)}`);
          else done.push(`deleted branch ${pr.branch}`);
        }
        notify({ title: `Cleaned up ${s.name}`, body: [done.join(", "), kept.length ? `Kept: ${kept.join("; ")}` : ""].filter(Boolean).join("\n"),
          level: kept.length ? "warning" : "success", timeout: kept.length ? 15000 : 6000 });
      } catch (e) {
        notify({ title: `Couldn't clean up ${s.name}`, body: String(e?.message ?? e), level: "error" });
      } finally {
        this.cleaning.delete(s.id);
      }
      cx.notify();
    });
  }

  // The task again: a space with its name, a tab per Claude conversation (resumed where it ran),
  // its PRs and worktrees. Nesting isn't kept.
  restoreTask(rec, cx) {
    this.restoring ??= new Set();
    if (this.restoring.has(rec.id)) return;
    this.restoring.add(rec.id);
    cx.notify();
    if (!rec.devbox) return this.reopenTask(rec, cx);
    // Its own devbox, stopped when it was archived: started again (minutes) before the task opens.
    cx.spawn(async (cx) => {
      try {
        await this.wakeTaskDevbox(rec, cx);
        this.reopenTask(rec, cx);
      } catch (e) {
        this.restoring.delete(rec.id);
        notify({ title: `Couldn't restore ${rec.name}`, body: String(e?.message ?? e), level: "error" });
        cx.notify();
      }
    });
  }

  // Starts an archived task's devbox and waits until Herdr reaches it again.
  async wakeTaskDevbox(rec, cx) {
    const box = (await this.fetchDevboxes())?.find((b) => b.name === rec.devbox);
    if (!box) throw new Error(`its devbox ${rec.devbox} is gone`);
    if (box.status !== "running" || box.agent !== "ready") {
      notify({ title: `Starting devbox ${rec.devbox}`, body: `${rec.name} opens once it's up (a few minutes).`, level: "info", timeout: 6000 });
      if (!await this.devboxBuild(rec.devbox, "start", cx)) throw new Error(`devbox ${rec.devbox} didn't start`);
    }
    await this.reachDevbox(rec.machine, rec.devbox, cx);
  }

  // Herdr's machine for a devbox, added if it isn't there, and ready. One kept from before the
  // devbox stopped that doesn't come back in 30 s is added again (hc installed afresh).
  async reachDevbox(machine, ws, cx) {
    const ready = () => machines().find((m) => m.name === machine)?.layout === "ready";
    const add = async () => {
      const r = await exec("hc", addDevboxArgs(ws, machine));
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "hc machine add failed");
    };
    const had = machines().some((m) => m.name === machine);
    if (!had) await add();
    for (let i = 0; i < 30 && !ready(); i++) await cx.sleep(1000);
    if (!ready() && had) {
      await exec("hc", ["machine", "rm", machine]).catch(() => null);
      await add();
      for (let i = 0; i < 30 && !ready(); i++) await cx.sleep(1000);
    }
    if (!ready()) throw new Error(`Herdr can't reach ${machine}`);
    const signer = await exec("sh", ["-c", INSTALL_GIT_SIGNER, "sh", GIT_SSH_SIGN], { on: machine }).catch((e) => ({ code: 1, stderr: String(e) }));
    if (signer.code !== 0) notify({ title: `Commit signing not set up on ${machine}`, body: signer.stderr.trim().split("\n").pop() || `exit ${signer.code}`, level: "warning", timeout: 8000 });
  }

  reopenTask(rec, cx) {
    const before = new Set(spaces().map((x) => x.id));
    const convos = rec.sessions.filter((x) => x.claude);
    // Each conversation resumes as the account it ran as; on a devbox, as its one claude.
    const argvOf = (x) => {
      const extra = x.sessionId ? ["--resume", x.sessionId] : [];
      return rec.machine ? ["claude", ...extra] : claudeArgv(x.account ?? MAIN, extra);
    };
    const first = convos[0];
    const folder = first?.cwd ?? rec.folder;
    run("space.new", { name: rec.name, ...(first ? { argv: argvOf(first) } : {}), ...(first?.name ? { tab: first.name } : {}),
      ...(rec.machine ? { machine: rec.machine } : {}), ...(folder ? { folder } : {}) });
    const started = Date.now();
    const wait = (cx) => cx.timer.after(300, (cx) => {
      const made = spaces().find((x) => !before.has(x.id) && x.name === rec.name);
      if (!made) {
        if (Date.now() - started < 15000) return wait(cx);
        this.restoring.delete(rec.id);
        notify({ title: `Couldn't restore ${rec.name}`, body: "Its space didn't appear.", level: "error" });
        return cx.notify();
      }
      for (const x of convos.slice(1)) {
        run("tab.new", { space: made.id, argv: argvOf(x), ...(x.name ? { name: x.name } : {}), ...(x.cwd ? { folder: x.cwd } : {}) });
      }
      if (Object.keys(rec.prs ?? {}).length) setShared(PRS, { ...this.prs(), [made.id]: rec.prs });
      if (Object.keys(rec.worktrees ?? {}).length) setShared(WORKTREES, { ...(shared(WORKTREES) ?? {}), [made.id]: rec.worktrees });
      setShared(ARCHIVE, (shared(ARCHIVE) ?? []).filter((x) => x.id !== rec.id));
      this.restoring.delete(rec.id);
      this.showWork();
      run("space.select", { id: made.id });
      cx.notify();
    });
    wait(cx);
  }

  // Deleting an archived task for good also deletes the devbox it was stopped on.
  forgetArchived(rec, cx) {
    setShared(ARCHIVE, (shared(ARCHIVE) ?? []).filter((x) => x.id !== rec.id));
    if (!rec.devbox) return;
    this.forgetTaskDevbox(rec.machine);
    cx.spawn(async (cx) => this.devboxBuild(rec.devbox, "delete", cx));
  }

  archivedRow(t, rec) {
    const hoverKey = `archived:${rec.id}`;
    const confirming = this.confirmDelete === rec.id;
    const busy = this.restoring?.has(rec.id);
    const convos = rec.sessions.filter((x) => x.claude).length;
    const prs = Object.keys(rec.prs ?? {}).length;
    const when = ago(Date.now() - rec.at);
    return h_flex().id(`tk-arch-${rec.id}`).h(28).px(8).gap(7).items_center().rounded(7)
      .hover((x) => x.bg(t.hover))
      .on_hover((on, cx) => {
        this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered;
        if (!on && this.confirmDelete === rec.id) this.confirmDelete = null;
        cx.notify();
      })
      .tooltip(`${rec.name}\nArchived ${when} ago · ${plural(convos, "conversation")} · ${plural(prs, "PR")}`)
      .child(this.icon("archive", t.dim, 12))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(rec.name))
      .child(busy ? div().text_size(10.5).text_color(t.muted).child("restoring…")
        : confirming ? h_flex().gap(4)
          .child(div().id(`tk-arch-del-${rec.id}`).px(6).h(20).flex().items_center().rounded(5).bg(t.ansi1).text_size(10.5).text_color(t.background)
            .cursor_pointer().tooltip(rec.devbox
              ? `Removes it from Archived for good and deletes its devbox ${rec.devbox}, with the conversations on it. Its PRs stay on GitHub.`
              : "Removes it from Archived for good. Its PRs stay on GitHub, its worktrees on disk, and the conversations in Claude Code's history.")
            .on_click((_e, cx) => { this.stopClick(cx); this.confirmDelete = null; this.forgetArchived(rec, cx); cx.notify(); }).child("Delete"))
          .child(this.link(t, `tk-arch-keep-${rec.id}`, "Cancel", (cx) => { this.confirmDelete = null; cx.notify(); }))
        : this.hovered === hoverKey ? h_flex().gap(4)
          .child(div().id(`tk-arch-restore-${rec.id}`).px(6).h(20).flex().items_center().rounded(5).border_1().border_color(t.input).bg(t.raised)
            .text_size(10.5).text_color(t.foreground).cursor_pointer().hover((x) => x.bg(t.hover))
            .tooltip(`${rec.devbox ? `Starts its devbox ${rec.devbox} (a few minutes), then makes` : "Makes"} the task again${convos ? ` and resumes its ${plural(convos, "Claude conversation")}` : ""}`)
            .on_click((_e, cx) => { this.stopClick(cx); this.restoreTask(rec, cx); }).child("Restore"))
          .child(this.iconButton(t, `tk-arch-x-${rec.id}`, "x", "Delete for good", (cx) => { this.confirmDelete = rec.id; cx.notify(); }))
        : div().text_size(10.5).text_color(t.dim).child(when));
  }

  // ---- worktrees ----

  // The task a worktree is for, the way a task finds its worktrees, from shared data only (this
  // copy doesn't read GitHub): attached by hand, a PR's branch, or hogli started there for it.
  taskOfWorktree(w, tasks) {
    const marks = shared(WORKTREES) ?? {};
    const branches = shared(BRANCHES) ?? {};
    const links = shared("hogli.links") ?? {};
    const ok = (s) => marks[s.id]?.[w.path] !== false;
    return tasks.find((s) => marks[s.id]?.[w.path] === true)
      ?? tasks.find((s) => ok(s) && inTaskFolder(w.path, s.id))
      ?? tasks.find((s) => ok(s) && (branches[s.id] ?? []).includes(w.branch))
      ?? tasks.find((s) => ok(s) && links[w.path] === s.id) ?? null;
  }

  // Every worktree of the repos in ~/dev/posthog, below Pull requests: its branch, its task, and
  // whether hogli runs there. A click shows what it can do.
  worktreesBlock(t, tasks, cx) {
    const open = this.isOpen("worktrees", false);
    this.scanWorktrees(cx);
    const ask = shared("tasks.cleanWorktrees");
    // cx.spawn runs its callback synchronously up to the first await, still inside render, where
    // cx.notify() throws (after wtClean was set: the busy state stuck). Yield first.
    if (ask && ask !== this.cleanAsked) { this.cleanAsked = ask; if (Date.now() - ask < 10000) cx.spawn(async (cx) => { await Promise.resolve(); this.wtClean = null; this.findMergedWorktrees(cx); }); }
    if (open) this.scanWorktreeState(cx);
    const added = this.repos();
    const all = [...(this.wts ?? new Map()).values()].filter((w) => !w.main && added.includes(w.repoDir))
      .sort((a, b) => (a.repo === b.repo ? a.branch.localeCompare(b.branch) : a.repo === DEFAULT_REPO ? -1 : b.repo === DEFAULT_REPO ? 1 : a.repo.localeCompare(b.repo)));
    const rows = [];
    for (const dir of added) {
      const here = all.filter((w) => w.repoDir === dir);
      rows.push(this.repoLabel(t, dir, here.length));
      // Grouped by task, in the order of the task list; worktrees of no task last.
      const groups = new Map();
      for (const w of here) {
        const task = this.taskOfWorktree(w, tasks);
        const k = task?.id ?? "";
        if (!groups.has(k)) groups.set(k, { task, wts: [] });
        groups.get(k).wts.push(w);
      }
      const order = (g) => (g.task ? tasks.indexOf(g.task) : tasks.length);
      for (const g of [...groups.values()].sort((a, b) => order(a) - order(b))) {
        rows.push(this.worktreeGroupLabel(t, dir, g.task, g.wts.length));
        rows.push(...g.wts.map((w) => this.globalWorktreeRow(t, w, g.task)));
      }
    }
    this.sizeWorktrees(open);
    return this.sectionDragRoot(v_flex().id("tk-wts-block").size_full().min_h(0).bg(t.chrome)
      .child(this.sectionHeader(t, "worktrees", "Worktrees", { count: all.length || null, fallback: false,
        actions: h_flex().gap(2)
          .child(this.iconButton(t, "tk-wt-clean", "merged", "Clean merged worktrees: removes the ones whose PR is merged", (cx) => this.findMergedWorktrees(cx)))
          .child(this.iconButton(t, "tk-repo-add", "plus", "Add a repo", (cx) => {
            this.addingRepo = !this.addingRepo;
            if (this.addingRepo) { localStorage.setItem("open:worktrees", "1"); this.repoCandidates = null; this.repoInput.focus(); }
            cx.notify();
          })) }))
      .when(open && Boolean(this.addingRepo), (el) => el.child(this.repoPicker(t, cx)))
      .when(open, (el) => el.child(this.sectionCard(t).flex_1().min_h(0)
        .child(v_flex().id("tk-wts-list").flex_1().min_h(0).overflow_y_scrollbar()
          // In the scrolling list, so its buttons stay reachable however long it gets.
          .when(Boolean(this.wtClean), (el) => el.child(this.cleanMergedPanel(t)))
          .when(!added.length, (el) => el.child(div().px(8).h(24).text_size(11).text_color(t.dim).child("No repos yet: + adds one.")))
          .children(rows)))));
  }

  // A repo's name over its worktrees; on hover, x takes the repo out of this section.
  repoLabel(t, dir, count) {
    const hoverKey = `repo:${dir}`;
    return h_flex().id(`tk-repolabel-${dir}`).px(8).pt(4).h(24).gap(6).items_center()
      .on_hover((on, cx) => { this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered; cx.notify(); })
      .tooltip(dir.replace(home(), "~"))
      .child(div().text_size(10).font_semibold().text_color(t.dim).child(dir.split("/").pop().toUpperCase()))
      .child(div().text_size(10).text_color(t.dim).child(count ? String(count) : "no worktrees"))
      .child(div().flex_1())
      .when(this.hovered === hoverKey, (el) => el.child(this.iconButton(t, `tk-repo-rm-${dir}`, "x", "Stop listing this repo's worktrees", () => this.removeRepo(dir))));
  }

  // Folded, the block is its header (28px). Open, it gets back the share of the column it had
  // (a drag on its divider is kept), and the list scrolls inside it.
  sizeWorktrees(open) {
    const size = findNode(layout(), "worktrees")?.size ?? {};
    if (!open) {
      if (size.weight) localStorage.setItem("wtSize", JSON.stringify(size));
      if (size.px !== 28) run("layout.resize", { id: "worktrees", px: 28 });
    } else if (!size.weight) {
      run("layout.resize", { id: "worktrees", ...JSON.parse(localStorage.getItem("wtSize") ?? '{"weight":0.6}') });
    }
  }

  // A task's name over its worktrees in the Worktrees section (or "No task").
  worktreeGroupLabel(t, dir, task, count) {
    return h_flex().id(`tk-wtgroup-${dir}-${task?.id ?? "none"}`).px(8).pt(4).h(20).gap(6).items_center().min_w(0)
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_medium().text_color(task ? t.muted : t.dim).child(task ? task.name : "No task"))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(String(count)));
  }

  globalWorktreeRow(t, w, task) {
    const key = `gwt:${w.path}`;
    const shown = this.prShown === key;
    const running = shared("hogli.running")?.path === w.path;
    const short = w.path.replace(home(), "~");
    const changes = this.wtChanges?.get(w.path);
    const dirty = changes?.real.length ?? 0;
    const size = this.wtSizes()[w.path]?.kb;
    const hoverKey = `gwt:${w.path}`;
    const removing = this.removingWt?.path === w.path ? this.removingWt : null;
    const line = h_flex().id(`tk-gwt-${w.path}`).px(8).h(26).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .when(shown, (el) => el.bg(t.selected))
      .on_hover((on, cx) => { this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered; cx.notify(); })
      .tooltip(task ? `${short}\nTask: ${task.name}` : short)
      .on_click((_e, cx) => { this.prShown = shown ? null : key; if (shown && this.removingWt?.path === w.path && !this.removingWt.busy) this.removingWt = null; cx.notify(); })
      .child(this.icon("branch", t.dim, 12))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(task ? t.foreground : t.muted).child(w.branch))
      .when(dirty > 0, (el) => el.child(div().id(`tk-gwtdirty-${w.path}`).flex_none().text_size(10.5).text_color(t.ansi3)
        .tooltip(`${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}: ${changes.real.slice(0, 5).join(", ")}${dirty > 5 ? ", …" : ""}`)
        .child(`±${dirty}`)))
      .when(Boolean(size) && this.hovered !== hoverKey, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(diskSize(size))))
      .when(Boolean(removing?.busy), (el) => el.child(svg(ICON("spinner")).size(12).flex_none().text_color(t.dim).spin(900)))
      .when(this.hovered === hoverKey && !removing?.busy, (el) => el.child(this.iconButton(t, `tk-gwtrm-${w.path}`, "trash", "Remove this worktree", (cx) => {
        this.prShown = key;
        this.removingWt = { path: w.path, busy: false, force: false, asking: true };
        cx.notify();
      })))
      .when(running, (el) => el.child(div().id(`tk-gwthogli-${w.path}`).flex_none().tooltip("hogli is running here").child(this.icon("hogli", t.ansi2, 12))));
    if (!shown) return line;
    return v_flex().gap(4).child(line)
      .child(v_flex().mx(8).mb(4).p(8).gap(6).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .child(div().text_size(11).font_family("JetBrains Mono").text_color(t.foreground).child(short))
        .child(div().text_size(11).text_color(t.dim).child(task ? `Task: ${task.name}` : "No task"))
        .child(div().flex().flex_row().flex_wrap().gap(5)
          .when(Boolean(task), (el) => el.child(this.button(t, `tk-gwtgo-${w.path}`, "chevron-right", "Go to task", task?.name ?? "", () => {
            this.showWork();
            run("space.select", { id: task.id });
          })))
          .when(!task, (el) => el.child(this.button(t, `tk-gwtnew-${w.path}`, "plus", "New task here", "A task with a Claude session in this worktree", (cx) => this.taskForWorktree(w, cx))))
          .child(this.button(t, `tk-gwtcopy-${w.path}`, "copy", "Copy path", w.path, (cx) => {
            cx.write_to_clipboard(w.path);
            notify({ title: "Copied the worktree's path", body: short, level: "info", timeout: 2500 });
          }))
          .when(!removing, (el) => el.child(this.button(t, `tk-gwtremove-${w.path}`, "trash", "Remove", "Deletes this folder (git worktree remove); its branch stays", (cx) => {
            this.removingWt = { path: w.path, busy: false, force: false, asking: true };
            cx.notify();
          }))))
        .when(Boolean(removing), (el) => el.child(this.removeWorktreeConfirm(t, w, task, removing, changes))));
  }

  // Asks before removing a worktree: plain when it's clean, a warning with its changed files and
  // Remove anyway (git worktree remove --force) when it has uncommitted work.
  removeWorktreeConfirm(t, w, task, removing, changes) {
    const dirty = changes?.real ?? [];
    const busy = removing.busy;
    const danger = (id, label, onClick) => div().id(id).px(8).h(22).flex().items_center().rounded(6).cursor_pointer()
      .bg(t.ansi1).text_size(11).font_medium().text_color(t.background).hover((x) => x.opacity(0.85))
      .on_click((_e, cx) => { this.stopClick(cx); onClick(cx); }).child(label);
    const lines = [];
    if (busy) lines.push(removing.force ? "Removing, changes and all…" : "Checking for changes and removing…");
    else if (dirty.length) lines.push(`${dirty.length} uncommitted ${dirty.length === 1 ? "change" : "changes"} will be lost: ${dirty.slice(0, 4).join(", ")}${dirty.length > 4 ? ", …" : ""}`);
    else lines.push(changes ? "No uncommitted work. The folder goes; its branch stays." : "The folder goes; its branch stays. Uncommitted work stops it.");
    if (!busy && changes?.deleted) lines.push(`${changes.deleted} tracked ${changes.deleted === 1 ? "file is" : "files are"} deleted there: nothing lost, git has them.`);
    if (task && !busy) lines.push(`Task ${task.name} uses it.`);
    return v_flex().gap(6).pt(6).border_t_1().border_color(t.border)
      .children(lines.map((l, i) => div().text_size(11).text_color(i === 0 && dirty.length && !busy ? t.ansi3 : t.muted).child(l)))
      .when(!busy, (el) => el.child(h_flex().gap(5)
        .child(dirty.length
          ? danger(`tk-gwtforce-${w.path}`, "Remove anyway", (cx) => this.removeWorktree(w, true, cx))
          : danger(`tk-gwtok-${w.path}`, "Remove", (cx) => this.removeWorktree(w, false, cx)))
        .child(this.button(t, `tk-gwtcancel-${w.path}`, "x", "Cancel", "Keeps it", (cx) => { this.removingWt = null; cx.notify(); }))));
  }

  // A task named after the branch, its Claude session in the worktree, and the worktree attached.
  taskForWorktree(w, cx) {
    const name = w.branch.split("/").pop();
    const before = new Set(spaces().map((x) => x.id));
    this.prShown = null;
    this.showWork();
    run("space.new", { name, folder: w.path, argv: claudeArgv() });
    const started = Date.now();
    const wait = (cx) => cx.timer.after(300, (cx) => {
      const made = spaces().find((x) => !before.has(x.id) && x.name === name);
      if (!made) return Date.now() - started < 15000 ? wait(cx) : null;
      this.markWorktree(made.id, w.path, true);
      cx.notify();
    });
    wait(cx);
  }

  // Read with git, from the repos added under Worktrees, the ones the tasks' PRs are in, and the
  // worktrees attached by hand (tasks need those to find theirs); `now` skips the minute's wait.
  scanWorktrees(cx, now = false) {
    if (this.scanningWt) return;
    if (!now && Date.now() - (this.wtScannedAt ?? 0) < REFRESH_MS) return;
    this.scanningWt = true;
    this.wtScannedAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const root = `${home()}/dev/posthog`;
        const dirs = new Set(this.repos());
        for (const keys of Object.values(this.prs())) for (const k of Object.keys(keys)) dirs.add(`${root}/${splitKey(k).repo}`);
        for (const m of Object.values(shared(WORKTREES) ?? {})) for (const [path, on] of Object.entries(m)) if (on) dirs.add(path);
        const found = new Map(this.wts ?? []);
        await Promise.all([...dirs].map(async (dir) => {
          const r = await exec("git", ["-C", dir, "worktree", "list", "--porcelain"]).catch(() => null);
          if (r?.code !== 0) return;
          const list = parseWorktrees(r.stdout, "");
          const repoDir = list[0]?.path ?? dir;
          const repo = repoDir.split("/").pop();
          for (const w of list) found.set(w.path, { ...w, repo, repoDir });
        }));
        this.wts = found;
      } finally {
        this.scanningWt = false;
      }
      cx.notify();
    });
  }

  // What the Worktrees section shows beside each one: its uncommitted changes (git status, every
  // REFRESH_MS while open) and its size on disk (du, slow on a checkout with node_modules, so one
  // at a time in the background, kept in localStorage and redone after WT_SIZE_MS).
  scanWorktreeState(cx) {
    if (this.scanningState || Date.now() - (this.stateScannedAt ?? 0) < REFRESH_MS) return;
    const added = this.repos();
    const list = [...(this.wts ?? new Map()).values()].filter((w) => !w.main && added.includes(w.repoDir));
    if (!list.length) return;
    this.scanningState = true;
    this.stateScannedAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        this.wtChanges ??= new Map();
        await Promise.all(list.map(async (w) => {
          this.wtChanges.set(w.path, await worktreeChanges(w.path));
        }));
        cx.notify();
        const sizes = this.wtSizes();
        for (const w of list) {
          if (Date.now() - (sizes[w.path]?.at ?? 0) < WT_SIZE_MS) continue;
          const r = await exec("du", ["-sk", w.path]).catch(() => null);
          const kb = Number((r?.stdout ?? "").trim().split(/\s+/)[0]);
          if (!Number.isFinite(kb) || !kb) continue;
          localStorage.setItem("wtSizes", JSON.stringify({ ...this.wtSizes(), [w.path]: { kb, at: Date.now() } }));
          cx.notify();
        }
      } finally {
        this.scanningState = false;
      }
      cx.notify();
    });
  }

  wtSizes() {
    try { return JSON.parse(localStorage.getItem("wtSizes") ?? "{}"); } catch { return {}; }
  }

  // Removes a worktree from the Worktrees section. Without force it looks again first and stops
  // at uncommitted changes, so the row can offer Remove anyway. Never where hogli runs.
  removeWorktree(w, force, cx) {
    const short = w.path.replace(home(), "~");
    if (shared("hogli.running")?.path === w.path) {
      notify({ title: "Couldn't remove the worktree", body: `hogli runs in ${short}. Stop it first.`, level: "warning", timeout: 5000 });
      return;
    }
    this.removingWt = { path: w.path, busy: true, force };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const changes = await worktreeChanges(w.path);
        this.wtChanges?.set(w.path, changes);
        if (changes.error) throw new Error(changes.error);
        if (changes.real.length && !force) { this.removingWt = { path: w.path, busy: false, force: false }; return; }
        const freed = await this.dropWorktree(w);
        this.prShown = null;
        this.removingWt = null;
        notify({ title: "Removed the worktree", body: `${short}${freed ? `, ${diskSize(freed)} freed` : ""}. Its branch ${w.branch} stays.`, level: "success", timeout: 5000 });
      } catch (e) {
        this.removingWt = null;
        notify({ title: "Couldn't remove the worktree", body: `${short}: ${String(e?.message ?? e)}`, level: "error" });
      } finally {
        if (this.removingWt?.busy) this.removingWt.busy = false;
      }
      cx.notify();
    });
  }

  // Takes a worktree's folder away and forgets it; returns the KB it measured there, if any. The
  // caller has checked for uncommitted work: this stands in for git's own refusal.
  async dropWorktree(w) {
    const git = (args) => exec("git", ["-C", w.repoDir, ...args]);
    if (w.locked) await git(["worktree", "unlock", w.path]).catch(() => null);
    // git worktree remove deletes the files itself, and a worktree with node_modules takes
    // longer than exec's 30 s. So the folder is renamed aside (instant, same disk), git prunes
    // the worktree it no longer finds, and the files go in the background.
    // A folder that's already gone only needs the prune.
    const aside = `${w.path.replace(/\/[^/]+$/, "")}/.removing-${w.path.split("/").pop()}-${Date.now()}`;
    const there = await folderExists(w.path);
    if (there) {
      const mv = await exec("mv", [w.path, aside]);
      if (mv.code !== 0) throw new Error(mv.stderr.trim().split("\n").pop() || `mv exited ${mv.code}`);
    }
    const prune = await git(["worktree", "prune"]);
    if (prune.code !== 0) throw new Error(prune.stderr.trim().split("\n").pop() || `git exited ${prune.code}`);
    if (there) await exec("sh", ["-c", 'nohup rm -rf "$1" >/dev/null 2>&1 &', "sh", aside]);
    this.wts?.delete(w.path);
    this.wtChanges?.delete(w.path);
    const sizes = this.wtSizes();
    const freed = sizes[w.path]?.kb;
    delete sizes[w.path];
    localStorage.setItem("wtSizes", JSON.stringify(sizes));
    // Forget it in tasks that had it attached.
    const marks = shared(WORKTREES) ?? {};
    if (Object.values(marks).some((m) => w.path in m)) {
      setShared(WORKTREES, Object.fromEntries(Object.entries(marks).map(([id, m]) => [id, Object.fromEntries(Object.entries(m).filter(([p]) => p !== w.path))])));
    }
    return freed;
  }

  // ---- cleaning merged worktrees ----

  // Which listed worktrees are done: their branch has a merged PR on GitHub and no open one.
  // PostHog squash-merges, so git alone can't tell; GitHub can. A worktree goes only when
  // removing it loses nothing: its HEAD is the PR's last commit (or behind it), it has no
  // uncommitted work, and hogli doesn't run there. The rest are listed with why they stay.
  findMergedWorktrees(cx) {
    // A reload of this mod stops its tasks but keeps this state: a check older than a minute is dead.
    if (this.wtClean?.busy && Date.now() - this.wtClean.at < 60000) return;
    this.wtClean = { busy: true, at: Date.now(), label: "Asking GitHub which branches are merged…" };
    localStorage.setItem("open:worktrees", "1");
    cx.notify();
    const added = this.repos();
    const list = [...(this.wts ?? new Map()).values()].filter((w) => !w.main && added.includes(w.repoDir) && w.branch !== "(detached)");
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", args).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
        const slugs = {};
        for (const dir of new Set(list.map((w) => w.repoDir))) {
          const url = (await git(["-C", dir, "remote", "get-url", "origin"])).stdout.trim();
          const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
          if (m) slugs[dir] = { owner: m[1], name: m[2] };
        }
        const asked = list.filter((w) => slugs[w.repoDir]);
        this.wtClean.label = `Asking GitHub about ${asked.length} ${asked.length === 1 ? "branch" : "branches"}…`;
        cx.notify();
        const prs = {};
        if (asked.length) {
          const parts = asked.map((w, i) => `w${i}: repository(owner: ${JSON.stringify(slugs[w.repoDir].owner)}, name: ${JSON.stringify(slugs[w.repoDir].name)}) {
            pullRequests(headRefName: ${JSON.stringify(w.branch)}, first: 10, states: [OPEN, MERGED]) { nodes { number state headRefOid } } }`);
          const r = await exec("gh", ["api", "graphql", "-f", `query=query { ${parts.join("\n")} }`]);
          if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `gh exited ${r.code}`);
          const data = JSON.parse(r.stdout || "{}").data ?? {};
          asked.forEach((w, i) => { prs[w.path] = data[`w${i}`]?.pullRequests?.nodes ?? []; });
        }
        const ready = [], kept = [];
        const hog = shared("hogli.running")?.path;
        for (const w of asked) {
          const nodes = prs[w.path] ?? [];
          const merged = nodes.find((p) => p.state === "MERGED");
          if (!merged) continue; // not merged: not this button's business
          const open = nodes.find((p) => p.state === "OPEN");
          if (open) { kept.push({ w, why: `#${open.number} on this branch is still open` }); continue; }
          if (hog === w.path) { kept.push({ w, why: "hogli runs there" }); continue; }
          this.wtClean.label = `Checking ${w.branch}…`;
          cx.notify();
          const changes = await worktreeChanges(w.path);
          this.wtChanges?.set(w.path, changes);
          if (changes.error) { kept.push({ w, why: changes.error }); continue; }
          if (changes.gone) { ready.push({ w, pr: merged }); continue; } // folder already gone: only git's record is left
          if (changes.real.length) { kept.push({ w, why: `${plural(changes.real.length, "uncommitted change")}` }); continue; }
          const head = (await git(["-C", w.path, "rev-parse", "HEAD"])).stdout.trim();
          const behind = head === merged.headRefOid
            || (await git(["-C", w.path, "merge-base", "--is-ancestor", head, merged.headRefOid])).code === 0;
          if (!behind) { kept.push({ w, why: `has commits that aren't in #${merged.number}` }); continue; }
          ready.push({ w, pr: merged });
        }
        this.wtClean = { busy: false, ready, kept };
      } catch (e) {
        this.wtClean = { busy: false, error: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  // Removes the worktrees findMergedWorktrees found, each checked again first, and deletes their
  // local branches while the branch tip is still the PR's last commit.
  cleanMergedWorktrees(cx) {
    const ready = this.wtClean?.ready ?? [];
    if (!ready.length || this.wtClean.busy) return;
    this.wtClean = { ...this.wtClean, busy: true, at: Date.now(), label: `Removing ${plural(ready.length, "worktree")}…` };
    cx.notify();
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", args).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      const short = (path) => path.replace(home(), "~");
      let removed = 0, branches = 0, freed = 0;
      const kept = [];
      for (const { w, pr } of ready) {
        try {
          if (shared("hogli.running")?.path === w.path) { kept.push(`${w.branch}: hogli runs there`); continue; }
          const changes = await worktreeChanges(w.path);
          if (changes.error) { kept.push(`${w.branch}: ${changes.error}`); continue; }
          if (changes.real.length) { kept.push(`${w.branch}: uncommitted changes`); continue; }
          freed += (await this.dropWorktree(w)) ?? 0;
          removed++;
          this.wtClean.label = `Removed ${removed} of ${ready.length}…`;
          cx.notify();
          const tip = await git(["-C", w.repoDir, "rev-parse", "--verify", "-q", `refs/heads/${w.branch}`]);
          if (tip.code === 0 && tip.stdout.trim() === pr.headRefOid && (await git(["-C", w.repoDir, "branch", "-D", w.branch])).code === 0) branches++;
        } catch (e) {
          kept.push(`${short(w.path)}: ${String(e?.message ?? e)}`);
        }
      }
      this.wtClean = null;
      this.prShown = null;
      const body = [
        `${plural(removed, "worktree")} removed${freed ? `, ${diskSize(freed)} freed` : ""}, ${branches} local ${branches === 1 ? "branch" : "branches"} deleted.`,
        kept.length ? `Kept: ${kept.join("; ")}` : "",
      ].filter(Boolean).join("\n");
      notify({ title: "Cleaned merged worktrees", body, level: kept.length ? "warning" : "success", timeout: kept.length ? 15000 : 6000 });
      cx.notify();
    });
  }

  // Under the Worktrees header while cleaning: what will go, what stays and why, and the buttons.
  cleanMergedPanel(t) {
    const c = this.wtClean;
    const short = (path) => path.replace(home(), "~");
    const box = v_flex().mb(4).p(8).gap(6).rounded(6).border_1().border_color(t.accent).bg(t.surface).text_size(11);
    if (c.busy) return box.child(h_flex().gap(6).items_center()
      .child(svg(ICON("spinner")).size(12).flex_none().text_color(t.dim).spin(900))
      .child(div().flex_1().min_w(0).text_color(t.muted).child(c.label))
      .child(this.iconButton(t, "tk-wtclean-stop", "x", "Hide this", (cx) => { this.wtClean = null; cx.notify(); })));
    const close = this.button(t, "tk-wtclean-close", "x", c.ready?.length ? "Cancel" : "Close", "Keeps every worktree", (cx) => { this.wtClean = null; cx.notify(); });
    if (c.error) return box.child(div().text_color(t.ansi1).child(`Couldn't check: ${c.error}`)).child(h_flex().child(close));
    const row = (id, w, note, color) => h_flex().id(id).gap(6).items_center().min_w(0).tooltip(short(w.path))
      .child(this.icon("branch", t.dim, 11))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.branch))
      .child(div().flex_none().max_w(150).truncate().text_color(color).child(note));
    const actions = h_flex().gap(5)
      .when(c.ready.length > 0, (el) => el.child(div().id("tk-wtclean-go").px(8).h(22).flex().items_center().rounded(6).cursor_pointer()
        .bg(t.ansi1).text_size(11).font_medium().text_color(t.background).hover((x) => x.opacity(0.85))
        .on_click((_e, cx) => { this.stopClick(cx); this.cleanMergedWorktrees(cx); })
        .child(`Remove ${c.ready.length}`)))
      .child(close);
    // The buttons go right under the summary: the lists below can be long.
    return box
      .child(div().text_color(t.muted).child(c.ready.length
        ? `${plural(c.ready.length, "worktree")} with a merged PR and nothing to lose. Their folders go, and their local branches too.`
        : "No merged worktree to remove."))
      .child(actions)
      .children(c.ready.map(({ w, pr }) => row(`tk-wtclean-${w.path}`, w, `#${pr.number} merged`, t.ansi5)))
      .when(c.kept.length > 0, (el) => el.child(div().pt(2).text_color(t.dim).child(`Merged, but kept:`))
        .children(c.kept.map(({ w, why }) => row(`tk-wtkeep-${w.path}`, w, why, t.ansi3))));
  }

  repos() { return shared(REPOS) ?? [`${home()}/dev/posthog/${DEFAULT_REPO}`]; }

  // A repo's folder (~ allowed): its checkout's top, if it's a git repo.
  addRepo(text, cx) {
    const path = text.trim().replace(/^~(?=\/|$)/, home()).replace(/\/+$/, "");
    if (!path) return;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
      if (r?.code !== 0) {
        notify({ title: "Not a git repo", body: path.replace(home(), "~"), level: "warning", timeout: 4000 });
        return;
      }
      const top = r.stdout.trim().replace(/\/\.git$/, "");
      if (!this.repos().includes(top)) setShared(REPOS, [...this.repos(), top]);
      this.addingRepo = false;
      this.scanWorktrees(cx, true);
      cx.notify();
    });
  }

  removeRepo(dir) {
    setShared(REPOS, this.repos().filter((x) => x !== dir));
  }

  // The + list: git repos in ~/dev and ~/dev/posthog not added yet, and a field for any other.
  repoPicker(t, cx) {
    if (!this.repoCandidates && !this.readingRepos) {
      this.readingRepos = true;
      cx.spawn(async (cx) => {
        const r = await exec("sh", ["-c", 'for d in "$1"/*/ "$1"/posthog/*/; do [ -d "$d.git" ] && printf "%s\n" "${d%/}"; done', "sh", `${home()}/dev`]).catch(() => null);
        this.repoCandidates = (r?.stdout ?? "").split("\n").filter(Boolean);
        this.readingRepos = false;
        cx.notify();
      });
    }
    const have = new Set(this.repos());
    const rest = (this.repoCandidates ?? []).filter((d) => !have.has(d));
    return v_flex().mx(8).mb(4).p(4).gap(2).rounded(6).border_1().border_color(t.accent).bg(t.surface)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.addingRepo = false; this.repoInput.set_value(""); cx.notify(); } })
      .child(div().px(6).pt(2).text_size(10.5).text_color(t.dim).child("Add a repo: its worktrees show here. Esc closes."))
      .child(v_flex().id("tk-repo-pick").max_h(160).overflow_y_scrollbar()
        .when(!rest.length, (el) => el.child(div().px(6).h(22).text_size(11).text_color(t.dim).child(this.readingRepos ? "Looking in ~/dev…" : "No other repos in ~/dev.")))
        .children(rest.map((d) => h_flex().id(`tk-repo-${d}`).px(6).h(24).gap(6).items_center().rounded(5).cursor_pointer()
          .hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => this.addRepo(d, cx))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(d.replace(`${home()}/`, "~/"))))))
      .child(Input.new(this.repoInput).h(26).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground));
  }

  // A task's worktrees: by its PRs' branches (same repo), by hogli, and by hand.
  worktreesOf(s) {
    const marks = (shared(WORKTREES) ?? {})[s.id] ?? {};
    const links = shared("hogli.links") ?? {};
    const wanted = Object.keys(this.prs()[s.id] ?? {}).map((k) => ({ repo: splitKey(k).repo, branch: this.info[k]?.branch })).filter((x) => x.branch);
    const out = [];
    for (const w of (this.wts ?? new Map()).values()) {
      if (w.main || marks[w.path] === false) continue;
      const why = marks[w.path] ? "attached" : inTaskFolder(w.path, s.id) ? "folder" : wanted.some((x) => x.repo === w.repo && x.branch === w.branch) ? "pr" : links[w.path] === s.id ? "hogli" : null;
      if (why) out.push({ ...w, why });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  markWorktree(spaceId, path, on) {
    const all = JSON.parse(JSON.stringify(shared(WORKTREES) ?? {}));
    all[spaceId] = { ...(all[spaceId] ?? {}), [path]: on };
    setShared(WORKTREES, all);
  }

  worktreeRow(t, s, w) {
    const key = `wt:${s.id}:${w.path}`;
    const shown = this.prShown === key;
    const hog = shared("hogli.running");
    const running = hog?.path === w.path;
    const short = w.path.replace(home(), "~");
    const line = h_flex().id(`tk-wt-${s.id}-${w.path}`).pl(28).pr(8).h(26).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .when(shown, (el) => el.bg(t.selected))
      .tooltip(short)
      .on_click((_e, cx) => { this.prShown = shown ? null : key; cx.notify(); })
      .child(this.icon("branch", t.dim, 12))
      .when(w.repo !== DEFAULT_REPO, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(w.repo)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(w.branch))
      .when(running, (el) => el.child(div().id(`tk-wthogli-${s.id}-${w.path}`).flex_none().tooltip("hogli is running here").child(this.icon("hogli", t.ansi2, 12))));
    if (!shown) return line;
    const why = { folder: "In this task's worktree folder", pr: "Linked by a PR's branch", hogli: "Linked by hogli, started here for this task", attached: "Attached by hand" }[w.why];
    return v_flex().gap(4).child(line)
      .child(v_flex().ml(28).mr(8).mb(4).p(8).gap(6).rounded(6).bg(t.background).border_1().border_color(t.border)
        .child(div().text_size(11).font_family("JetBrains Mono").text_color(t.foreground).child(short))
        .child(div().text_size(11).text_color(t.dim).child(why))
        .child(div().flex().flex_row().flex_wrap().gap(5)
          .child(this.button(t, `tk-wtterm-${s.id}-${w.path}`, "folder", "Terminal here", "A shell tab in this task, in this worktree", () =>
            run("tab.new", { space: s.id, folder: w.path, name: w.branch.split("/").pop() })))
          .child(this.button(t, `tk-wtcopy-${s.id}-${w.path}`, "copy", "Copy path", w.path, (cx) => {
            cx.write_to_clipboard(w.path);
            notify({ title: "Copied the worktree's path", body: short, level: "info", timeout: 2500 });
          }))
          .child(this.button(t, `tk-wtdetach-${s.id}-${w.path}`, "x", "Remove from task", "The worktree stays on disk", () => { this.prShown = null; this.markWorktree(s.id, w.path, false); }))));
  }

  // The + list: every worktree of the repos added under Worktrees that this task doesn't have yet.
  worktreePicker(t, s, have) {
    const taken = new Set(have.map((w) => w.path));
    const added = this.repos();
    const rest = [...(this.wts ?? new Map()).values()].filter((w) => !w.main && !taken.has(w.path) && added.includes(w.repoDir))
      .sort((a, b) => (a.repo + a.branch).localeCompare(b.repo + b.branch));
    return v_flex().id(`tk-wtpick-${s.id}`).ml(28).mr(8).mb(4).p(4).max_h(220).gap(1).rounded(6)
      .border_1().border_color(t.accent).bg(t.background).overflow_y_scrollbar()
      .when(!rest.length, (el) => el.child(div().p(6).text_size(11).text_color(t.dim).child(this.scanningWt ? "Reading worktrees…" : "No other worktrees in the repos added under Worktrees.")))
      .children(rest.map((w) => h_flex().id(`tk-wtpick-${s.id}-${w.path}`).px(6).h(24).gap(6).items_center().rounded(5).cursor_pointer()
        .hover((x) => x.bg(t.hover)).tooltip(w.path.replace(home(), "~"))
        .on_click((_e, cx) => { this.pickingWt = null; this.markWorktree(s.id, w.path, true); cx.notify(); })
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(w.repo))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(w.branch))));
  }

  detach(spaceId, ...keys) {
    const all = JSON.parse(JSON.stringify(this.prs()));
    for (const key of keys) delete all[spaceId]?.[key];
    setShared(PRS, all);
    const hidden = shared(HIDDEN) ?? {};
    setShared(HIDDEN, { ...hidden, [spaceId]: [...new Set([...(hidden[spaceId] ?? []), ...keys])] });
  }

  shareBranches() {
    const out = {};
    for (const [space, keys] of Object.entries(this.prs())) {
      const b = Object.keys(keys).map((k) => this.info[k]?.branch).filter(Boolean);
      if (b.length) out[space] = [...new Set(b)].sort();
    }
    if (JSON.stringify(out) !== JSON.stringify(shared(BRANCHES) ?? {})) setShared(BRANCHES, out);
  }

  // The hogli dev stack, if it runs for this task: the hogli panel shares what runs
  // ({ path, branch, space }), started there or elsewhere; a task matches by id or by a PR branch.
  hogliHere(s) {
    const h = shared("hogli.running");
    if (!h) return null;
    const branches = (shared(BRANCHES) ?? {})[s.id] ?? [];
    return h.space === s.id || branches.includes(h.branch) ? h : null;
  }

  keys() { return [...new Set(Object.values(this.prs()).flatMap((m) => Object.keys(m)))].sort(); }

  refresh(cx) {
    if (this.busy) return;
    const keys = this.keys();
    this.busy = true;
    this.fetchedSig = keys.join(" ");
    cx.spawn(async (cx) => {
      try {
        this.info = { ...this.info, ...(await fetchPrs(keys)) };
        this.shareBranches();
        if (JSON.stringify(this.info) !== JSON.stringify(shared(PRINFO) ?? {})) setShared(PRINFO, this.info);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  submit(cx) {
    const text = this.input.value().trim();
    const what = this.adding;
    if (!text) return;
    if (what === "todo") {
      // Stays open for the next one; an empty Enter or leaving the field closes it.
      this.addTodo(text);
      this.input.set_value("");
      cx.notify();
      return;
    } else {
      const pr = parsePr(text);
      if (!pr) { this.error = `Not a PR: ${text}. Paste its URL, owner/repo#123 or #123.`; cx.notify(); return; }
      this.attach(what, pr);
    }
    this.adding = null;
    this.input.set_value("");
    cx.notify();
  }

  // ---- collapsing: one pattern ----

  // Every collapsible section has this header: a chevron on the left, the title, a count, and
  // its actions on the right. The whole row opens and closes it; what's open is kept.
  isOpen(key, fallback = true) {
    const v = localStorage.getItem(`open:${key}`);
    return v === null ? fallback : v === "1";
  }

  // An open section's body sits in a card, like an open task, so where it starts and ends is
  // plain next to the sections around it. CARD_EXTRA is what it adds to the rows' height.
  sectionCard(t) {
    return v_flex().mx(8).mb(6).p(4).rounded(9).border_1().border_color(t.border).bg(t.surface);
  }

  sectionHeader(t, key, title, { count, badge, fallback = true, actions } = {}) {
    const open = this.isOpen(key, fallback);
    const block = this.block();
    const drag = this.sectionDrag();
    const takes = Boolean(drag) && drag.block !== block;
    // Dragged by its header, a section moves its whole block; dropped on another's header, it goes there.
    return h_flex().id(`tk-sec-${key}`).h(28).px(12).flex_none().gap(6).items_center().cursor_pointer()
      .text_color(t.muted).hover((x) => x.text_color(t.foreground))
      .border_1().border_color(takes ? t.accent : "#00000000").when(takes, (el) => el.border_dashed().rounded(6))
      .when(drag?.block === block, (el) => el.opacity(0.5))
      .on_mouse_down("left", (e) => { this.secPress = { x: e.position.x, y: e.position.y }; })
      .on_mouse_up("left", (_e, cx) => { if (takes) { cx.stop_propagation(); this.dropSection(drag.block, block, cx); } })
      .on_click((_e, cx) => {
        if (this.secDragged) { this.secDragged = false; return; } // the press was a drag, not a click
        localStorage.setItem(`open:${key}`, open ? "0" : "1");
        cx.notify();
      })
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(11.5).font_medium().child(title))
      .when(count !== undefined && count !== null, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(count))))
      .when(Boolean(badge), (el) => el.child(badge))
      .child(div().flex_1())
      .when(Boolean(actions), (el) => el.child(h_flex().gap(2).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(actions)));
  }

  // ---- sections in any order ----

  // The layout block this copy draws: its sections move with it.
  block() { return { tasks: "tasks", todos: "todos", setup: "setup", worktrees: "worktrees", support: "support" }[this.part] ?? null; }

  sectionDrag() {
    const d = shared(SECTION_DRAG);
    return d && Date.now() - d.at < 30000 ? d : null; // one left over from a release outside the sidebar expires
  }

  // On every section block's root: a press on a header becomes a drag once it moves; a release
  // anywhere that isn't a header ends it.
  sectionDragRoot(el) {
    return el
      .on_mouse_move((e, cx) => {
        const p = this.secPress;
        if (!p || this.sectionDrag() || Math.hypot(e.position.x - p.x, e.position.y - p.y) < DRAG_PX) return;
        this.secDragged = true;
        setShared(SECTION_DRAG, { block: this.block(), at: Date.now() });
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        this.secPress = null;
        if (this.sectionDrag()) setShared(SECTION_DRAG, null);
        cx.notify();
      });
  }

  // Moves the dragged block to the target's place in the sidebar column, in the layout file itself
  // (only that column's order changes, so every other field and click stays): never layout.set,
  // which rewrites the whole tree.
  async dropSection(from, to, cx) {
    setShared(SECTION_DRAG, null);
    this.secPress = null;
    try {
      const path = `${appHome()}/layouts/${shared("layout")}.json`;
      const before = await readTextFile(path);
      const tree = JSON.parse(before);
      const column = findNode(tree, LISTS);
      const ids = column.children.map((c) => c.id);
      const i = ids.indexOf(from), j = ids.indexOf(to);
      if (i < 0 || j < 0 || i === j) return;
      const [moved] = column.children.splice(i, 1);
      column.children.splice(j, 0, moved); // dragged down it lands after the target, up before it
      await writeTextFile(path, JSON.stringify(tree, null, 2) + "\n", before);
    } catch (e) {
      this.error = `Couldn't move the section: ${String(e?.message ?? e)}`;
    }
    cx.notify();
  }

  // ---- side by side (side.js keeps the layout) ----

  // A session's name, as the sidebar shows it, from its terminal.
  sessionName(addr) {
    const p = panes().find((x) => x.terminal === addr);
    const tab = p && spaces().flatMap((s) => s.tabs).find((x) => x.id === p.tab);
    const a = agents().find((x) => x.address === addr);
    const live = (a?.title ?? p?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    return (tab?.named ? tab.name : live) || tab?.name || addr;
  }

  endSideDrag() {
    if (shared(SIDE_DRAG)) setShared(SIDE_DRAG, null);
    this.dropHover = null;
    this.dropPos = null;
    this.dropSlot = null;
    this.dropEntered = false;
    this.showWork();
  }

  // Puts the dragged session at `index` among the main row's columns.
  dropAt(index, cx) {
    const d = shared(SIDE_DRAG);
    this.endSideDrag();
    if (!d) return;
    cx.spawn(async () => {
      try {
        await pin(d.addr, index);
      } catch (e) {
        notify({ title: `Couldn't show ${d.name} side by side`, body: String(e?.message ?? e), level: "error" });
      }
    });
  }

  // The main area while a session is dragged out of the sidebar: the sessions shown now as cards,
  // in the order they sit on screen. Where it lands follows the pointer's x, not the element under
  // it, so a release anywhere here (a card's header, the gap between cards) lands on the side
  // that's lit; dragging back over the sidebar cancels. A ghost of the session follows the pointer.
  dropView(t) {
    const d = shared(SIDE_DRAG);
    if (!d) return div().size_full().bg(t.chrome);
    const sp = spaces().find((x) => x.active);
    const tab = sp?.tabs.find((x) => x.active);
    const shownTerms = panes().filter((p) => p.tab === tab?.id && p.terminal).map((p) => p.terminal);
    const isShown = shownTerms.includes(d.addr);
    const cols = columns();
    // The slot under the pointer: card i's left half is slot i, its right half slot i + 1.
    const at = this.dropPos;
    const w = this.dropWidth ?? 0;
    const slot = !isShown && at && w > 0 && cols.length
      ? (() => { const x = Math.min(Math.max(at.x - 12, 0), w - 24 - 1); const i = Math.floor(x / ((w - 24) / cols.length)); return i + ((x % ((w - 24) / cols.length)) >= (w - 24) / cols.length / 2 ? 1 : 0); })()
      : null;
    this.dropSlot = slot;
    const half = (s, label) => {
      const on = slot === s;
      return div().flex_1().min_w(0).m(6).rounded(8).flex().items_center().justify_center().px(10)
        .border_2().border_color(on ? t.accent : "#00000000").when(on, (el) => el.bg(t.accent + "22"))
        .text_size(12).text_color(on ? t.accent : t.dim)
        .child(div().truncate().child(on ? `Put “${d.name}” here` : label));
    };
    const card = (c, i) => {
      const name = c.main ? (tab ? (tab.named ? tab.name : this.sessionName(shownTerms[0] ?? "")) : "Nothing open") : this.sessionName(c.addr);
      const self = c.addr === d.addr;
      return v_flex().flex_1().min_w(0).rounded(10).border_1().border_dashed().border_color(t.border).bg(t.surface)
        .when(self, (el) => el.opacity(0.5))
        .child(h_flex().px(12).h(34).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(name))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.main ? "open now" : self ? "this one" : "beside")))
        .child(h_flex().items_stretch().flex_1().min_h(0)
          .child(half(i, "← Left of it"))
          .child(div().w(1).my(16).bg(t.border))
          .child(half(i + 1, "Right of it →")));
    };
    const copyOn = this.dropHover === "copy";
    return v_flex().id("drop-root").relative().size_full().p(12).gap(10).bg(t.chrome)
      .on_size_change((size, cx) => { if (Math.abs(size.width - (this.dropWidth ?? 0)) >= 1) { this.dropWidth = size.width; cx.notify(); } })
      .on_mouse_move((e, cx) => { this.dropEntered = true; this.dropPos = e.local_position; cx.notify(); })
      .on_hover((on, cx) => {
        if (on) { this.dropEntered = true; return; }
        if (this.dropEntered) this.endSideDrag();
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.dropSlot == null) return this.endSideDrag();
        this.dropAt(this.dropSlot, cx);
      })
      .child(div().text_size(13).text_color(t.foreground).child(isShown
        ? `“${d.name}” is the session open now. Open another one, then drag this one here to see both.`
        : `Release to put “${d.name}” on the lit side. Drag back over the sidebar to cancel.`))
      .child(h_flex().items_stretch().flex_1().min_h(0).gap(8).children(cols.map(card)))
      .child(h_flex().gap(10).items_center()
        .child(div().id("drop-copy").px(10).h(26).flex().items_center().rounded(6).border_1()
          .border_color(copyOn ? t.accent : t.border).text_size(11.5).text_color(copyOn ? t.accent : t.muted)
          .on_hover((h, cx) => { this.dropHover = h ? "copy" : this.dropHover === "copy" ? null : this.dropHover; cx.notify(); })
          .on_mouse_up("left", (_e, cx) => {
            cx.stop_propagation();
            cx.write_to_clipboard(d.addr);
            notify({ title: `Copied ${d.addr}`, body: "Paste it with ⌘V in a session's prompt.", level: "info", timeout: 3000 });
            this.endSideDrag();
          })
          .child(`Copy its ID (${d.addr})`)))
      .when(Boolean(at), (el) => el.child(this.dragGhost(t, d.name, at)));
  }

  // The session being dragged, under the pointer (in the sidebar and in the drop view).
  dragGhost(t, name, at) {
    return h_flex().absolute().left(at.x + 12).top(at.y - 14).h(28).max_w(320).px(9).gap(7).items_center()
      .rounded(7).bg(t.surface).border_1().border_color(t.accent).shadow_lg()
      .child(svg(ICON("terminal")).size(13).flex_none().text_color(t.accent))
      .child(div().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(name));
  }

  // ---- views: work, inbox, grafana ----

  view() { return findNode(layout(), VIEWS)?.active ?? "main"; }
  // No tab bar (the user's call, 2026-11-13): a task's sessions are in the sidebar, and side by side.
  showView(child) {
    if (this.view() !== child) run("layout.select", { stack: VIEWS, child });
  }
  showWork() { this.showView("main"); }

  // Sessions that wait on you: blocked (a permission, a choice) or ended asking you something
  // (seen or not). One that just finished, with nothing for you to do, stays out (the user's call).
  waiting(list, ag) {
    const ids = new Set(list.map((s) => s.id));
    const asking = shared(ASKING) ?? {};
    const dismissed = shared(DISMISSED) ?? {};
    return ag.filter((a) => ids.has(a.space) && (a.status === "blocked" || ((a.status === "done" || a.status === "idle") && asking[a.address]))
      && !(a.status !== "blocked" && dismissed[a.address] === a.seq));
  }

  // Herdr's spaces, with a session that ended its turn asking you something (Herdr calls it done or
  // idle) counted as needing you, on its tab and its task. Put aside in the Inbox, it's done again.
  withAsks(list, ag) {
    const tabs = new Set(this.waiting(list, ag).filter((a) => a.status !== "blocked").map((a) => a.tab));
    if (!tabs.size) return list;
    return list.map((s) => !s.tabs.some((tb) => tabs.has(tb.id)) ? s
      : { ...s, status: "blocked", tabs: s.tabs.map((tb) => tabs.has(tb.id) ? { ...tb, status: "blocked" } : tb) });
  }

  // Work (the shown tab), Inbox and Grafana: which one fills the main area. The Inbox view holds the
  // pull requests mod's Merge part beside the inbox, so its badge also counts PRs ready to queue plus
  // ones a queue failed.
  viewNav(t, list) {
    const now = this.view();
    const ag = agents();
    const ext = this.external();
    const needs = this.waiting(list, ag).filter((a) => a.status === "blocked").length + ext.alerts.length + ext.support.filter((x) => x.status === "new").length;
    const waiting = this.waiting(list, ag).length + ext.count;
    const item = (child, label, badge, badgeColor) => h_flex().id(`tk-view-${child}`).flex_1().h(26).gap(5).items_center().justify_center()
      .rounded(6).cursor_pointer().text_size(12).font_medium()
      .bg(now === child ? t.selected : "#00000000").text_color(now === child ? t.foreground : t.muted)
      .hover((x) => x.text_color(t.foreground))
      .on_click(() => this.showView(child))
      .child(label)
      .when(Boolean(badge), (el) => el.child(div().px(5).rounded(8).bg(badgeColor).text_size(10).text_color(t.background).child(String(badge))));
    return h_flex().mx(12).mt(6).p(2).flex_none().gap(2).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(item("main", "Work"))
      .child(item("inbox", "Inbox", waiting + (shared("gh-inbox.merge")?.actions ?? 0), needs ? t.blocked : t.done))
      // The grafana mod's view; its badge counts the /flags numbers past their bad threshold.
      .child(item("grafana", "Grafana", shared("grafana.health")?.bad, t.blocked))
      // The dungeon mod's view: the tasks as rooms of a pixel-art dungeon.
      .child(item("dungeon", "Dungeon"));
  }

  // What waits on you on each agent's screen. Blocked: the lowest line that ends a question.
  // Done or idle: its last message, when that ends with a question; read again only when the
  // session changed, and shared so the Inbox count in the sidebar includes it.
  readAsks(cx) {
    if (this.asking) return;
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, t])));
    const todo = agents().filter((a) => a.status === "blocked"
      || ((a.status === "done" || a.status === "idle") && this.seenAt?.[a.address] !== tabs.get(a.tab)?.changed_at));
    if (!todo.length) return;
    this.asking = true;
    this.seenAt ??= {};
    cx.spawn(async (cx) => {
      const asking = { ...(shared(ASKING) ?? {}) };
      let changed = false;
      for (const a of todo) {
        const r = await exec("hc", ["read", a.address, "--lines", "80"]).catch(() => null);
        const raw = (r?.stdout ?? "").split("\n");
        let ask = "";
        const prompt = a.status === "blocked" ? parsePrompt(raw) : null;
        if (JSON.stringify(prompt) !== JSON.stringify(this.prompts[a.address] ?? null)) { this.prompts[a.address] = prompt; changed = true; }
        if (a.status !== "blocked") {
          const msg = lastMessage(raw);
          if (JSON.stringify(msg) !== JSON.stringify(this.lastMsgs[a.address] ?? [])) { this.lastMsgs[a.address] = msg; changed = true; }
        }
        if (a.status === "blocked") {
          const lines = raw.map((l) => l.replace(/^[\s│┃╭╰╮╯─━❯›>⎿⏺●•◆□☐✳*]+/u, "").trim()).reverse();
          ask = lines.find((l) => l.length >= 10 && /\p{L}/u.test(l) && /\?(\s|\)|$)/.test(l) && !l.startsWith("?") && !/shortcuts/i.test(l)) ?? "";
        } else {
          ask = lastQuestion(raw);
          this.seenAt[a.address] = tabs.get(a.tab)?.changed_at;
          if (ask) asking[a.address] = ask; else delete asking[a.address];
        }
        ask = ask.length > 300 ? ask.slice(0, 299) + "…" : ask;
        if (ask !== (this.asks[a.address] ?? "")) { this.asks[a.address] = ask; changed = true; }
      }
      // Forget sessions that went or got busy again.
      const live = new Map(agents().map((a) => [a.address, a.status]));
      for (const k of Object.keys(asking)) if (!["done", "idle"].includes(live.get(k))) delete asking[k];
      if (JSON.stringify(asking) !== JSON.stringify(shared(ASKING) ?? {})) setShared(ASKING, asking);
      this.asking = false;
      if (changed) cx.notify();
    });
  }

  goToAgent(a) {
    // The tree (another copy of this mod) opens that task and shows the session selected.
    setShared(REVEAL, { space: a.space, tab: a.tab, at: Date.now() });
    this.showWork();
    run("space.select", { id: a.space });
    run("tab.select", { id: a.tab });
    run("agent.focus", { terminal: a.address });
  }

  // Answers a blocked session's dialog: its option's number, as typed. "No, and tell Claude…"
  // opens the reply box, for what to do instead.
  answerPrompt(a, o, cx) {
    exec("hc", ["keys", a.address, String(o.n)]).then((r) => {
      if (r.code !== 0) notify({ title: "Couldn't answer", body: r.stderr.trim() || a.address, level: "error" });
    });
    delete this.prompts[a.address];
    if (/^no\b/i.test(o.label)) { this.replyTo = a.address; this.replyInput.set_value(""); this.replyInput.focus(); }
    cx.notify();
  }

  // The reply box: pasted into the session and sent with Enter.
  sendReply(cx) {
    const text = this.replyInput.value().trim();
    const to = this.replyTo;
    if (!text || !to) return;
    exec("hc", ["send", to, text]).then((r) => {
      if (r.code !== 0) notify({ title: "Couldn't send the reply", body: r.stderr.trim() || to, level: "error" });
    });
    notify({ title: "Reply sent", body: text.length > 80 ? `${text.slice(0, 79)}…` : text, level: "success", timeout: 2500 });
    this.replyTo = null;
    this.replyInput.set_value("");
    cx.notify();
  }

  // Out of the Inbox until the session changes again.
  dismiss(a) {
    setShared(DISMISSED, { ...Object.fromEntries(Object.entries(shared(DISMISSED) ?? {}).filter(([k]) => agents().some((x) => x.address === k))), [a.address]: a.seq });
    if (this.replyTo === a.address) this.replyTo = null;
  }

  inboxCard(t, a, list) {
    const s = list.find((x) => x.id === a.space);
    const tab = s?.tabs.find((x) => x.id === a.tab);
    const st = this.status(a.status, t);
    const since = tab?.changed_at ? ago(Date.now() - tab.changed_at) : "";
    const ask = this.asks?.[a.address] || (shared(ASKING) ?? {})[a.address];
    const name = tab?.named ? tab.name : (a.title || "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || tab?.name || a.address;
    const pane = panes().find((p) => p.pane === a.pane);
    const where = [pane?.cwd ? pane.cwd.replace(home(), "~") : null, pane?.branch].filter(Boolean).join(" · ");
    const acct = (shared(ACCOUNTS) ?? []).length > 1 ? (shared(SESSION_ACCOUNTS) ?? {})[a.address] : null;
    const info = shared(PRINFO) ?? {};
    const prKeys = s ? stackOrder(Object.keys(this.prs()[s.id] ?? {}), info).map((o) => o.key) : [];
    const blocked = a.status === "blocked";
    const prompt = blocked ? this.prompts?.[a.address] : null;
    const msg = blocked ? [] : this.lastMsgs?.[a.address] ?? [];
    const replying = this.replyTo === a.address;
    const mono = (text, color) => div().text_size(11.5).font_family("JetBrains Mono").text_color(color).child(text || " ");
    return v_flex().id(`in-${a.address}`).p(12).gap(8).rounded(10).border_1()
      .border_color(blocked ? t.blocked : t.border).bg(t.surface)
      // Header: where it is and how long it's waited. A click on it shows the session.
      .child(h_flex().id(`in-head-${a.address}`).gap(8).items_center().cursor_pointer().on_click(() => this.goToAgent(a))
        .child(this.dot(st, 8))
        .child(div().flex_none().max_w(220).truncate().text_size(11.5).text_color(t.muted).child(s?.name ?? ""))
        .child(div().text_size(11.5).text_color(t.dim).child("›"))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(t.foreground).child(name))
        .when(Boolean(acct), (el) => el.child(this.accountChip(t, `in-acct-${a.address}`, acct)))
        .child(div().flex_none().text_size(11).text_color(blocked ? st.color : t.dim).child(`${st.label}${since ? ` · ${since}` : ""}`)))
      .when(Boolean(where) || prKeys.length > 0, (el) => el.child(h_flex().gap(10).items_center().min_w(0)
        .when(Boolean(where), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(where)))
        .children(prKeys.map((k) => {
          const st2 = this.step(info[k], t);
          const { repo, number } = splitKey(k);
          return h_flex().id(`in-pr-${a.address}-${k}`).flex_none().gap(4).items_center().px(5).h(18).rounded(5).bg(t.raised).cursor_pointer()
            .hover((x) => x.bg(t.hover)).tooltip(`${info[k]?.title ?? k}\n${st2.label}\nClick to open on GitHub`)
            .on_click((_e, cx) => { cx.stop_propagation(); openInBrowser(info[k]?.url ?? this.prs()[s.id]?.[k]); })
            .child(this.icon(st2.icon, st2.color, 10, st2.spin))
            .child(div().text_size(10.5).text_color(t.muted).child(`${repo === DEFAULT_REPO ? "" : repo}#${number}`));
        }))))
      // What it waits on: its dialog, the question it ended on, or how its last message ended.
      .when(Boolean(prompt), (el) => el.child(v_flex().gap(6)
        .when(prompt.context.length > 0, (el) => el.child(v_flex().px(10).py(7).rounded(6).bg(t.raised).children(prompt.context.map((l, i) => mono(l, i === 0 ? t.foreground : t.muted)))))
        .when(Boolean(prompt.question), (el) => el.child(div().text_size(12.5).font_medium().text_color(t.foreground).child(prompt.question)))
        .child(div().flex().flex_row().flex_wrap().gap(5).children(prompt.options.map((o) => div().id(`in-opt-${a.address}-${o.n}`).max_w(420).truncate()
          .px(9).py(4).rounded(6).border_1().border_color(o.n === 1 ? t.accent : t.input).bg(o.n === 1 ? t.accent : t.raised)
          .text_size(11.5).text_color(o.n === 1 ? t.accent_foreground : t.foreground).cursor_pointer().hover((x) => x.opacity(0.88))
          .tooltip(`${o.n}. ${o.label}`).on_click((_e, cx) => this.answerPrompt(a, o, cx)).child(`${o.n}. ${o.label}`))))))
      .when(!prompt && blocked && Boolean(ask), (el) => el.child(div().px(10).py(7).rounded(6).bg(t.raised).text_size(12.5).text_color(t.foreground).child(ask)))
      .when(!blocked && msg.length > 0, (el) => el.child(v_flex().px(10).py(7).gap(1).rounded(6).bg(t.raised)
        .children(msg.map((l) => div().text_size(12).text_color(ask && l.includes(ask.slice(-30)) ? t.foreground : t.muted).child(l.trimStart() || " ")))))
      .when(!blocked && !msg.length && Boolean(ask), (el) => el.child(div().px(10).py(7).rounded(6).bg(t.raised).text_size(12.5).text_color(t.foreground).child(ask)))
      .when(replying, (el) => el.child(v_flex().gap(3)
        .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.replyTo = null; cx.notify(); } })
        .child(Input.new(this.replyInput).h(32).px(9).rounded(7).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(div().text_size(10.5).text_color(t.dim).child("Enter sends it to the session; Esc cancels."))))
      .child(h_flex().gap(6).flex_wrap()
        .when(!blocked || /^no\b/i.test(prompt?.options?.at(-1)?.label ?? ""), (el) => el.when(!replying, (el) => el.child(this.button(t, `in-reply-${a.address}`, "comment", "Reply", "Type an answer here; it goes to the session", (cx) => {
          this.replyTo = a.address;
          this.replyInput.set_value("");
          this.replyInput.focus();
          cx.notify();
        }))))
        .child(this.button(t, `in-go-${a.address}`, "external", "Go to session", "Show this session, ready to type", () => this.goToAgent(a)))
        .child(this.button(t, `in-peek-${a.address}`, "eye", "Peek", "Its screen over the current view, without leaving it", () => run("terminal.peek", { terminal: a.address })))
        .when(!blocked, (el) => el.child(this.button(t, `in-dismiss-${a.address}`, "check", "Dismiss", "Out of the Inbox until this session changes", (cx) => { this.dismiss(a); cx.notify(); }))));
  }

  // ---- support hero ----

  // Reads the team's open support tickets (support.js) and shares them; only the top part does.
  readSupportNow(cx) {
    if (this.supportBusy) return;
    this.supportBusy = true;
    setShared(SUPPORT, { ...(shared(SUPPORT) ?? {}), busy: true });
    cx.spawn(async (cx) => {
      const { busy: _b, ...prev } = shared(SUPPORT) ?? {};
      let next;
      try {
        const items = await readTickets();
        next = { at: Date.now(), items };
        this.announceSupport(items);
      } catch (e) {
        const setup = e instanceof SupportError && ["no_token", "auth", "scope"].includes(e.code);
        next = { ...prev, error: String(e?.message ?? e), setup };
      }
      setShared(SUPPORT, next);
      this.supportBusy = false;
      cx.notify();
    });
  }

  // A toast when a ticket starts waiting on the team (new, or the customer wrote again), each
  // once: what was said is kept in shared SUPPORT_SEEN. The first read ever says nothing.
  announceSupport(items) {
    const before = shared(SUPPORT_SEEN);
    const seen = {};
    // The other weeks it only remembers, so a week that starts with tickets waiting says nothing.
    const quiet = !before || !this.isHero();
    for (const x of items.filter(needsTeam)) {
      seen[x.id] = x.unread;
      if (quiet) continue;
      const was = before[x.id];
      const who = x.customer || "a customer";
      if (was === undefined) {
        notify({ title: `Support ticket #${x.number} for Feature Flags`, body: [who, x.subject || x.last].filter(Boolean).join(": ").slice(0, 300), level: "warning", action: { name: "tasks.show-inbox" } });
        playSound("blocked");
      } else if (x.unread > was) {
        notify({ title: `${who} replied on #${x.number}`, body: x.last.slice(0, 300), level: "info", action: { name: "tasks.show-inbox" } });
      }
    }
    setShared(SUPPORT_SEEN, seen);
  }

  // A Claude task that looks into a ticket, made the way the New task dialog makes one.
  investigateTicket(x) {
    const message = [
      `Investigate PostHog support ticket #${x.number} (${x.url}), assigned to Team Feature Flags.`,
      [x.customer && `Customer: ${x.customer}${x.email && x.email !== x.customer ? ` <${x.email}>` : ""}`, x.subject && `Subject: ${x.subject}`].filter(Boolean).join(" · "),
      `Read it with the PostHog MCP: conversations-tickets-retrieve and conversations-tickets-messages-retrieve with id ${x.id}, and inbox-reports-list with source_id ${x.id} and source_product conversations for any investigation PostHog AI already did.`,
      "Find the cause in our code, the customer's data and Grafana as needed, then draft a reply for the customer.",
      "Don't reply, add notes or change the ticket without my go-ahead.",
    ].filter(Boolean).join("\n");
    setShared(NEWTASK, { id: `ticket-${x.id}-${Date.now()}`, at: Date.now(), message, title: `Ticket #${x.number}${x.customer ? `: ${x.customer}` : ""}`.slice(0, 60), repo: POSTHOG(), where: null });
  }

  // Reads the support hero rotation (support.js) and shares it; only the top part does.
  readHeroNow(cx) {
    if (this.heroBusy) return;
    this.heroBusy = true;
    cx.spawn(async (cx) => {
      const prev = shared(HERO) ?? {};
      let next;
      try {
        next = { at: Date.now(), shifts: await readShifts() };
      } catch (e) {
        const setup = e instanceof SupportError && ["no_token", "auth"].includes(e.code);
        next = { ...prev, error: String(e?.message ?? e), setup };
      }
      setShared(HERO, next);
      this.heroBusy = false;
      cx.notify();
    });
  }

  hero() { return heroAt(shared(HERO)?.shifts); }
  isHero() { return this.hero().me; }

  // In your support hero weeks, at the top of the sidebar: the tickets that wait on the team.
  heroCard(t) {
    const h = this.hero();
    if (!h.me) return null;
    const state = shared(SUPPORT);
    const items = state?.items ?? [];
    const waiting = items.filter(needsTeam).sort((a, b) => b.updated - a.updated);
    const shown = waiting.slice(0, 4);
    const more = waiting.length - shown.length;
    return v_flex().id("tk-hero").mx(12).mt(8).p(6).gap(2).rounded(9).border_1().border_color(waiting.length ? t.ansi4 : t.border).bg(t.surface)
      .child(h_flex().px(4).h(24).gap(6).items_center()
        .child(this.icon("support", waiting.length ? t.ansi4 : t.muted, 13))
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Support hero"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`you, until ${dayName(h.until)}`))
        .when(Boolean(state?.busy), (el) => el.child(svg(ICON("spinner")).size(12).flex_none().text_color(t.dim).spin(900)))
        .child(this.iconButton(t, "tk-hero-view", "external", "The Flags Support Hero view in PostHog", () => openInBrowser(supportViewUrl()))))
      .when(Boolean(state?.setup), (el) => el.child(div().px(4).text_size(11).text_color(t.ansi1).child("Connect PostHog in the Support hero section below")))
      .when(!state?.setup && !waiting.length, (el) => el.child(div().px(4).h(22).flex().items_center().text_size(11.5).text_color(t.muted)
        .child(state?.at ? `Nothing waits on the team · ${plural(items.length, "open ticket")}` : "Reading tickets…")))
      .children(shown.map((x) => this.ticketRow(t, x)))
      .when(more > 0, (el) => el.child(div().id("tk-hero-more").px(8).h(22).flex().items_center().cursor_pointer().text_size(11).text_color(t.dim)
        .hover((x) => x.text_color(t.foreground)).on_click(() => this.showView("inbox")).child(`${more} more in the Inbox`)));
  }

  // The rotation's state for the Support hero section's header: a chip, and how to connect incident.io.
  heroChip(t) {
    const state = shared(HERO);
    const h = this.hero();
    if (h.me) return div().id("tk-hero-chip").flex_none().px(5).rounded(4).bg(t.ansi4).text_size(10).text_color(t.background)
      .tooltip(`You're the Feature Flags support hero until ${dayName(h.until)} (incident.io)`).child("you");
    if (state?.setup) return div().id("tk-hero-chip").flex_none().px(5).rounded(4).border_1().border_color(t.ansi3).text_size(10).text_color(t.ansi3)
      .tooltip("Connect incident.io to know your support hero weeks: open this section").child("incident.io?");
    if (!state?.shifts) return null;
    const tip = [h.current ? `${h.current.name} is support hero until ${dayName(h.current.end)}` : "Nobody on the rotation now",
      h.nextMine ? `Your next turn: ${dayName(h.nextMine.start)} to ${dayName(h.nextMine.end)}` : "No turn of yours in the next 5 weeks"].join("\n");
    return div().id("tk-hero-chip").flex_none().max_w(110).truncate().text_size(10.5).text_color(t.dim).tooltip(tip)
      .child(h.current ? h.current.name.split(" ")[0] : "");
  }

  heroSetup(t) {
    const state = shared(HERO);
    if (!state?.setup) return null;
    const command = 'security add-generic-password -U -s herdr-incident -a "$USER" -w';
    const copy = () => exec("/bin/sh", ["-c", 'printf %s "$1" | pbcopy', "sh", command]).then(() => notify({ title: "Command copied", level: "success", timeout: 2000 }));
    return v_flex().px(8).py(6).gap(6)
      .child(div().text_size(11.5).text_color(t.foreground).child("To know your support hero weeks, keep an incident.io API key (read on-call schedules) in the keychain."))
      .child(div().text_size(10.5).text_color(t.ansi1).child(state.error))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button(t, "tk-hero-cmd", "copy", "Copy command", command, () => copy()))
        .child(this.button(t, "tk-hero-sched", "external", "Schedule", scheduleUrl() ?? "", () => openInBrowser(scheduleUrl())))
        .child(this.button(t, "tk-hero-retry", "refresh", "Try again", "Read incident.io now", () => setShared(HERO_ASK, Date.now()))));
  }

  ticketColor(t, x) {
    if (x.status === "new") return t.blocked;
    if (x.unread > 0) return t.ansi4;
    if (x.status === "open") return t.ansi3;
    return t.dim; // pending (on the customer), on hold
  }

  supportCard(t, x) {
    const sla = x.slaDue ? (x.slaDue < Date.now() ? "SLA breached" : `SLA in ${ago(x.slaDue - Date.now())}`) : "";
    const body = [x.subject, x.last].filter(Boolean).join("\n\n");
    return this.extFrame(t, x, {
      icon: "support", iconColor: this.ticketColor(t, x), border: x.slaDue && x.slaDue < Date.now() ? t.ansi1 : t.border,
      where: [`#${x.number}`, x.channel, x.priority].filter(Boolean).join(" · "), title: x.customer || x.subject || "Ticket",
      meta: [x.status.replace("_", " "), x.unread ? `${x.unread} unread` : "", sla, ago(Date.now() - x.updated)].filter(Boolean).join(" · "),
      body: body || null,
      buttons: [
        this.button(t, `ex-investigate-${x.key}`, "plus", "Investigate", "A new task with a Claude session that looks into it", (cx) => { this.investigateTicket(x); cx.notify(); }),
        this.button(t, `ex-open-${x.key}`, "external", "Open in PostHog", x.url, () => openInBrowser(x.url)),
      ],
    });
  }

  // No PostHog API key in the keychain (or PostHog refused it): how to put one there.
  supportSetup(t, state, id) {
    const page = "https://us.posthog.com/settings/user-api-keys";
    const command = 'security add-generic-password -U -s herdr-posthog -a "$USER" -w';
    const copy = (text, what) => exec("/bin/sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]).then(() => notify({ title: `${what} copied`, level: "success", timeout: 2000 }));
    const step = (n, text) => h_flex().gap(8).items_start().child(div().flex_none().text_size(12).text_color(t.dim).child(`${n}.`)).child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(text));
    return v_flex().p(10).gap(8)
      .child(h_flex().gap(8).items_center().child(this.icon("support", t.muted, 13))
        .child(div().text_size(12.5).font_medium().text_color(t.foreground).child("Connect PostHog"))
        .when(Boolean(state?.error), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.ansi1).child(state.error))))
      .child(step(1, "Make a personal API key with Customers & support → Ticket: Read (or add it to yours: it applies within 2 minutes)."))
      .child(step(2, "Run the command in a terminal: it keeps the key in your keychain."))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button(t, `${id}-page`, "external", "API keys", page, () => openInBrowser(page)))
        .child(this.button(t, `${id}-cmd`, "copy", "Copy command", command, () => copy(command, "Command")))
        .child(this.button(t, `${id}-retry`, "refresh", "Try again", "Read the tickets now", () => setShared(SUPPORT_ASK, Date.now()))));
  }

  // The sidebar section: every unresolved ticket of the team, the ones waiting on it first.
  supportBlock(t) {
    // Starts open. isOpen's fallback doesn't apply here: a missing key reads as undefined, not null.
    if (localStorage.getItem("open:support") == null) localStorage.setItem("open:support", "1");
    const open = this.isOpen("support", true);
    const state = shared(SUPPORT);
    const items = [...(state?.items ?? [])].sort((a, b) => Number(needsTeam(b)) - Number(needsTeam(a)) || b.updated - a.updated);
    const waiting = items.filter(needsTeam).length;
    const note = state?.busy && !state?.at ? "Reading tickets…"
      : state?.error && !state?.setup ? state.error
      : !items.length && state?.at ? "No open tickets" : "";
    const ROW = 26;
    const shownRows = Math.min(items.length, 8);
    const heroSetup = this.heroSetup(t);
    const bodyPx = (state?.setup ? 130 : shownRows * ROW + (note ? 24 : 0)) + (heroSetup ? 104 : 0);
    this.sizeBlock("support", open ? 28 + CARD_EXTRA + Math.max(bodyPx, 24) : 28);
    const badge = waiting ? div().px(5).rounded(8).bg(t.blocked).text_size(10).text_color(t.background).child(String(waiting)) : null;
    return this.sectionDragRoot(v_flex().id("tk-support-block").size_full().min_h(0).bg(t.chrome)
      .child(this.sectionHeader(t, "support", "Support hero", { count: items.length || null, badge: h_flex().gap(5).items_center().when(Boolean(badge), (el) => el.child(badge)).when(Boolean(this.heroChip(t)), (el) => el.child(this.heroChip(t))),
        actions: h_flex().gap(2)
          .when(Boolean(state?.busy), (el) => el.child(svg(ICON("spinner")).size(12).flex_none().text_color(t.dim).spin(900)))
          .child(this.iconButton(t, "tk-support-refresh", "refresh", state?.at ? `Read ${ago(Date.now() - state.at)} ago. Read the tickets now` : "Read the tickets now", () => setShared(SUPPORT_ASK, Date.now())))
          .child(this.iconButton(t, "tk-support-view", "external", "The Flags Support Hero view in PostHog", () => openInBrowser(supportViewUrl()))) }))
      .when(open, (el) => el.child(this.sectionCard(t).flex_1().min_h(0)
        .when(Boolean(heroSetup), (el) => el.child(heroSetup))
        .when(Boolean(state?.setup), (el) => el.child(this.supportSetup(t, state, "tk-support-setup")))
        .when(!state?.setup, (el) => el.child(v_flex().id("tk-support-list").flex_1().min_h(0).overflow_y_scrollbar()
          .when(Boolean(note), (el) => el.child(div().px(8).h(24).flex().items_center().truncate().text_size(11)
            .text_color(state?.error ? t.ansi1 : t.dim).child(note)))
          .children(items.map((x) => this.ticketRow(t, x))))))));
  }

  ticketRow(t, x) {
    const hoverKey = `ticket:${x.id}`;
    const tip = [`#${x.number} · ${x.status.replace("_", " ")} · ${x.priority ?? "no priority"} · ${x.channel}`, x.customer && `${x.customer}${x.email && x.email !== x.customer ? ` <${x.email}>` : ""}`, x.subject, x.last && `“${x.last.slice(0, 240)}”`]
      .filter(Boolean).join("\n");
    return h_flex().id(`tk-ticket-${x.id}`).px(8).h(26).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered; cx.notify(); })
      .tooltip(tip)
      .on_click(() => openInBrowser(x.url))
      .child(this.dot({ color: this.ticketColor(t, x) }, 6))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`#${x.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(needsTeam(x) ? t.foreground : t.muted).child(x.customer || x.subject || x.last || "Ticket"))
      .when(x.unread > 0, (el) => el.child(div().flex_none().px(5).rounded(8).bg(t.ansi4).text_size(10).text_color(t.background).child(String(x.unread))))
      .when(this.hovered !== hoverKey, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(Date.now() - x.updated))))
      .when(this.hovered === hoverKey, (el) => el.child(this.iconButton(t, `tk-ticket-inv-${x.id}`, "plus", "Investigate: a new task with a Claude session that looks into it", () => this.investigateTicket(x))));
  }

  // A block whose height follows its content, set only when it changes.
  sizeBlock(id, px) {
    if (findNode(layout(), id)?.size?.px !== px) run("layout.resize", { id, px });
  }

  // ---- the Inbox beyond sessions: alerts, Slack, review requests ----

  // Reads Slack (slack.js) and shares it. Only the top part does, so there's one reader.
  readSlackNow(cx) {
    if (this.slackBusy) return;
    this.slackBusy = true;
    setShared(SLACK, { ...(shared(SLACK) ?? {}), busy: true });
    cx.spawn(async (cx) => {
      let next;
      try {
        const r = await readSlack();
        next = { at: Date.now(), items: r.items, errors: r.errors };
        // Forget dismissals of Slack items that are gone; review ones go when the PR leaves the list.
        const keys = new Set([...r.items.map((x) => x.key), ...(shared(ALERTS)?.items ?? []).map((x) => x.key), ...(shared(SUPPORT)?.items ?? []).map((x) => x.key), ...(shared("gh-inbox.merge")?.reviews ?? []).map((x) => `review:${x.key}`)]);
        const dismissed = shared(EXT_DISMISSED) ?? {};
        const kept = Object.fromEntries(Object.entries(dismissed).filter(([k]) => keys.has(k) || (k.startsWith("review:") && !shared("gh-inbox.merge")?.reviews)));
        if (Object.keys(kept).length !== Object.keys(dismissed).length) setShared(EXT_DISMISSED, kept);
      } catch (e) {
        const { busy: _b, ...prev } = shared(SLACK) ?? {};
        const setup = e instanceof SlackError && ["no_token", "invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "missing_scope"].includes(e.code);
        next = { ...prev, error: String(e?.message ?? e), setup };
      }
      setShared(SLACK, next);
      this.slackBusy = false;
      cx.notify();
    });
  }

  // Reads the team's alerts channel (slack.js) and shares it; only the top part does.
  readAlertsNow(cx) {
    if (this.alertsBusy) return;
    this.alertsBusy = true;
    cx.spawn(async (cx) => {
      try {
        const items = await readAlerts();
        setShared(ALERTS, { at: Date.now(), items });
        this.announceAlerts(items);
      } catch (e) {
        setShared(ALERTS, { ...(shared(ALERTS) ?? {}), error: String(e?.message ?? e) });
      }
      this.alertsBusy = false;
      cx.notify();
    });
  }

  // A toast (and the "blocked" sound) when an alert starts firing, a quieter one when it resolves
  // (none when its escalation is cancelled: it just leaves the Inbox),
  // each once: what was said is kept in shared ALERTS_SEEN, so a reload or a restart says nothing again.
  // The first read ever only speaks of alerts that fired in the last ALERT_FRESH_S.
  announceAlerts(items) {
    const before = shared(ALERTS_SEEN);
    const seen = {};
    for (const x of items) {
      const a = x.alert;
      seen[x.id] = { key: x.key, firing: a.firing };
      const was = before?.[x.id];
      const where = [a.env, a.priority].filter(Boolean).join(" · ");
      if (a.firing && (was?.key !== x.key || !was.firing)) {
        if (!before && Date.now() / 1000 - x.ts > ALERT_FRESH_S) continue;
        notify({
          title: `Alert firing: ${a.name}`,
          body: [where, a.summary].filter(Boolean).join("\n").slice(0, 300),
          level: /critical/i.test(a.priority ?? "") ? "error" : "warning",
          action: { name: "tasks.show-inbox" },
        });
        playSound("blocked");
      } else if (!a.firing && !a.cancelled && was?.firing) {
        notify({ title: `Alert resolved: ${a.name}`, body: where, level: "success", action: { name: "tasks.show-inbox" } });
      }
    }
    setShared(ALERTS_SEEN, seen);
  }

  // What waits on you outside the sessions, minus what you dismissed (until it changes).
  external() {
    const dismissed = shared(EXT_DISMISSED) ?? {};
    const keep = (x) => dismissed[x.key] !== x.version;
    // Alerts come from their own read (ALERTS), so they show whether or not the rest of Slack does.
    const slack = SLACK_IN_INBOX ? (shared(SLACK)?.items ?? []).filter((x) => x.kind !== "alert").filter(keep) : [];
    const alerts = (shared(ALERTS)?.items ?? []).filter((x) => x.alert.firing).filter(keep);
    const reviews = (shared("gh-inbox.merge")?.reviews ?? [])
      .map((r) => ({ ...r, pr: r.key, key: `review:${r.key}`, version: String(r.updated) })).filter(keep)
      .sort((a, b) => b.updated - a.updated);
    // Support tickets that wait on the team: new, or the customer wrote and nobody read it yet.
    const supportAll = (shared(SUPPORT)?.items ?? []).filter(needsTeam).filter(keep);
    const hero = this.isHero();
    const support = hero ? supportAll : [];
    const teamSupport = hero ? [] : supportAll;
    // Reviews asked of a team you're on show too, but don't count: only ones asked of you do (the user's call).
    return {
      alerts,
      support,
      teamSupport,
      replies: slack.filter((x) => x.kind === "dm" || x.kind === "mention"),
      team: slack.filter((x) => x.kind === "team"),
      reviews: reviews.filter((r) => r.direct),
      teamReviews: reviews.filter((r) => !r.direct),
      count: slack.length + alerts.length + support.length + reviews.filter((r) => r.direct).length,
    };
  }

  dismissExternal(x) {
    setShared(EXT_DISMISSED, { ...(shared(EXT_DISMISSED) ?? {}), [x.key]: x.version });
  }

  // A Claude task that looks into a firing alert, made the way the New task dialog makes one.
  investigateAlert(x) {
    const a = x.alert;
    const message = [
      `Investigate this firing alert from ${channelName("alerts")}: "${a.name}" (${[a.env, a.priority].filter(Boolean).join(", ")}).`,
      a.summary,
      `Slack: ${x.link}`,
      a.incident && `incident.io: ${a.incident}`,
      a.runbook && `Runbook: ${a.runbook}`,
      a.dashboard && `Dashboard: ${a.dashboard}`,
      "Follow the runbook and use Grafana to find the cause. Tell me what you find before changing anything or posting anywhere.",
    ].filter(Boolean).join("\n");
    setShared(NEWTASK, { id: `alert-${x.key}-${Date.now()}`, at: Date.now(), message, title: `Alert: ${a.name}`.slice(0, 60), repo: POSTHOG(), where: null });
  }

  // The card frame every outside item uses: a header line, an optional body, buttons.
  extFrame(t, x, { icon, iconColor, where, title, meta, body, buttons, border }) {
    return v_flex().id(`ex-${x.key}`).p(12).gap(8).rounded(10).border_1().border_color(border ?? t.border).bg(t.surface)
      .child(h_flex().id(`ex-head-${x.key}`).gap(8).items_center().min_w(0).cursor_pointer().on_click(() => openInBrowser(x.link ?? x.url))
        .child(this.icon(icon, iconColor, 13))
        .child(div().flex_none().max_w(220).truncate().text_size(11.5).text_color(t.muted).child(where))
        .child(div().text_size(11.5).text_color(t.dim).child("›"))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(t.foreground).child(title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(meta)))
      .when(Boolean(body), (el) => el.child(div().px(10).py(7).rounded(6).bg(t.raised).text_size(12).text_color(t.foreground).child(body)))
      .child(h_flex().gap(6).flex_wrap().children(buttons.filter(Boolean))
        .child(this.button(t, `ex-dismiss-${x.key}`, "check", "Dismiss", "Out of the Inbox until it changes", (cx) => { this.dismissExternal(x); cx.notify(); })));
  }

  slackCard(t, x) {
    const since = ago(Date.now() - x.ts * 1000);
    const meta = x.kind === "team" ? `${x.reason} · ${since}` : since;
    return this.extFrame(t, x, {
      icon: "comment", iconColor: x.kind === "dm" ? t.ansi4 : t.muted, where: x.where, title: x.author, meta, body: x.text,
      buttons: [this.button(t, `ex-open-${x.key}`, "external", "Open in Slack", "The message in Slack", () => openInBrowser(x.link))],
    });
  }

  alertCard(t, x) {
    const a = x.alert;
    const critical = /critical/i.test(a.priority ?? "");
    const link = (id, label, url, tip) => url && this.button(t, `ex-${id}-${x.key}`, "external", label, tip, () => openInBrowser(url));
    return this.extFrame(t, x, {
      icon: "waiting", iconColor: critical ? t.ansi1 : t.ansi3, border: critical ? t.ansi1 : t.border,
      where: [a.env, a.priority].filter(Boolean).join(" · ") || x.where, title: a.name,
      meta: `${a.status ? `${a.status} · ` : ""}${ago(Date.now() - x.ts * 1000)}`, body: a.summary,
      buttons: [
        this.button(t, `ex-investigate-${x.key}`, "plus", "Investigate", "A new task with a Claude session that looks into it", (cx) => { this.investigateAlert(x); cx.notify(); }),
        link("slack", "Slack", x.link, `The alert in ${channelName("alerts")}`),
        link("incident", "incident.io", a.incident, "Acknowledge, resolve or snooze it there"),
        link("runbook", "Runbook", a.runbook, a.runbook),
        link("dash", "Dashboard", a.dashboard, a.dashboard),
      ],
    });
  }

  reviewCard(t, x) {
    const { repo, number } = splitKey(x.pr);
    const via = x.direct ? "asked of you" : x.teams.length ? `via ${x.teams.join(", ")}` : "";
    return this.extFrame(t, x, {
      icon: x.draft ? "pr-draft" : "pr", iconColor: x.direct ? t.ansi2 : t.muted, where: `${repo === DEFAULT_REPO ? "" : repo}#${number}`,
      title: x.title, meta: [x.author, `+${x.additions} −${x.deletions}`, via, ago(Date.now() - x.updated)].filter(Boolean).join(" · "),
      buttons: [this.button(t, `ex-open-${x.key}`, "external", "Open on GitHub", x.url, () => openInBrowser(x.url))],
    });
  }

  // No Slack token in the keychain (or Slack refused it): how to put it there. The token is the
  // User OAuth Token of the Slack app this reads with (its id: "slack": { "app" } in the private
  // settings), on its Install App page.
  slackSetup(t, state) {
    const page = PRIVATE.slack?.app ? `https://api.slack.com/apps/${PRIVATE.slack.app}/install-on-team` : "https://api.slack.com/apps";
    const command = 'security add-generic-password -U -s herdr-slack -a "$USER" -w';
    const copy = (text, what) => exec("/bin/sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]).then(() => notify({ title: `${what} copied`, level: "success", timeout: 2000 }));
    const step = (n, text) => h_flex().gap(8).items_start().child(div().flex_none().text_size(12).text_color(t.dim).child(`${n}.`)).child(div().flex_1().text_size(12.5).text_color(t.foreground).child(text));
    return v_flex().p(12).gap(8).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center().child(this.icon("comment", t.muted, 13))
        .child(div().text_size(13).font_medium().text_color(t.foreground).child("Connect Slack"))
        .when(Boolean(state?.error), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.ansi1).child(state.error))))
      .child(step(1, "Copy the User OAuth Token (xoxp-…) of the Herdr Inbox app, on its Install App page."))
      .child(step(2, "Run the command in a terminal: it asks for the token and keeps it in your keychain."))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button(t, "ex-slack-page", "external", "Open the app's page", page, () => openInBrowser(page)))
        .child(this.button(t, "ex-slack-cmd", "copy", "Copy command", command, () => copy(command, "Command")))
        .child(this.button(t, "ex-slack-retry", "refresh", "Try again", "Read Slack now", () => setShared(SLACK_ASK, Date.now()))));
  }

  inbox(t, list, ag) {
    const waiting = this.waiting(list, ag);
    const blocked = waiting.filter((a) => a.status === "blocked");
    const asked = waiting.filter((a) => a.status !== "blocked");
    const ext = this.external();
    const slack = shared(SLACK);
    const section = (label, items, color, card) => v_flex().gap(8)
      .child(h_flex().gap(8).items_center().pt(6)
        .child(div().text_size(12).font_semibold().text_color(color).child(label))
        .child(div().text_size(11.5).text_color(t.dim).child(String(items.length))))
      .children(items.map(card));
    const sessionCard = (a) => this.inboxCard(t, a, list);
    const slackNote = !SLACK_IN_INBOX ? "" : slack?.busy ? "Reading Slack…"
      : slack?.error && !slack?.setup ? `Slack: ${slack.error}`
      : slack?.errors?.length ? `Slack: ${slack.errors.join("; ")}`
      : slack?.at ? `Slack read ${ago(Date.now() - slack.at)} ago` : "";
    const empty = !waiting.length && !ext.count && !ext.teamReviews.length && !ext.teamSupport.length;
    return v_flex().id("inbox").size_full().bg(t.canvas).overflow_y_scrollbar().px(24).py(20).gap(16)
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child("Inbox"))
        .child(div().flex_1().text_size(12).text_color(t.dim).child("What waits on you"))
        .when(Boolean(slackNote), (el) => el.child(div().text_size(11).text_color(slack?.error || slack?.errors?.length ? t.ansi1 : t.dim).child(slackNote)))
        .child(this.button(t, "ex-refresh", "refresh", "Refresh", "Read Slack, support tickets and GitHub again", () => { setShared(SLACK_ASK, Date.now()); setShared(SUPPORT_ASK, Date.now()); run("gh-inbox.refresh"); })))
      .when(SLACK_IN_INBOX && Boolean(slack?.setup), (el) => el.child(this.slackSetup(t, slack)))
      .when(empty, (el) => el.child(div().pt(40).w_full().flex().justify_center().text_size(13).text_color(t.dim).child("Nothing waits on you.")))
      .when(blocked.length > 0, (el) => el.child(section("Needs you", blocked, t.blocked, sessionCard)))
      .when(ext.alerts.length > 0, (el) => el.child(section(`Alerts firing · ${channelName("alerts")}`, ext.alerts, t.ansi1, (x) => this.alertCard(t, x))))
      .when(ext.support.length > 0, (el) => el.child(section("Support hero · you're on this week", ext.support, t.ansi4, (x) => this.supportCard(t, x))))
      .when(Boolean(shared(SUPPORT)?.setup), (el) => el.child(v_flex().rounded(10).border_1().border_color(t.border).bg(t.surface).child(this.supportSetup(t, shared(SUPPORT), "ex-support-setup"))))
      .when(asked.length > 0, (el) => el.child(section("Asked you", asked, t.ansi3, sessionCard)))
      .when(ext.replies.length > 0, (el) => el.child(section("Slack: waiting on your reply", ext.replies, t.ansi4, (x) => this.slackCard(t, x))))
      .when(ext.reviews.length > 0, (el) => el.child(section("Reviews requested from you", ext.reviews, t.ansi2, (x) => this.reviewCard(t, x))))
      .when(ext.team.length > 0, (el) => el.child(section(`${channelName("team")}: no answer yet`, ext.team, t.muted, (x) => this.slackCard(t, x))))
      .when(ext.teamReviews.length > 0, (el) => el.child(section("Reviews asked of your teams · not counted", ext.teamReviews, t.muted, (x) => this.reviewCard(t, x))))
      .when(ext.teamSupport.length > 0, (el) => el.child(section(`Support tickets · ${this.hero().current ? `${this.hero().current.name.split(" ")[0]} is hero` : "Team Feature Flags"} · not counted`, ext.teamSupport, t.muted, (x) => this.supportCard(t, x))));
  }

  // ---- to-dos ----

  todos() { return shared(TODOS) ?? []; }

  addTodo(text) {
    const id = `td-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setShared(TODOS, [...this.todos(), { id, text, done: false, at: Date.now() }]);
    localStorage.setItem("open:todos", "1");
  }

  setTodo(id, change) {
    setShared(TODOS, this.todos().map((x) => (x.id === id ? { ...x, ...change } : x)));
  }

  removeTodo(id) {
    setShared(TODOS, this.todos().filter((x) => x.id !== id));
  }

  // A to-do that's become work: a task named after it, with a Claude session.
  todoToTask(todo) {
    run("space.new", { name: todo.text.slice(0, 60), argv: claudeArgv() });
    this.setTodo(todo.id, { done: true });
  }

  todoRow(t, todo) {
    const hoverKey = `todo:${todo.id}`;
    return h_flex().id(`tk-todo-${todo.id}`).px(8).py(3).gap(8).items_start().rounded(6)
      .hover((x) => x.bg(t.hover))
      .on_hover((on, cx) => { this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered; cx.notify(); })
      .child(div().id(`tk-todo-check-${todo.id}`).mt(1).flex_none().cursor_pointer().tooltip(todo.done ? "Mark as not done" : "Done")
        .on_click((_e, cx) => { this.setTodo(todo.id, { done: !todo.done }); cx.notify(); })
        .child(this.icon(todo.done ? "circle-check" : "square", todo.done ? t.ansi2 : t.muted, 13)))
      .child(div().flex_1().min_w(0).text_size(12).text_color(todo.done ? t.dim : t.foreground)
        .when(todo.done, (el) => el.line_through()).child(todo.text))
      .when(this.hovered === hoverKey, (el) => el
        .when(!todo.done, (el) => el.child(this.iconButton(t, `tk-todo-task-${todo.id}`, "plus", "Make it a task (with a Claude session)", () => this.todoToTask(todo))))
        .child(this.iconButton(t, `tk-todo-rm-${todo.id}`, "x", "Delete", () => this.removeTodo(todo.id))));
  }

  // Under New task: add a to-do, and open or close the list.
  todoBar(t) {
    const adding = this.adding === "todo";
    return h_flex().id("tk-newtodo").mx(12).mt(6).h(28).flex_none().gap(6).items_center().justify_center().rounded(8).cursor_pointer()
      .border_1().border_color(adding ? t.accent : t.input).bg(t.raised)
      .text_size(12).font_medium().text_color(t.foreground).hover((x) => x.opacity(0.88))
      .tooltip("Adds a to-do")
      .on_click((_e, cx) => { if (!adding) localStorage.setItem("open:todos", "1"); this.startAdding("todo", cx); })
      .child(svg(ICON("plus")).size(13).flex_none())
      .child(div().child(adding ? "Cancel" : "New todo"));
  }

  todoList(t) {
    const todos = this.todos();
    const open = todos.filter((x) => !x.done);
    const done = todos.filter((x) => x.done);
    return v_flex().mx(8).p(4).flex_none().rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(v_flex().id("tk-todo-list").max_h(260).overflow_y_scrollbar()
        .children(open.map((x) => this.todoRow(t, x)))
        .children(done.map((x) => this.todoRow(t, x)))
        .when(!todos.length, (el) => el.child(div().px(8).py(6).text_size(11.5).text_color(t.dim).child("Nothing to do. New todo adds one."))))
      .when(done.length > 0, (el) => el.child(h_flex().px(8).pt(4).pb(2)
        .child(this.link(t, "tk-todo-clear", `Clear ${done.length} done`, () => setShared(TODOS, open)))));
  }

  // ---- devboxes ----

  // Your devboxes, as `coder list` has them.
  async fetchDevboxes() {
    try {
      if (!this.devboxUser) {
        const who = JSON.parse((await exec(CODER(), ["whoami", "-o", "json"])).stdout || "[]");
        this.devboxUser = (Array.isArray(who) ? who[0] : who)?.username;
      }
      const r = await exec(CODER(), ["list", "--output", "json"]);
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `coder exited ${r.code}`);
      const prefix = `devbox-${this.devboxUser}`;
      this.devboxes = JSON.parse(r.stdout || "[]").filter((w) => w.name === prefix || w.name.startsWith(`${prefix}-`)).map((w) => ({
        name: w.name,
        label: w.name === prefix ? "default" : w.name.slice(prefix.length + 1),
        status: w.latest_build?.status ?? "unknown",
        // Its agents' startup: "ready" once all are, else the first other state ("starting"…).
        agent: (() => {
          const states = (w.latest_build?.resources ?? []).flatMap((r) => r.agents ?? []).map((a) => a.lifecycle_state);
          return states.length && states.every((x) => x === "ready") ? "ready" : states.find((x) => x !== "ready") ?? null;
        })(),
      }));
      this.devboxError = null;
      if (JSON.stringify(this.devboxes) !== JSON.stringify(shared(DEVBOXES) ?? [])) setShared(DEVBOXES, this.devboxes);
      return this.devboxes;
    } catch (e) {
      const msg = String(e?.message ?? e);
      // No route to Coder's server (a private address) is the VPN, not hogli's setup.
      this.devboxError = /dial tcp|i\/o timeout|no such host|connection refused|network is unreachable|longer than 30 s/i.test(msg)
        ? "Can't reach Coder: is Tailscale connected?"
        : `Devboxes unavailable: ${msg.slice(0, 120)}. Run hogli devbox:setup.`;
      return null;
    }
  }

  // Your devboxes (coder) and Herdr's machines (hc), which say which devbox Herdr reaches as what.
  async refreshDevboxes() {
    await this.fetchDevboxes();
    const r = await exec("hc", ["machine", "ls", "--json"]).catch(() => null);
    try { this.hcMachines = JSON.parse(r?.stdout || "{}").machines ?? []; } catch { this.hcMachines = []; }
  }

  loadDevboxes(cx) {
    cx.spawn(async (cx) => { await this.refreshDevboxes(); cx.notify(); });
  }

  // Keeps your devboxes in Herdr's machines (Settings → Machines, spaces by machine): each one
  // running gets added as "devbox-<label>" (hc installs itself there), and the machines of
  // devboxes that are gone are forgotten. Only machines named devbox-* that reach coder.devbox-*
  // are touched. A stopped devbox can't be added (nothing answers), but stays once added.
  syncDevboxMachines(cx) {
    if (this.syncingDevboxes) return;
    this.syncingDevboxes = true;
    this.devboxRetry ??= {};
    cx.spawn(async (cx) => {
      try {
        const boxes = await this.fetchDevboxes();
        if (!boxes) return;
        const ls = JSON.parse((await exec("hc", ["machine", "ls", "--json"])).stdout || "{}").machines ?? [];
        const ours = ls.filter((m) => /^devbox-/.test(m.name) && /(^| )coder\.devbox-\S+$/.test(m.target ?? ""));
        for (const b of boxes) {
          const name = devboxMachine(b.label);
          if (b.status !== "running" || ls.some((m) => m.name === name)) continue;
          if (Date.now() < (this.devboxRetry[name] ?? 0)) continue;
          const r = await exec("hc", addDevboxArgs(b.name, name)).catch((e) => ({ code: 1, stderr: String(e) }));
          if (r.code !== 0) {
            this.devboxRetry[name] = Date.now() + 10 * 60000;
            this.devboxError = `Couldn't add devbox ${b.label} to Herdr: ${r.stderr.trim().split("\n").pop()}`;
          } else {
            notify({ title: `Devbox ${b.label} added`, body: "It's in Herdr's machines now.", level: "success", timeout: 5000 });
          }
        }
        const live = new Set(boxes.map((b) => b.name));
        for (const m of ours) {
          if (!live.has(m.target.replace(/^.*coder\./, ""))) await exec("hc", ["machine", "rm", m.name]).catch(() => null);
        }
      } finally {
        this.syncingDevboxes = false;
        cx.notify();
      }
    });
  }

  // Where a new task runs, in the New task dialog's own label and chips: this Mac, one of your
  // devboxes (running ones first; a stopped one starts first), or a new devbox for this task alone.
  whereField(t, name, label, chip) {
    const w = this.where;
    const user = this.devboxUser ?? "you";
    const preview = taskDevboxLabel(name, user).replace(/-[0-9a-f]{4}$/, "-…");
    const boxes = (this.devboxes ?? []).filter((d) => d.status !== "deleted")
      .sort((a, b) => (b.status === "running") - (a.status === "running") || a.label.localeCompare(b.label));
    const picked = boxes.find((d) => d.name === w?.name);
    return v_flex().gap(8)
      .child(label("Run in"))
      .child(h_flex().flex_wrap().gap(5)
        .child(chip("tk-where-local", "This Mac", !w, () => { this.where = null; }))
        .children(boxes.map((d) => {
          const tasks = this.tasksOnDevbox(d.name);
          const tip = [d.name, d.status === "running" ? null : `${d.status}: starts first (a few minutes)`,
            tasks.length ? `Tasks there: ${tasks.join(", ")}` : null].filter(Boolean).join("\n");
          return chip(`tk-where-${d.name}`, `☁ ${d.label}${d.status === "running" ? "" : ` (${d.status})`}`,
            w?.name === d.name, () => { this.where = { name: d.name, label: d.label }; }, tip);
        }))
        .child(chip("tk-where-new", "+ New devbox", Boolean(w?.create), () => { this.where = { create: true }; },
          "Creates a devbox for this task alone (takes a few minutes, and costs while it runs)")))
      .when(Boolean(w?.create), (el) => el.child(div().text_size(10.5).text_color(t.dim)
        .child(`Creates devbox-${user}-${preview}. Archive stops it; Clean up deletes it.`)))
      .when(Boolean(picked), (el) => el.child(div().text_size(10.5).text_color(t.dim)
        .child(`Runs on ${picked.name}${picked.status === "running" ? "" : ", started first"}. Shared: archiving or cleaning up this task leaves it as it is.`)))
      .when(Boolean(this.devboxError), (el) => el.child(div().text_size(10.5).text_color(t.ansi1).child(this.devboxError)));
  }

  // Runs a new task on a devbox: `hogli devbox:start <label>` creates (or starts) it in a tab of
  // the Devboxes space, where its progress and any question show (the progress line under New
  // task opens it). Once its startup scripts end, it's added as a Herdr machine and the task opens
  // there with a Claude session in the repo's checkout. A new one is the task's own (shared
  // TASK_DEVBOXES): Archive stops it, Clean up deletes it.
  createInDevbox(name, where, cx, { repo = null, task = null } = {}) {
    if (where.create && !this.devboxUser) { this.error = this.devboxError ?? "Coder doesn't say who you are: run hogli devbox:setup."; return; }
    const label = where.create ? taskDevboxLabel(name, this.devboxUser) : where.label;
    const known = (this.devboxes ?? []).find((d) => d.label === label);
    const ws = known?.name ?? `devbox-${this.devboxUser}${label === "default" ? "" : `-${label}`}`;
    // Herdr may know the devbox already (another task, the hogli panel): by where it points.
    const machine = this.machineFor(ws) ?? devboxMachine(label);
    if (where.create) setShared(TASK_DEVBOXES, { ...(shared(TASK_DEVBOXES) ?? {}), [machine]: ws });
    this.creating = { name, label, phase: known?.status === "running" ? "Connecting" : where.create ? "Creating devbox" : "Starting devbox" };
    cx.spawn(async (cx) => {
      try {
        if (known?.status !== "running" || known?.agent !== "ready") {
          this.runInDevboxTab(label, "start", cx);
          const ok = await this.untilDevbox(ws, (b) => b?.status === "running" && ["ready", "start_error", "start_timeout"].includes(b.agent), cx);
          if (!ok) throw new Error(`devbox ${ws} didn't come up; its tab in Devboxes says why`);
        }
        this.creating.phase = "Connecting";
        cx.notify();
        await this.reachDevbox(machine, ws, cx);
        this.creating.phase = "Opening the task";
        cx.notify();
        // The repo's checkout there, where hogli puts it: ~/<repo's folder name>.
        const dir = (repo ?? DEFAULT_REPO).split("/").pop();
        const found = await exec("sh", ["-c", 'cd ~/"$1" 2>/dev/null && pwd', "sh", dir], { on: machine }).catch(() => null);
        const folder = found?.stdout.trim() || undefined;
        if (!folder) notify({ title: `No ~/${dir} on devbox ${label}`, body: "The task starts in the devbox's home.", level: "warning", timeout: 6000 });
        // So PRs opened there reach the task, and its Clean up can show.
        await this.installPrHook(machine).catch((e) => notify({ title: `PR hook not installed on ${label}`,
          body: `PRs opened there won't join the task on their own (+ in its card adds them). ${String(e?.message ?? e)}`, level: "warning", timeout: 8000 }));
        run("space.new", { name, argv: ["claude"], machine, ...(folder ? { folder } : {}), ...(task ? { task } : {}) });
        // hogli is done with it: its tab goes.
        const tab = this.devboxTab(label);
        if (tab) run("tab.close", { id: tab.id, confirmed: true });
        this.creating = null;
      } catch (e) {
        // A devbox made for a task that never opened would run (and bill) unseen: it goes. hogli's
        // tab in Devboxes keeps its output.
        const gone = where.create ? `; deleting ${ws}` : "";
        this.error = `Devbox task “${name}”: ${String(e?.message ?? e)}${gone}`;
        this.creating = null;
        if (where.create) {
          this.forgetTaskDevbox(machine);
          this.devboxBuild(ws, "delete", cx);
        }
      }
      cx.notify();
    });
  }

  // ---- Claude accounts ----

  // Who each account is (from its .claude.json), and which account each Claude session runs as
  // (from its process's environment), for every block and the pane header to show.
  trackAccounts(cx) {
    if (this.trackingAccounts) return;
    this.trackingAccounts = true;
    this.accountOf ??= {}; // terminal address -> { pid, name }
    cx.spawn(async (cx) => {
      try {
        const accs = await readAccounts();
        if (JSON.stringify(accs) !== JSON.stringify(shared(ACCOUNTS) ?? [])) setShared(ACCOUNTS, accs);
        if (accs.length > 1) {
          await ensureLauncher();
          const live = agents().filter((a) => a.app === "claude-code");
          for (const a of live) {
            const r = await exec("hc", ["get", a.address, "--json"]).catch(() => null);
            const pid = r?.code === 0 ? JSON.parse(r.stdout)?.foreground?.pid : null;
            if (!pid) continue;
            if (this.accountOf[a.address]?.pid !== pid) this.accountOf[a.address] = { pid, name: await sessionAccount(pid) };
          }
          const map = Object.fromEntries(live.filter((a) => this.accountOf[a.address]).map((a) => [a.address, this.accountOf[a.address].name]));
          if (JSON.stringify(map) !== JSON.stringify(shared(SESSION_ACCOUNTS) ?? {})) setShared(SESSION_ACCOUNTS, map);
        }
      } catch (e) {
        this.error = `Claude accounts: ${String(e?.message ?? e)}`;
      } finally {
        this.trackingAccounts = false;
      }
      cx.notify();
    });
  }

  accountChip(t, id, name) {
    const a = (shared(ACCOUNTS) ?? []).find((x) => x.name === name);
    return div().id(id).flex_none().max_w(90).truncate().px(5).rounded(4).bg(name === MAIN ? t.raised : t.selected)
      .text_size(10).text_color(name === MAIN ? t.dim : t.foreground)
      .tooltip(a?.email ? `Claude account ${name}: ${a.email}${a.org ? ` (${a.org})` : ""}` : `Claude account ${name}`)
      .child(name);
  }

  // Under a session: the other accounts, each reopening this conversation as it.
  reopenPicker(t, s, tab, depth, indent) {
    const cur = (shared(SESSION_ACCOUNTS) ?? {})[agents().find((a) => a.tab === tab.id)?.address];
    const others = (shared(ACCOUNTS) ?? []).filter((a) => a.name !== cur);
    return h_flex().pl(indent + 16 * Math.min(depth, 4) + 20).pr(8).py(4).gap(5).flex_wrap().items_center()
      .child(div().text_size(10.5).text_color(t.dim).child("Reopen as"))
      .children(others.map((a) => this.button(t, `tk-reopen-${tab.id}-${a.name}`, "user", a.name, a.email ?? "Not logged in yet", (cx) => this.reopenAs(s, tab, a.name, cx))))
      .child(this.button(t, `tk-reopen-cancel-${tab.id}`, "x", "Cancel", "Keeps it as it is", (cx) => { this.switchingTab = null; cx.notify(); }));
  }

  // The same conversation as another account: this session closes, and `claude --resume` opens
  // it in a new tab of the task, in the same folder. Nothing to resume (no message yet): a fresh one.
  reopenAs(s, tab, name, cx) {
    this.switchingTab = null;
    cx.spawn(async (cx) => {
      try {
        const [entry] = await this.describeSessions({ ...s, tabs: [tab] });
        this.closeSession(tab.id);
        run("tab.new", { space: s.id, ...(entry?.name ? { name: entry.name } : {}), ...(entry?.cwd ? { folder: entry.cwd } : {}),
          argv: claudeArgv(name, entry?.sessionId ? ["--resume", entry.sessionId] : []) });
      } catch (e) {
        notify({ title: `Couldn't reopen as ${name}`, body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  // ---- New task: a dialog ----

  openNewTask(where = null) {
    openOverlay({ mod: "tasks", kind: "dialog", modal: true, width: 540, height: 610, props: { part: "new-task", where } });
  }

  // The dialog's copy of this mod: the message first (focused), then an optional title, the repo
  // (the monorepo unless picked) and where it runs. It hands the ask to the top block, which
  // outlives the dialog and shows a devbox task's progress.
  initNewTask(cx) {
    this.message = TextareaState.new({ placeholder: "What should Claude do? It's the session's first message.", rows: 5 });
    this.title = InputState.new({ placeholder: "Named after the message if empty" });
    this.message.on("change", (_e, cx) => cx.notify());
    this.title.on("change", (_e, cx) => cx.notify());
    this.title.on("submit", (_e, cx) => this.createFromDialog(cx));
    this.message.on("submit", (_e, cx) => this.createFromDialog(cx));
    // A paste with no text: an image, as in a Claude session's prompt.
    this.message.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.images = 0;
    this.account = defaultAccount();
    const all = this.repos();
    this.repo = all.find((r) => r.split("/").pop() === DEFAULT_REPO) ?? all[0];
    this.where = DEVBOXES_ON || DEVBOX_TASKS ? props()?.where ?? null : null;
    if (DEVBOXES_ON || DEVBOX_TASKS) {
      this.devboxes = shared(DEVBOXES) ?? null;
      this.loadDevboxes(cx);
    }
    this.handle = cx.focus_handle();
    this.message.focus();
  }

  // Puts an image in the message where the cursor is: a chip that stands for its file.
  addImage(path) {
    this.images += 1;
    this.message.replace_with_token({ id: path, text: `[Image #${this.images}: ${path}]`, label: `Image #${this.images}` });
    this.error = null;
  }

  pasteImage(cx) {
    const dir = `${home()}/.cache/herdr-task-images`;
    const file = `${dir}/${Date.now()}.png`;
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", dir]);
        const r = await exec("osascript", ["-e", SAVE_CLIPBOARD_PNG, file]);
        if (r.code !== 0) throw new Error("The clipboard holds no image.");
        this.addImage(file);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // The message as Claude gets it: each image chip as its "[Image #n: path]".
  messageText() {
    const c = this.message.content();
    let text = c.text;
    for (const sp of [...(c.tokens ?? [])].sort((a, b) => b.range.start - a.range.start)) {
      if (text.slice(sp.range.start, sp.range.end) !== sp.token.text) text = text.slice(0, sp.range.start) + sp.token.text + text.slice(sp.range.end);
    }
    return text.trim();
  }

  // Any folder for the task's Claude session, not only the repos listed in Worktrees.
  chooseFolder(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Start the task here" }).catch(() => null);
      if (dir) { this.repo = dir; this.error = null; }
      cx.notify();
    });
  }

  createFromDialog(cx) {
    const message = this.messageText();
    const title = this.title.value().trim() || titleFrom(message);
    if (!title) { this.error = "Write a message or a title."; cx.notify(); return; }
    setShared(NEWTASK, { id: `${Date.now()}-${Math.random()}`, at: Date.now(), message, title, repo: this.repo, where: this.where, account: this.account });
    closeOverlay(props()?.overlay);
  }

  // The top block: carries out the dialog's ask, once. An old one (Herdr restarted) is dropped.
  takeNewTask(cx) {
    const ask = shared(NEWTASK);
    if (!ask || ask.id === this.tookNewTask) return;
    this.tookNewTask = ask.id;
    setShared(NEWTASK, null);
    if (Date.now() - ask.at > 15000) return;
    const task = ask.message || null;
    // A devbox task needs this copy to know the devboxes (and your coder user) first.
    if (ask.where) cx.spawn(async (cx) => { await this.refreshDevboxes(); this.createInDevbox(ask.title, ask.where, cx, { repo: ask.repo, task }); cx.notify(); });
    else run("space.new", { name: ask.title, argv: claudeArgv(ask.account ?? defaultAccount()), ...(ask.repo ? { folder: ask.repo } : {}), ...(task ? { task } : {}) });
    this.showWork();
    cx.notify();
  }

  newTaskDialog(t) {
    const label = (text) => div().text_size(12).text_color(t.muted).child(text);
    const field = (el) => el.w_full().px(10).py(8).rounded(7).border_1().border_color(t.border).bg(t.background).text_color(t.foreground).text_size(13);
    const chip = (id, text, on, onClick, tip) => h_flex().id(id).h(26).px(9).gap(5).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.input).bg(on ? t.selected : t.raised)
      .text_size(12).text_color(on ? t.foreground : t.muted).hover((x) => x.text_color(t.foreground))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => { onClick(); this.error = null; cx.notify(); }).child(text);
    const btn = (id, text, onClick, primary = false) => div().id(id).px(14).py(7).rounded(7).border_1().border_color(primary ? t.accent : t.border)
      .bg(primary ? t.accent : t.raised).text_size(13).text_color(primary ? t.accent_foreground : t.muted).cursor_pointer()
      .hover((x) => x.opacity(0.88)).on_click((_e, cx) => onClick(cx)).child(text);
    const title = this.title.value().trim() || titleFrom(this.messageText());
    const listed = this.repos();
    const repoChips = [...listed, ...(listed.includes(this.repo) ? [] : [this.repo])];
    return v_flex().id("tk-newtask-dialog").track_focus(this.handle).size_full().bg(t.popover)
      // Image files dropped on the dialog go in the message, like a pasted one.
      .on_drop((e, cx) => {
        for (const path of (e.paths ?? []).filter((x) => IMAGE_EXT.test(x))) this.addImage(path);
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props()?.overlay); }
        if (e.keystroke === "cmd-enter") { cx.stop_propagation(); this.createFromDialog(cx); }
      })
      .child(div().flex_none().px(22).pt(18).pb(12).text_size(17).font_semibold().text_color(t.foreground).child("New task"))
      .child(v_flex().id("tk-newtask-body").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).flex_1().min_h(0).overflow_y_scrollbar().px(22).gap(8)
        .child(label("Message"))
        .child(field(Textarea.new(this.message)).h(120))
        .child(div().text_size(10.5).text_color(t.dim).child("Paste or drop images; Claude gets each one's file."))
        .child(label("Title (optional)"))
        .child(field(Input.new(this.title)).h(36))
        .child(label("Repo"))
        .child(h_flex().flex_wrap().gap(5)
          .children(repoChips.map((r) => chip(`tk-nt-repo-${r}`, r.split("/").pop(), this.repo === r, () => { this.repo = r; }, r.replace(home(), "~"))))
          .child(div().id("tk-nt-folder").h(26).px(9).flex().items_center().rounded(6).cursor_pointer()
            .border_1().border_dashed().border_color(t.input).text_size(12).text_color(t.muted).hover((x) => x.text_color(t.foreground))
            .tooltip("Pick any folder for this task's session")
            .on_click((_e, cx) => this.chooseFolder(cx)).child("Choose folder…")))
        .child(div().text_size(10.5).text_color(t.dim).child((this.repo ?? "").replace(home(), "~")))
        .when(DEVBOXES_ON || DEVBOX_TASKS, (el) => el.child(this.whereField(t, title, label, chip)))
        // Accounts are this Mac's (a devbox runs its own claude): only asked for here, after where it runs.
        .when((shared(ACCOUNTS) ?? []).length > 1 && !this.where, (el) => el
          .child(label("Claude account"))
          .child(h_flex().flex_wrap().gap(5).children((shared(ACCOUNTS) ?? []).map((a) => chip(`tk-nt-acct-${a.name}`, a.name, this.account === a.name,
            () => { this.account = a.name; }, a.email ? `${a.email}${a.org ? `\n${a.org}` : ""}` : "Not logged in yet")))))
        .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.error))))
      .child(h_flex().flex_none().px(22).py(14).gap(8).items_center().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().flex_1().text_size(11).text_color(t.dim).child("⌘Enter creates it · Esc cancels"))
        .child(btn("tk-nt-cancel", "Cancel", () => closeOverlay(props()?.overlay)))
        .child(btn("tk-nt-create", "Create task", (cx) => this.createFromDialog(cx), true)));
  }

  startAdding(what, cx) {
    if (what === "task") return this.openNewTask();
    this.adding = this.adding === what ? null : what;
    this.input.set_value("");
    if (this.adding) this.input.focus();
    cx.notify();
  }

  cancelAdding(cx) {
    this.adding = null;
    this.where = null;
    this.input.set_value("");
    cx.notify();
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  // ---- what each thing shows ----

  // What happens next for a PR, most blocking first (the pull requests panel's words).
  step(i, t) {
    const c = { ok: t.ansi2, bad: t.ansi1, warn: t.ansi3, run: t.working ?? t.ansi4, merged: t.ansi5 };
    if (!i) return { icon: "pr", color: t.dim, label: this.error ? "Couldn't load" : "Loading…" };
    if (i.missing) return { icon: "ban", color: t.dim, label: "Not found" };
    if (i.state === "MERGED") return { icon: "merged", color: c.merged, label: "Merged", done: true };
    if (i.state === "CLOSED") return { icon: "ban", color: t.dim, label: "Closed", done: true };
    if (i.draft) return { icon: "pr-draft", color: t.dim, label: "Draft" };
    if (i.conflicts) return { icon: "conflict", color: c.bad, label: "Conflicts" };
    if (i.checks.fail) return { icon: "fail", color: c.bad, label: `${plural(i.checks.fail, "check")} failing` };
    if (i.decision === "CHANGES_REQUESTED") return { icon: "changes", color: c.bad, label: "Changes requested" };
    if (i.checks.running) return { icon: "spinner", spin: true, color: c.run, label: `CI ${i.checks.pass}/${i.checks.total}` };
    if (i.decision === "REVIEW_REQUIRED") return { icon: "waiting", color: c.warn, label: "Needs review" };
    if (i.unresolved) return { icon: "comment", color: c.warn, label: `Ready, ${plural(i.unresolved, "unresolved comment")}` };
    return { icon: "check", color: c.ok, label: "Ready to merge" };
  }

  status(s, t) {
    if (s === "blocked") return { color: t.blocked, label: "Needs you" };
    if (s === "done") return { color: t.done, label: "Done" };
    if (s === "working") return { color: t.working, label: "Working", spin: true };
    return { color: t.dim, label: "Idle" };
  }

  // ---- drawing ----

  icon(name, color, size = 13, spin = false) {
    const el = svg(ICON(name)).size(size).flex_none().text_color(color);
    return spin ? el.spin(900) : el;
  }

  dot(st, size = 7) {
    if (st.spin) return this.icon("spinner", st.color, size + 4, true);
    return div().w(size).h(size).flex_none().rounded(size).bg(st.color)
      .when(st.label === "Needs you", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
  }

  // A click inside a row that can be dragged (a session, a task's title): it stops there, so the
  // panel's mouse-up never sees the release, and the press the row took has to end here too, or
  // the next pointer move would start a drag.
  stopClick(cx) {
    cx.stop_propagation();
    this.press = null;
    this.taskPress = null;
    this.secPress = null;
  }

  iconButton(t, id, name, tip, onClick) {
    return div().id(id).p(3).rounded(5).flex_none().cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { this.stopClick(cx); onClick(cx); })
      .child(svg(ICON(name)).size(12));
  }

  // Esc cancels whatever it's adding (a task, a PR, …): keys reach this row from the focused input.
  inputRow(t, placeholderText) {
    return v_flex().px(8).py(4).gap(3)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.cancelAdding(cx); } })
      .child(Input.new(this.input).h(28).px(8).rounded(7).border_1().border_color(t.accent).bg(t.surface).text_size(12).text_color(t.foreground))
      .child(div().text_size(10.5).text_color(t.dim).child(placeholderText));
  }

  // A session, then the sub-agents its agents started with `hc run` (no pane of their own).
  // indent: where depth 0 starts (inside a task, under its title; in Setup, flush with the section).
  sessionRows(t, s, { tab, depth }, list, paned, indent = 28) {
    const row = this.sessionRow(t, s, tab, list, depth, indent);
    const mine = new Set(list.filter((a) => a.tab === tab.id).map((a) => a.address));
    const kids = terminals().filter((x) => x.parent && mine.has(x.parent) && x.state === "live" && !paned.has(x.address));
    const picker = this.switchingTab === tab.id ? [this.reopenPicker(t, s, tab, depth, indent)] : [];
    return [row, ...picker, ...kids.map((k) => this.subAgentRow(t, k, depth + 1, indent))];
  }

  subAgentRow(t, k, depth, indent = 28) {
    const st = this.status(k.status === "error" ? "blocked" : k.status === "done" ? "idle" : k.status, t);
    const name = k.name || (k.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || k.program?.name || k.address;
    return h_flex().id(`tk-sub-${k.address}`).pl(indent + 16 * Math.min(depth, 4)).pr(8).h(24).gap(7).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover)).tooltip("Sub-agent: click to peek")
      .on_click(() => run("terminal.peek", { terminal: k.address }))
      .child(div().text_size(11).text_color(t.dim).child("↳"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(name))
      .child(this.dot(st, 5));
  }

  sessionRow(t, s, tab, list, depth = 0, indent = 28) {
    const ag = list.filter((a) => a.tab === tab.id);
    const lead = ag[0];
    const st = this.status(tab.status, t);
    const live = (lead?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const name = tab.named || !live ? tab.name : live;
    const when = tab.status === "working" && tab.working_since ? ago(Date.now() - tab.working_since)
      : tab.changed_at ? ago(Date.now() - tab.changed_at) : "";
    const prog = lead?.program;
    const glyph = prog?.icon ? (prog.tint ? svg(prog.icon).size(13).flex_none().text_color(t.muted) : image(prog.icon).w(13).h(13).flex_none()) : div().w(13).flex_none();
    const target = { tab: tab.id, space: s.id };
    const dragged = this.dragging?.tab === tab.id;
    // Its Claude account, once there's more than one to tell apart.
    const acct = (shared(ACCOUNTS) ?? []).length > 1 && lead ? (shared(SESSION_ACCOUNTS) ?? {})[lead.address] ?? null : null;
    const hoverKey = `tab:${tab.id}`;
    // On screen already: shown beside the open tab, or the open tab itself while sessions are beside it.
    const beside = Boolean(lead) && pinned().has(lead.address);
    return h_flex().id(`tk-tab-${tab.id}`).pl(indent + 16 * Math.min(depth, 4)).pr(8).h(26).gap(7).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(this.canNest(target) ? t.accent : "#00000000").when(this.canNest(target), (el) => el.border_dashed())
      .when(dragged, (el) => el.opacity(0.45))
      .when(s.active && tab.active, (el) => el.bg(t.selected))
      .hover((x) => x.bg(t.hover))
      .on_hover((on, cx) => { this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered; cx.notify(); })
      .tooltip("Drag onto another session to nest it, onto the task's title to put it back at the top, or out of the panel to see it side by side")
      // A dragged session nests, moves to another task, or pastes its ID into another session.
      .on_mouse_down("left", (e) => { this.press = { tab: tab.id, space: s.id, name, addr: lead?.address, x: e.position.x, y: e.position.y }; })
      .on_mouse_up("left", (_e, cx) => { if (this.dragging) { cx.stop_propagation(); this.drop(target, cx); } })
      .on_click(() => {
        this.showWork();
        // Shown beside the tab already: go there rather than show it twice.
        if (beside) return run("pane.focus", { terminal: lead.address });
        run("space.select", { id: s.id }); run("tab.select", { id: tab.id }); if (lead) run("agent.focus", { terminal: lead.address });
      })
      .when(depth > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("↳")))
      .child(glyph)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(tab.status === "blocked" || depth === 0 ? t.foreground : t.muted).child(name))
      .when(ag.length > 1, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`×${ag.length}`)))
      .when(beside, (el) => el.child(div().id(`tk-beside-${tab.id}`).flex_none().px(5).h(16).flex().items_center().rounded(4)
        .bg(t.raised).text_size(10).text_color(t.muted).tooltip("Shown side by side in the main area").child("beside")))
      .when(Boolean(acct), (el) => el.child(this.accountChip(t, `tk-tabacct-${tab.id}`, acct)))
      .child(div().text_size(10.5).text_color(tab.status === "blocked" ? st.color : t.dim).child(tab.status === "blocked" ? `${st.label} ${when}` : when))
      .when(this.hovered === hoverKey && !this.dragging && Boolean(acct), (el) => el.child(this.iconButton(t, `tk-tabswitch-${tab.id}`, "user", "Reopen this conversation as another Claude account", (cx) => {
        this.switchingTab = this.switchingTab === tab.id ? null : tab.id;
        cx.notify();
      })))
      .when(this.restarting?.has(tab.id), (el) => el.child(svg(ICON("spinner")).size(12).flex_none().text_color(t.dim).spin(900)))
      .when(this.hovered === hoverKey && !this.dragging && Boolean(lead) && !this.restarting?.has(tab.id), (el) => el.child(this.iconButton(t, `tk-tabrestart-${tab.id}`, "refresh", "Restart Claude and resume this conversation (after reconnecting an MCP, say)", (cx) => this.restartSession(tab.id, cx))))
      .when(this.hovered === hoverKey && !this.dragging, (el) => el.child(this.iconButton(t, `tk-tabclose-${tab.id}`, "x", "Close this session", () => this.confirmCloseSession(tab.id, name))))
      // While another session is dragged over this one: drop here to paste its ID into this
      // session's prompt (the rest of the row nests it).
      .when(Boolean(this.dragging?.addr) && this.dragging.tab !== tab.id && Boolean(lead), (el) => el.child(
        div().id(`tk-paste-${tab.id}`).flex_none().px(6).h(18).flex().items_center().rounded(5)
          .bg(t.solid).text_color(t.solid_foreground).text_size(10.5).font_medium()
          .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.pasteId({ space: s.id, tab: tab.id, addr: lead.address }, cx); })
          .child(`Paste ${this.dragging.addr}`)))
      .child(this.dot(st, 6));
  }

  // Puts the dragged session's ID (its terminal address, which `hc send` and `hc read` take)
  // into another session's prompt, without pressing Enter, and gives that session the keyboard.
  // It goes through the clipboard: Herdr pastes only from there.
  pasteId(target, cx) {
    const id = this.dragging?.addr;
    this.dragging = null;
    this.press = null;
    if (!id) return cx.notify();
    cx.write_to_clipboard(id);
    run("space.select", { id: target.space });
    run("tab.select", { id: target.tab });
    run("pane.focus", { terminal: target.addr });
    cx.timer.after(150, (cx) => { run("terminal.paste", {}); cx.notify(); });
    cx.notify();
  }

  prRow(t, s, key, stack = null, indent = 28) {
    const i = this.info[key];
    const st = this.step(i, t);
    const { repo, number } = splitKey(key);
    const url = i?.url ?? this.prs()[s.id]?.[key];
    const hoverKey = `${s.id}:${key}`;
    // One line: kind, number, title; then open comments and the state, as icons whose tooltip says it.
    // A click opens its details below (nothing leaves the app); GitHub is one more click from there.
    const shown = this.prShown === hoverKey;
    const line = h_flex().id(`tk-pr-${s.id}-${key}`).pl(indent).pr(8).h(26).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .when(shown, (el) => el.bg(t.selected))
      .tooltip([i?.title ?? key, stack ? `Stack: ${stack.i} of ${stack.n}${stack.i === 1 ? " (bottom)" : stack.i === stack.n ? " (top)" : ""}` : null, i?.title ? st.label : null].filter(Boolean).join("\n"))
      .on_hover((on, cx) => { this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered; cx.notify(); })
      .on_click((_e, cx) => { this.prShown = shown ? null : hoverKey; cx.notify(); })
      .child(this.icon(i?.draft ? "pr-draft" : st.icon === "merged" ? "merged" : "pr", st.color, 13))
      .when(Boolean(stack), (el) => el.child(div().flex_none().px(4).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(`${stack.i}/${stack.n}`)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${repo === DEFAULT_REPO ? "" : repo}#${number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(st.done ? t.muted : t.foreground).child(i?.title ?? key))
      .when(this.hovered === hoverKey, (el) => el.child(this.iconButton(t, `tk-detach-${s.id}-${key}`, "x", "Remove from this task", () => this.detach(s.id, key))))
      .when(Boolean(i?.unresolved) && !st.done, (el) => el.child(this.resolveChip(t, s.id, key, url, i.unresolved)))
      .child(div().id(`tk-prstate-${s.id}-${key}`).flex_none().tooltip(st.label).child(this.icon(st.icon, st.color, 11, st.spin)));
    if (!shown) return line;
    return v_flex().gap(4).child(line)
      .child(v_flex().ml(indent).mr(8).mb(4).p(8).gap(6).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .child(div().text_size(12).text_color(t.foreground).child(i?.title ?? key))
        .child(h_flex().gap(4).items_center().text_size(11).text_color(st.color)
          .child(this.icon(st.icon, st.color, 11, st.spin)).child(div().child(st.label)))
        .child(div().flex().flex_row().flex_wrap().gap(5)
          .child(this.button(t, `tk-propen-${s.id}-${key}`, "external", "Open on GitHub", url ?? key, () => openInBrowser(url)))
          .child(this.button(t, `tk-prcopy-${s.id}-${key}`, "copy", "Copy link", "Copies the PR's URL", (cx) => {
            cx.write_to_clipboard(url);
            notify({ title: "Copied the PR's link", body: url, level: "info", timeout: 2500 });
          }))
          .when(Boolean(i) && !i.missing && !st.done, (el) => el.child(this.button(t, `tk-prreview-${s.id}-${key}`, "user", "Request review",
            "Request review from the teams that own its changes",
            (cx) => { if (this.review?.at === hoverKey) { this.review = null; cx.notify(); } else this.findOwners(hoverKey, key, cx); })))
          .child(this.button(t, `tk-prdetach-${s.id}-${key}`, "x", "Remove from task", "The PR stays on GitHub", () => { this.prShown = null; this.detach(s.id, key); })))
        .when(this.review?.at === hoverKey, (el) => el.child(this.reviewPicker(t))));
  }

  // ---- requesting review from the teams that own a PR's changes ----

  // Asks ./review-owners.cjs who owns the PR's changes (owners.yaml and CODEOWNERS, as the
  // posthog repo's reviewer bot reads them), then lists them under the PR's details to pick from.
  findOwners(at, key, cx) {
    const { owner, repo, number } = splitKey(key);
    this.review = { at, key, loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try {
        const out = await exec("node", [`${appHome()}/mods/tasks/review-owners.cjs`, `${owner}/${repo}`, String(number)], { timeout: 120000 });
        r = out.stdout.trim() ? JSON.parse(out.stdout) : { error: out.stderr.trim().split("\n").pop() || `review-owners exited ${out.code}` };
      } catch (e) {
        r = { error: String(e?.message ?? e) };
      }
      if (this.review?.at !== at) return;
      if (r.error) { this.review = { at, key, error: r.error }; return cx.notify(); }
      const owners = [...r.owners];
      const myTeam = (await loadPrivate()).github?.team; // "org/team", offered when no owner covers it
      if (myTeam && !owners.some((o) => o.reviewer.toLowerCase() === myTeam.toLowerCase())) {
        owners.push({ reviewer: myTeam, team: true, why: owners.length ? "your team" : "your team; no owner file covers these changes", picked: owners.length === 0 });
      }
      const requested = new Set(r.requested.map((x) => x.toLowerCase()));
      const chosen = new Set(owners.filter((o) => o.picked && !requested.has(o.reviewer.toLowerCase())).map((o) => o.reviewer));
      this.review = { at, key, owners, requested, chosen };
      cx.notify();
    });
  }

  // GitHub's REST endpoint, not `gh pr edit --add-reviewer`, which some gh versions fail on
  // (projects classic) after the request has been made.
  requestReview(cx) {
    const rv = this.review;
    if (!rv?.chosen?.size || rv.sending) return;
    const { owner, repo, number } = splitKey(rv.key);
    const who = rv.owners.filter((o) => rv.chosen.has(o.reviewer));
    const fields = who.flatMap((o) => ["-f", o.team ? `team_reviewers[]=${o.reviewer.split("/").pop()}` : `reviewers[]=${o.reviewer}`]);
    rv.sending = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, ...fields], { timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `gh exited ${r.code}`);
        notify({ title: "Review requested", body: `${repo}#${number}: ${who.map((o) => shortReviewer(o.reviewer)).join(", ")}`, level: "info", timeout: 4000 });
        if (this.review === rv) this.review = null;
        this.refresh(cx);
      } catch (e) {
        rv.sending = false;
        notify({ title: "Couldn't request the review", body: String(e?.message ?? e), level: "error", timeout: 8000 });
      }
      cx.notify();
    });
  }

  reviewPicker(t) {
    const rv = this.review;
    const box = v_flex().gap(3).pt(6).border_t_1().border_color(t.border); // inside the PR's details
    if (rv.loading) {
      return box.child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(this.icon("spinner", t.dim, 11, true)).child("Finding the teams that own these changes…"));
    }
    if (rv.error) return box.child(div().text_size(11).text_color(t.ansi1).child(`Couldn't find the owners: ${rv.error}`));
    const toggle = (o, cx) => { rv.chosen.has(o.reviewer) ? rv.chosen.delete(o.reviewer) : rv.chosen.add(o.reviewer); cx.notify(); };
    return box
      .child(div().text_size(11).text_color(t.muted).child("Request review from"))
      .children(rv.owners.map((o) => {
        const done = rv.requested.has(o.reviewer.toLowerCase());
        const on = done || rv.chosen.has(o.reviewer);
        return h_flex().id(`tk-rv-${o.reviewer}`).h(22).px(4).gap(6).items_center().rounded(5)
          .when(!done && !rv.sending, (el) => el.cursor_pointer().hover((x) => x.bg(t.hover))
            .on_click((_e, cx) => { this.stopClick(cx); toggle(o, cx); }))
          .child(this.icon(on ? "circle-check" : "square", on && !done ? t.accent : t.dim, 12))
          .child(div().flex_none().text_size(11.5).text_color(done ? t.muted : t.foreground).child(shortReviewer(o.reviewer)))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(done ? "already requested" : o.why));
      }))
      .child(h_flex().gap(5).pt(3)
        .child(rv.chosen.size
          ? this.button(t, "tk-rv-send", "user", rv.sending ? "Requesting…" : `Request ${plural(rv.chosen.size, "reviewer")}`,
            rv.owners.filter((o) => rv.chosen.has(o.reviewer)).map((o) => o.reviewer).join(", "), (cx) => this.requestReview(cx))
          : div().text_size(10.5).text_color(t.dim).child("Pick who to ask"))
        .child(this.button(t, "tk-rv-cancel", "x", "Cancel", "Close this list", (cx) => { this.review = null; cx.notify(); })));
  }

  // The resolve button, small enough for the PR's line: the comment count, or ↗ to the session already on them.
  resolveChip(t, spaceId, key, url, unresolved) {
    const open = findCommentsTab(key);
    return h_flex().id(`tk-resolve-${spaceId}-${key}`).flex_none().h(18).px(5).gap(3).items_center().rounded(5)
      .border_1().border_color(t.input).bg(t.raised).text_size(10.5).text_color(t.foreground).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .tooltip(open ? "Go to the comments session" : `Resolve ${plural(unresolved, "comment")} in a new Claude session`)
      .on_click((_e, cx) => {
        this.stopClick(cx);
        if (open) { run("space.select", { id: open.space }); run("tab.select", { id: open.tab }); }
        else run("tab.new", { space: spaceId, name: commentsTab(key), argv: claudeArgv(), task: resolvePrompt(url) });
      })
      .child(this.icon(open ? "external" : "comment", t.foreground, 10))
      .when(!open, (el) => el.child(String(unresolved)));
  }

  button(t, id, iconName, label, tip, onClick) {
    return h_flex().id(id).h(22).px(7).gap(5).items_center().rounded(6).border_1().border_color(t.input).bg(t.raised)
      .text_size(11).text_color(t.foreground).cursor_pointer().hover((x) => x.bg(t.hover))
      .tooltip(tip)
      .on_click((_e, cx) => { this.stopClick(cx); onClick(cx); })
      .child(this.icon(iconName, t.foreground, 12))
      .child(label);
  }

  cleanButton(t, s) {
    if (this.cleaning?.has(s.id)) return div().flex_none().text_size(10.5).text_color(t.muted).child("cleaning…");
    const n = this.worktreesOf(s).length;
    return div().id(`tk-clean-${s.id}`).flex_none().px(6).h(20).flex().items_center().rounded(5).border_1().border_color(t.input).bg(t.raised)
      .text_size(10.5).text_color(t.foreground).cursor_pointer().hover((x) => x.bg(t.hover))
      .tooltip(`Every PR is merged. Archives this task, removes its ${plural(n, "worktree")} and deletes the PRs' local branches. A worktree with uncommitted changes stays.`)
      .on_click((_e, cx) => { this.stopClick(cx); this.cleanTask(s, cx); })
      .child("Clean up");
  }

  task(t, s, list, index) {
    const td = this.taskDragging;
    // Being dragged: its place in the list is a placeholder; the task itself follows the pointer.
    if (td?.id === s.id) return [div().h(32).rounded(7).border_1().border_dashed().border_color(t.accent).bg(t.hover)];
    const open = !td && !this.folded.has(s.id);
    const order = stackOrder(Object.keys(this.prs()[s.id] ?? {}), this.info);
    const keys = order.map((o) => o.key);
    const st = this.status(s.status, t);
    const steps = keys.map((k) => this.step(this.info[k], t));
    const allDone = keys.length > 0 && steps.every((x) => x.done);
    const allMerged = keys.length > 0 && keys.every((k) => this.info[k]?.state === "MERGED");
    const hoverKey = `task:${s.id}`;
    const d = this.dragging;
    // A task's title takes a dragged session: another task's (moves it here) or a nested one of its own.
    const takes = Boolean(d) && (d.space !== s.id || Boolean((shared(PARENTS) ?? {})[d.tab]));
    // Tasks reorder by dragging a title (Herdr's space order, on that machine). While one is
    // dragged every task shows as its title only, so all rows are one height and the placeholder
    // can take the place of whichever the pointer is over without the list jumping back.
    const swaps = Boolean(td) && (td.machine ?? null) === (s.machine ?? null);
    const header = h_flex().id(`tk-task-${s.id}`).px(8).h(32).gap(7).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(takes ? t.accent : "#00000000").when(takes, (el) => el.border_dashed())
      .on_mouse_down("left", (e) => { if (this.sortMode() === "manual") this.taskPress = { id: s.id, machine: s.machine, name: s.name, x: e.position.x, y: e.position.y }; })
      .when(swaps, (el) => el.on_mouse_move((_e, cx) => { if (this.taskTarget !== index) { this.taskTarget = index; cx.notify(); } }))
      .on_mouse_up("left", (_e, cx) => { if (this.dragging) { cx.stop_propagation(); this.drop({ space: s.id }, cx); } })
      .when(s.active, (el) => el.bg(t.selected))
      .hover((x) => x.bg(t.hover))
      .on_hover((on, cx) => { this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered; cx.notify(); })
      .on_click((_e, cx) => {
        if (this.taskDragged) { this.taskDragged = false; return; } // the press was a drag
        this.fold(s.id, cx); // a click opens or closes the task, as its chevron does
        this.showWork();
        run("space.select", { id: s.id });
      })
      .child(div().id(`tk-fold-${s.id}`).on_click((_e, cx) => { this.stopClick(cx); this.fold(s.id, cx); })
        .child(this.icon(open ? "chevron-down" : "chevron-right", t.dim, 12)))
      .child(this.renamingTask === s.id
        ? div().flex_1().min_w(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.stopClick(cx))
            .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.finishRename(cx, false); } })
            .child(Input.new(this.renameInput).h(24).px(6).rounded(6).border_1().border_color(t.accent).bg(t.surface).text_size(13).text_color(t.foreground))
        : div().id(`tk-title-${s.id}`).flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(allDone ? t.muted : t.foreground)
            .tooltip("Double-click to rename")
            .on_mouse_down("left", (e, cx) => { if (e.click_count === 2) { cx.stop_propagation(); this.taskPress = null; this.startRename(s, cx); } })
            .child(s.name))
      .when(Boolean(s.machine), (el) => el.child(this.machineBadge(t, s)))
      .when(Boolean(this.hogliHere(s)), (el) => el.child(div().id(`tk-hogli-${s.id}`).flex_none().tooltip(`hogli is running here (${this.hogliHere(s).branch})`)
        .child(this.icon("hogli", t.ansi2, 12))))
      .when(this.hovered === hoverKey, (el) => el
        .when(Boolean(s.machine), (el) => el.child(this.iconButton(t, `tk-shell-${s.id}`, "terminal", `Shell on ${s.machine}`, () => this.devboxShell(s))))
        .when(Boolean(s.machine) && !this.sending, (el) => el.child(this.iconButton(t, `tk-tomac-${s.id}`, "laptop",
          "Bring to this Mac: pushes its branch there and checks it out here, moves its Claude conversations and resumes them, archives the devbox task", (cx) => this.bringHome(s, cx))))
        .child(this.iconButton(t, `tk-rename-${s.id}`, "pen", "Rename this task", (cx) => this.startRename(s, cx)))
        .when(DEVBOXES_ON && !s.machine && (shared(DEVBOXES) ?? []).length > 0, (el) => el.child(this.iconButton(t, `tk-tosend-${s.id}`, "cloud", "Send to a devbox", (cx) => {
          this.sendingPick = this.sendingPick === s.id ? null : s.id;
          if (this.folded.has(s.id)) this.fold(s.id, cx);
          cx.notify();
        })))
        .child(this.iconButton(t, `tk-archive-${s.id}`, "archive", "Archive this task: its sessions stop, and Restore resumes them (Archived, at the bottom)", (cx) => this.archiveTask(s, cx))))
      .when(allMerged, (el) => el.child(this.cleanButton(t, s)))
      .child(allDone ? this.icon("check", t.ansi2, 12) : this.dot(st));
    const sending = this.sending?.id === s.id
      ? h_flex().mx(8).mb(4).px(8).h(26).gap(6).items_center().rounded(6).bg(t.raised)
        .child(this.icon("spinner", t.working, 12, true)).child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(`${this.sending.phase}…`))
      : null;
    if (!open) return sending ? [v_flex().child(header).child(sending)] : [header];
    const paned = new Set(panes().map((p) => p.terminal).filter(Boolean));
    const sessions = this.sessions(s);
    // An open task is three lists, each under its own heading with its count and its +. A click on
    // a heading folds its list (kept per task); + opens it again.
    const sessOpen = this.subOpen(s.id, "sessions"), prsOpen = this.subOpen(s.id, "prs") || this.adding === s.id;
    const wtsOpen = this.subOpen(s.id, "wts") || this.pickingWt === s.id;
    // Folded, Sessions still shows when one of them needs you.
    const urgent = sessOpen ? null : sessions.map((x) => x.tab.status).sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
    const rows = [header,
      ...(sending ? [sending] : []),
      ...(this.sendingPick === s.id && !this.sending ? [this.sendPicker(t, s)] : []),
      this.subheading(t, `tk-sub-sessions-${s.id}`, "Sessions", sessions.length, "New Claude session in this task",
        () => { this.setSubOpen(s.id, "sessions", true); run("tab.new", { space: s.id, argv: s.machine ? ["claude"] : claudeArgv() }); },
        { open: sessOpen, onToggle: (cx) => { this.setSubOpen(s.id, "sessions", !sessOpen); cx.notify(); },
          badge: urgent === "blocked" || urgent === "done" ? this.dot(this.status(urgent, t), 6) : null })];
    if (sessOpen) rows.push(...sessions.flatMap((x) => this.sessionRows(t, s, x, list, paned)));
    if (sessOpen && !sessions.length) rows.push(div().pl(28).h(20).text_size(11).text_color(t.dim).child("None yet"));
    // PRs and worktrees are rarely needed (the user's call, 2026-11-13): one quiet line with their
    // counts until asked for; a click shows both lists (kept per task).
    const wts = this.worktreesOf(s);
    const extras = this.extrasOpen(s.id) || this.adding === s.id || this.pickingWt === s.id;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    rows.push(h_flex().id(`tk-extras-${s.id}`).pl(14).pr(8).pt(6).h(24).gap(6).items_center().cursor_pointer()
      .text_color(t.dim).hover((x) => x.text_color(t.foreground))
      .tooltip(extras ? "Hide this task's pull requests and worktrees" : "Show this task's pull requests and worktrees")
      .on_click((_e, cx) => { this.stopClick(cx); this.setExtrasOpen(s.id, !extras); cx.notify(); })
      .child(svg(ICON(extras ? "chevron-down" : "chevron-right")).size(9).flex_none().text_color(t.dim))
      .child(div().text_size(10.5).child(extras ? "Hide pull requests and worktrees"
        : `${plural(keys.length, "PR", "PRs")} · ${plural(wts.length, "worktree", "worktrees")}`)));
    if (!extras) return [v_flex().pb(6).rounded(9).border_1().border_color(t.border).bg(t.surface).children(rows)];
    // Merged PRs come off the task in one click (they stay hidden, so the hook can't bring them back).
    const merged = keys.filter((k) => this.info[k]?.state === "MERGED");
    rows.push(this.subheading(t, `tk-sub-prs-${s.id}`, "Pull requests", keys.length, "Attach a PR to this task",
      (cx) => { this.setSubOpen(s.id, "prs", true); this.startAdding(s.id, cx); },
      { open: prsOpen, onToggle: (cx) => { this.setSubOpen(s.id, "prs", !prsOpen); cx.notify(); },
        extra: merged.length ? this.iconButton(t, `tk-clearmerged-${s.id}`, "merged",
          `Remove ${merged.length === 1 ? "the merged PR" : `the ${merged.length} merged PRs`} from this task (they stay on GitHub)`,
          () => { if (merged.some((k) => this.prShown === `${s.id}:${k}`)) this.prShown = null; this.detach(s.id, ...merged); }) : null }));
    // A stack's PRs sit together, bottom first, on a line of their own with their place (1/2…).
    for (let j = 0; prsOpen && j < order.length;) {
      const { key, stack } = order[j];
      if (!stack) { rows.push(this.prRow(t, s, key)); j++; continue; }
      const members = order.slice(j, j + stack.n);
      rows.push(v_flex().ml(21).border_l_1().border_color(t.border)
        .child(h_flex().pl(6).h(18).gap(5).items_center()
          .child(this.icon("stack", t.dim, 10))
          .child(div().text_size(10).text_color(t.dim).child(`Stack of ${stack.n}, bottom first`)))
        .children(members.map((m) => this.prRow(t, s, m.key, m.stack, 6))));
      j += stack.n;
    }
    if (prsOpen && !keys.length && this.adding !== s.id) rows.push(div().pl(28).h(20).text_size(11).text_color(t.dim).child("None yet"));
    if (this.adding === s.id) rows.push(this.inputRow(t, "PR URL, owner/repo#123 or #123. Enter attaches it; Esc cancels."));
    rows.push(this.subheading(t, `tk-sub-wts-${s.id}`, "Worktrees", wts.length, "Attach a worktree to this task", (cx) => {
      this.setSubOpen(s.id, "wts", true);
      this.pickingWt = this.pickingWt === s.id ? null : s.id;
      if (this.pickingWt) this.scanWorktrees(cx, true);
      cx.notify();
    }, { open: wtsOpen, onToggle: (cx) => { this.setSubOpen(s.id, "wts", !wtsOpen); cx.notify(); } }));
    if (wtsOpen) rows.push(...wts.map((w) => this.worktreeRow(t, s, w)));
    if (wtsOpen && !wts.length && this.pickingWt !== s.id) rows.push(div().pl(28).h(20).text_size(11).text_color(t.dim).child("None yet"));
    if (this.pickingWt === s.id) rows.push(this.worktreePicker(t, s, wts));
    // An open task is a card, so where one ends and the next starts is plain.
    return [v_flex().pb(6).rounded(9).border_1().border_color(t.border).bg(t.surface).children(rows)];
  }

  // Whether a list inside a task (sessions, prs, wts) is open: localStorage `sub:<space>:<list>`, open by default.
  extrasOpen(spaceId) { return localStorage.getItem(`extras:${spaceId}`) === "1"; }
  setExtrasOpen(spaceId, open) {
    if (open) localStorage.setItem(`extras:${spaceId}`, "1");
    else localStorage.removeItem(`extras:${spaceId}`);
  }
  subOpen(spaceId, list) { return localStorage.getItem(`sub:${spaceId}:${list}`) !== "0"; }
  setSubOpen(spaceId, list, open) {
    if (open) localStorage.removeItem(`sub:${spaceId}:${list}`);
    else localStorage.setItem(`sub:${spaceId}:${list}`, "0");
  }

  // A list's heading inside an open task: a chevron, small caps, its count, and + on the right.
  // With onToggle, a click on it folds and opens the list.
  subheading(t, id, title, count, tip, onAdd, { open = true, onToggle = null, badge = null, extra = null } = {}) {
    return h_flex().id(id).pl(onToggle ? 14 : 28).pr(8).pt(6).h(24).gap(6).items_center()
      .when(Boolean(onToggle), (el) => el.cursor_pointer().text_color(t.dim).hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => { this.stopClick(cx); onToggle(cx); })
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(9).flex_none().text_color(t.dim)))
      .child(div().text_size(10).font_semibold().text_color(t.dim).child(title.toUpperCase()))
      .child(div().text_size(10).text_color(t.dim).child(String(count)))
      .when(Boolean(badge), (el) => el.child(badge))
      .child(div().flex_1().h(1).bg(t.border))
      .when(Boolean(extra), (el) => el.child(extra))
      .child(this.iconButton(t, `${id}-add`, "plus", tip, onAdd));
  }

  link(t, id, label, onClick) {
    return div().id(id).text_size(11).text_color(t.dim).cursor_pointer().hover((x) => x.text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  // Narrow sidebar: one initial per task with its status.
  rail(t, list) {
    return v_flex().size_full().bg(t.chrome).items_center().pt(10).gap(8)
      .children(list.map((s) => v_flex().id(`tk-rail-${s.id}`).items_center().gap(3).cursor_pointer()
        .tooltip(s.name).on_click(() => run("space.select", { id: s.id }))
        .child(div().w(26).h(26).rounded(7).flex().items_center().justify_center().bg(s.active ? t.selected : t.raised)
          .text_size(12).font_medium().text_color(t.foreground).child((s.name[0] ?? "?").toUpperCase()))
        .child(this.dot(this.status(s.status, t), 5))));
  }

  render(cx) {
    const t = theme();
    const ag = agents();
    const list = this.withAsks(spaces(), ag);
    // The Devboxes space is reached through the Devboxes section only: it's neither a task nor setup.
    const devSpace = this.devboxSpace();
    if (this.part === "tasks" && devSpace && shared(DEVBOX_SPACE) !== devSpace.id) setShared(DEVBOX_SPACE, devSpace.id);
    // So is the Sessions space: its sessions list under Sessions, below the tasks.
    const loose = this.looseSpace();
    if (this.part === "tasks" && loose && shared(LOOSE_SPACE) !== loose.id) setShared(LOOSE_SPACE, loose.id);
    const setupIds = new Set([...(shared(SETUP) ?? []), ...(devSpace ? [devSpace.id] : []), ...(loose ? [loose.id] : [])]);
    const setup = list.filter((s) => setupIds.has(s.id) && s.id !== devSpace?.id && s.id !== loose?.id);
    if (this.part === "setup") return this.setupBlock(t, setup, ag);
    if (this.part === "inbox") return this.inbox(t, list.filter((s) => !setupIds.has(s.id)), ag);
    if (this.part === "drop") return this.dropView(t, ag);
    if (this.part === "new-task") return this.newTaskDialog(t);
    if (this.part === "top") return this.topBlock(t, list.filter((s) => !setupIds.has(s.id)));
    if (this.part === "todos") return this.todosBlock(t);
    if (this.part === "worktrees") return this.worktreesBlock(t, list.filter((s) => !setupIds.has(s.id)), cx);
    if (this.part === "support") return this.supportBlock(t);
    this.sync();
    const sig = this.keys().join(" ");
    if (sig !== this.fetchedSig) this.refresh(cx);
    // The Setup block shows only while some space is in it. This copy is always drawn, so it decides.
    this.scanWorktrees(cx);
    // A "no sessions" tab steps aside once its task has a session again.
    for (const p of panes().filter((x) => x.mod === "task-empty")) {
      const s = list.find((x) => x.tabs.some((tab) => tab.id === p.tab));
      if (s && s.tabs.length > 1 && !this.closingEmpty?.has(p.tab)) {
        (this.closingEmpty ??= new Set()).add(p.tab);
        run("tab.close", { id: p.tab, confirmed: true });
      }
    }
    // The bottom block (devboxes, setup) shows while it has something to list.
    const bottom = setup.length > 0 || ((DEVBOXES_ON || DEVBOX_LIST) && (shared(DEVBOXES) ?? []).length > 0) || (shared(ARCHIVE) ?? []).length > 0;
    const setupNode = findNode(layout(), "setup");
    if (setupNode && Boolean(setupNode.hidden) === bottom) run(bottom ? "layout.show" : "layout.hide", { id: "setup" });
    // agent.next / agent.prev follow this list: task by task, in the order shown.
    setAgentOrder(list.flatMap((s) => this.sessions(s).flatMap(({ tab }) => ag.filter((a) => a.tab === tab.id).map((a) => a.address))));
    const root = (el) => el.id("tk-root").on_size_change((size, cx) => {
      if (Math.abs(size.width - this.width) < 1) return;
      this.width = size.width;
      cx.notify();
    })
      // One handler per event for the three drags here (a section, a task's title, a session): an
      // element keeps one listener per event, so chained ones would replace each other.
      // A press becomes a drag once the pointer moves a few px.
      .on_mouse_move((e, cx) => {
        const far = (p) => Math.hypot(e.position.x - p.x, e.position.y - p.y) >= DRAG_PX;
        const sp = this.secPress;
        if (sp && !this.sectionDrag() && far(sp)) {
          this.secDragged = true;
          setShared(SECTION_DRAG, { block: this.block(), at: Date.now() });
          cx.notify();
          return;
        }
        if (this.taskDragging) { this.dragY = e.local_position.y; cx.notify(); return; }
        const tp = this.taskPress;
        if (tp && far(tp)) {
          this.taskDragging = tp;
          this.taskDragged = true;
          this.taskTarget = null;
          this.dragY = e.local_position.y;
          cx.notify();
          return;
        }
        const p = this.press;
        if (p && !this.dragging && far(p)) {
          this.dragging = p;
          cx.notify();
        }
        if (this.dragging) { this.dragPos = e.local_position; cx.notify(); }
      })
      // Released anywhere that isn't a target, or the pointer left: no drag.
      .on_mouse_up("left", (_e, cx) => {
        if (this.taskDragging) this.dropTask();
        const was = this.dragging || this.taskDragging || this.sectionDrag();
        if (this.sectionDrag()) setShared(SECTION_DRAG, null);
        this.secPress = null;
        this.press = null; this.dragging = null; this.taskPress = null; this.taskDragging = null;
        // A drag released anywhere isn't a click on the title it started from; the click, if any,
        // comes with this release, so the flag only has to outlive it.
        if (this.taskDragged) cx.timer.after(100, () => { this.taskDragged = false; });
        if (was) cx.notify();
      })
      // Dragged out of the panel (toward the sessions): the main area turns into the drop view
      // (part "drop"), which shows where it can go beside what's shown, or copies its ID.
      .on_hover((on, cx) => {
        // A task dragged out of the panel goes back where it was.
        if (!on && this.taskDragging) { this.taskDragging = null; this.taskPress = null; this.taskTarget = null; cx.notify(); }
        if (on || !(this.press || this.dragging)) return;
        const d = this.dragging;
        this.press = null;
        this.dragging = null;
        const addr = d && (d.addr ?? panes().find((p) => p.tab === d.tab && p.terminal)?.terminal);
        if (addr) {
          setShared(SIDE_DRAG, { addr, name: d.name, tab: d.tab, space: d.space, at: Date.now() });
          this.showView("drop");
        }
        cx.notify();
      });
    if (this.width < 160) return root(this.rail(t, list));
    const tasks = list.filter((s) => !setupIds.has(s.id));
    // Only tasks: a Setup or Sessions space waiting on you shows in its own section, not in this badge.
    const needs = tasks.filter((s) => s.status === "blocked").length;
    this.trackTimes(tasks, cx);
    const reveal = shared(REVEAL);
    if (reveal) {
      if (Date.now() - reveal.at < 10000) {
        if (this.folded.has(reveal.space)) this.fold(reveal.space, cx);
        if (!this.isOpen("tasks")) localStorage.setItem("open:tasks", "1");
      }
      setShared(REVEAL, null);
    }
    const shown = this.orderedTasks(tasks);
    this.shownTasks = shown;
    return root(v_flex().relative().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(this.sectionHeader(t, "tasks", "Tasks", { count: tasks.length,
        badge: needs > 0 ? div().px(5).rounded(8).bg(t.blocked).text_size(10).text_color(t.background).child(String(needs)) : null,
        actions: this.sortButton(t) }))
      .when(Boolean(this.error), (el) => el.child(div().px(16).py(2).text_size(11).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.dragging), (el) => el.child(div().px(16).py(2).text_size(11).text_color(t.accent)
        .child(`Moving “${this.dragging.name}”: drop on Paste to put its ID in that session, on a session to nest it, on a task's title to move it there, or drag it out of the panel to see it beside the open session.`)))
      .child(v_flex().id("tk-list").flex_1().min_h(0).px(8).pb(8).gap(4).overflow_y_scrollbar()
        .when(this.isOpen("tasks"), (el) => el.children(shown.flatMap((s, i) => this.task(t, s, ag, i))))
        .when(!tasks.length && this.isOpen("tasks"), (el) => el.child(div().px(16).py(6).text_size(12).text_color(t.dim).child("No tasks. New task starts one."))))
      .when(Boolean(loose && this.sessions(loose).length), (el) => el.child(this.looseSection(t, loose, ag)))
      .when(Boolean(this.taskDragging), (el) => el.child(this.taskGhost(t)))
      .when(Boolean(this.dragging && this.dragPos), (el) => el.child(this.dragGhost(t, this.dragging.name, this.dragPos))));
  }

  // ---- loose sessions: Claude tied to no task ----

  looseSpace() {
    const id = shared(LOOSE_SPACE);
    return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.named && s.name === LOOSE_SPACE_NAME && !s.machine) ?? null;
  }

  // A clean Claude session in your home folder, in the Sessions space (made on first use).
  newLooseSession() {
    const sp = this.looseSpace();
    this.showWork();
    if (sp) {
      run("tab.new", { space: sp.id, folder: home(), argv: claudeArgv() });
      run("space.select", { id: sp.id });
    } else {
      run("space.new", { name: LOOSE_SPACE_NAME, folder: home(), argv: claudeArgv() });
    }
  }

  // Under the tasks, in this same block so a session can be dragged onto a task's title.
  looseSection(t, sp, ag) {
    const paned = new Set(panes().map((p) => p.terminal).filter(Boolean));
    const sessions = this.sessions(sp);
    const open = this.isOpen("loose");
    return v_flex().flex_none()
      .child(this.sectionHeader(t, "loose", "Sessions", { count: sessions.length,
        actions: this.iconButton(t, "tk-loose-new", "plus", "New Claude session, tied to no task", () => this.newLooseSession()) }))
      .when(open, (el) => el.child(this.sectionCard(t)
        .child(v_flex().id("tk-loose-list").gap(2).max_h(8 * 28).overflow_y_scrollbar()
          .children(sessions.flatMap((x) => this.sessionRows(t, sp, x, ag, paned, 8))))
        .child(div().px(8).pt(2).pb(2).text_size(10.5).text_color(t.dim).child("Drag one onto a task's title to move it there."))));
  }

  // ---- reordering tasks ----

  // The tasks in the order to draw: Herdr's, or the one just dropped while Herdr catches up,
  // with the dragged task moved to where the pointer is (taskTarget, an index in this list).
  sortMode() { return localStorage.getItem("taskSort") ?? "manual"; }

  // Keeps each task's created and updated times (see TIMES). Tasks from before this ran are dated
  // from their terminals (hc get: created_ms, status_ms), once.
  trackTimes(tasks, cx) {
    const times = shared(TIMES) ?? {};
    let next = null;
    const edit = () => (next ??= JSON.parse(JSON.stringify(times)));
    const unknown = [];
    for (const s of tasks) {
      const live = Math.max(0, ...s.tabs.map((tab) => Math.max(tab.changed_at ?? 0, tab.working_since ?? 0)));
      const had = times[s.id];
      if (!had) { if (this.timesReady) (edit()[s.id] = { created: Date.now(), updated: Math.max(live, Date.now()) }); else unknown.push(s); continue; }
      if (live > (had.updated ?? 0) + 5000) edit()[s.id] = { ...had, updated: live };
    }
    const live = new Set(spaces().map((s) => s.id));
    if (machines().find((m) => m.name === null)?.layout === "ready") for (const id of Object.keys(times)) if (!live.has(id)) delete edit()[id];
    if (next) setShared(TIMES, next);
    if (this.timesReady || this.datingTasks) return;
    // The first pass: date the tasks the panel finds already there.
    this.datingTasks = true;
    cx.spawn(async (cx) => {
      const found = {};
      for (const s of unknown) {
        const addrs = panes().filter((p) => p.terminal && s.tabs.some((tab) => tab.id === p.tab)).map((p) => p.terminal);
        let created = Infinity, updated = 0;
        for (const a of addrs) {
          const r = await exec("hc", ["get", a, "--json"]).catch(() => null);
          const info = r?.code === 0 ? JSON.parse(r.stdout) : null;
          if (info?.created_ms) created = Math.min(created, info.created_ms);
          if (info?.status_ms) updated = Math.max(updated, info.status_ms);
        }
        if (created === Infinity) created = Date.now();
        found[s.id] = { created, updated: Math.max(updated, created) };
      }
      setShared(TIMES, { ...(shared(TIMES) ?? {}), ...found });
      this.timesReady = true;
      this.datingTasks = false;
      cx.notify();
    });
  }

  sortButton(t) {
    const mode = SORTS.find((x) => x.id === this.sortMode()) ?? SORTS[0];
    return div().id("tk-sort").px(5).h(18).flex().items_center().rounded(4).cursor_pointer()
      .text_size(10.5).text_color(t.dim).hover((x) => x.bg(t.raised).text_color(t.foreground))
      .tooltip(`Sorted: ${mode.tip}. Click for ${SORTS[(SORTS.indexOf(mode) + 1) % SORTS.length].label.toLowerCase()}.`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        localStorage.setItem("taskSort", SORTS[(SORTS.indexOf(mode) + 1) % SORTS.length].id);
        cx.notify();
      })
      .child(`↕ ${mode.label}`);
  }

  orderedTasks(tasks) {
    const mode = this.sortMode();
    if (mode !== "manual") {
      const times = shared(TIMES) ?? {};
      const key = (s) => times[s.id]?.[mode] ?? 0;
      return [...tasks].sort((a, b) => key(b) - key(a));
    }
    let ids = tasks.map((s) => s.id);
    const pending = this.pendingOrder;
    if (pending) {
      const same = pending.ids.length === ids.length && pending.ids.every((id) => ids.includes(id));
      if (!same || pending.ids.join() === ids.join() || Date.now() - pending.at > 3000) this.pendingOrder = null;
      else ids = pending.ids;
    }
    const td = this.taskDragging;
    if (td && this.taskTarget != null && ids.includes(td.id)) {
      ids = ids.filter((id) => id !== td.id);
      ids.splice(this.taskTarget, 0, td.id);
    }
    const byId = new Map(tasks.map((s) => [s.id, s]));
    return ids.map((id) => byId.get(id));
  }

  // Dropped: Herdr's order becomes the one shown. space.move takes a place among the machine's
  // spaces (setup ones included), so it's computed from the task that now follows, or precedes.
  dropTask() {
    const td = this.taskDragging;
    const shown = this.shownTasks ?? [];
    const at = shown.findIndex((s) => s.id === td.id);
    if (this.taskTarget == null || at < 0) return;
    const machine = td.machine ?? null;
    const others = spaces().filter((x) => (x.machine ?? null) === machine && x.id !== td.id).map((x) => x.id);
    const after = shown.slice(at + 1).find((s) => (s.machine ?? null) === machine);
    const before = shown.slice(0, at).reverse().find((s) => (s.machine ?? null) === machine);
    const index = after ? others.indexOf(after.id) + 1 : before ? others.indexOf(before.id) + 2 : null;
    if (!index) return;
    this.pendingOrder = { ids: shown.map((s) => s.id), at: Date.now() };
    run("space.move", { id: td.id, index });
  }

  // The dragged task, under the pointer. It has no handlers, so the titles under it still see the pointer.
  taskGhost(t) {
    const td = this.taskDragging;
    return div().absolute().left(8).right(8).top(Math.max(0, (this.dragY ?? 0) - 16)).h(32).px(8)
      .flex().flex_row().items_center().gap(7).rounded(7).bg(t.surface).border_1().border_color(t.accent).shadow_lg()
      .child(this.icon("chevron-right", t.dim, 12))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(t.foreground).child(td.name));
  }

  // A block whose height is its content's: the content reports its size, the block follows.
  fitBlock(id, el) {
    return el.on_size_change((size, cx) => {
      const px = Math.ceil(size.height);
      if (Math.abs(px - (this.fitPx ?? 0)) < 1) return;
      this.fitPx = px;
      run("layout.resize", { id, px });
    });
  }

  // The top of the sidebar, which stays put: New task (and where it runs), the Work / Inbox /
  // Merge switch, New todo.
  topBlock(t, tasks) {
    return div().size_full().bg(t.chrome).child(this.fitBlock("top", v_flex().id("tk-top").w_full().flex_none().pb(6).text_size(13)
      // The way in: a full-width primary button, first thing in the sidebar.
      .child(h_flex().id("tk-newtask").mx(12).mt(10).h(36).flex_none().gap(8).items_center().justify_center().rounded(9)
        .bg(t.solid).border_1().border_color(t.solid)
        .text_color(t.solid_foreground).text_size(13).font_semibold().cursor_pointer()
        .hover((x) => x.opacity(0.88))
        .tooltip("Creates a task with a Claude session")
        .on_click(() => this.openNewTask())
        .child(svg(ICON("plus")).size(15).flex_none())
        .child(div().child("New task")))
      // A Claude session tied to no task, for a quick question; listed under Sessions.
      .child(h_flex().id("tk-newsession").mx(12).mt(6).h(30).flex_none().gap(7).items_center().justify_center().rounded(8)
        .bg(t.surface).border_1().border_color(t.input)
        .text_color(t.foreground).text_size(12.5).font_medium().cursor_pointer()
        .hover((x) => x.bg(t.hover))
        .tooltip("A clean Claude session tied to no task, listed under Sessions")
        .on_click(() => this.newLooseSession())
        .child(svg(ICON("comment")).size(13).flex_none())
        .child(div().child("New session")))
      // hogli's output is in the devbox's tab in the (hidden) Devboxes space: a click shows it.
      .when(Boolean(this.creating), (el) => el.child(h_flex().id("tk-creating").px(16).py(4).gap(6).items_center().cursor_pointer()
        .tooltip("Show hogli creating it").on_click((_e, cx) => { this.openDevboxTab(this.creating?.label); cx.notify(); })
        .child(this.icon("spinner", t.working, 11, true))
        .child(div().text_size(11.5).text_color(t.muted).child(`${this.creating.phase} for “${this.creating.name}” on devbox ${this.creating.label}…`))))
      .when(Boolean(this.error), (el) => el.child(div().px(16).py(2).text_size(11).text_color(t.ansi1).child(this.error)))
      .child(this.viewNav(t, tasks))
      .when(this.isHero(), (el) => el.child(this.heroCard(t)))
      // To-dos are off for now (the user's call): todoBar, todosBlock and the "todos" block stay
      // in the code, out of the sidebar. Put this back and the layout block to show them again.
      ));
  }

  // The to-do list, a section of its own that moves like the others.
  todosBlock(t) {
    const open = this.isOpen("todos", false);
    return this.sectionDragRoot(div().size_full().bg(t.chrome).child(this.fitBlock("todos", v_flex().id("tk-todos-block").w_full().flex_none().when(open, (el) => el.pb(4))
      .child(this.sectionHeader(t, "todos", "Todos", { count: this.todos().filter((x) => !x.done).length || null, fallback: false }))
      .when(open, (el) => el.child(this.todoList(t))))));
  }

  // Spaces that aren't tasks, kept out of the way in their own block at the foot of the sidebar:
  // one quiet line, folded unless opened. It only takes a color when something there needs you.
  // The block's height follows what it shows.
  // The foot of the sidebar, above Settings and Add machine: your devboxes and the spaces that
  // aren't tasks, each a section in the one collapsing pattern. Its height follows what's open.
  setupBlock(t, setup, list) {
    const boxes = DEVBOXES_ON || DEVBOX_LIST ? (shared(DEVBOXES) ?? []).filter((b) => b.status !== "deleted") : [];
    const boxError = boxes.length > 0 && this.devboxError ? this.devboxError : null;
    const boxesOpen = this.isOpen("devboxes", true), setupOpen = this.isOpen("setup", false);
    const setupRows = setupOpen ? setup.reduce((n, s) => n + this.sessions(s).length, 0) : 0;
    const archived = shared(ARCHIVE) ?? [];
    const archOpen = this.isOpen("archived", false);
    // Each section's header is 28px, as everywhere in the sidebar; an open list adds its rows and its card.
    const card = (rows) => rows * 28 + CARD_EXTRA;
    const px = (boxes.length ? 28 + (boxesOpen ? card(boxes.length + (boxError ? 1 : 0)) : 0) : 0) + (setup.length ? 28 + (setupOpen ? card(setupRows) + 2 * Math.max(0, setupRows - 1) : 0) : 0)
      + (archived.length ? 28 + (archOpen ? card(Math.min(archived.length, 8)) : 0) : 0);
    if ((boxes.length || setup.length || archived.length) && px !== this.setupPx) {
      this.setupPx = px;
      run("layout.resize", { id: "setup", px });
    }
    const st = this.status(setup.map((s) => s.status).sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0], t);
    const running = boxes.filter((b) => b.status === "running").length;
    return this.sectionDragRoot(v_flex().id("tk-setup").size_full().bg(t.chrome)
      .when(boxes.length > 0, (el) => el
        .child(this.sectionHeader(t, "devboxes", "Devboxes", { count: boxError ? `${boxes.length} · state unknown` : running ? `${running}/${boxes.length} running` : boxes.length,
          badge: boxError || boxes.some((b) => this.devboxOffline(b)) ? this.dot({ color: t.ansi1 }, 6) : null }))
        .when(boxesOpen, (el) => el.child(this.sectionCard(t)
          // Coder unreachable: the states below are the last ones read.
          .when(Boolean(boxError), (el) => el.child(h_flex().h(28).px(8).gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.ansi1).child(boxError))
            .child(this.iconButton(t, "tk-devbox-reload", "refresh", "Read your devboxes again", (cx) => this.loadDevboxes(cx)))))
          .children(boxes.map((b) => this.devboxRow(t, b, Boolean(boxError)))))))
      .when(setup.length > 0, (el) => el
        .child(this.sectionHeader(t, "setup", "Setup", { count: setup.reduce((n, s) => n + this.sessions(s).length, 0), fallback: false,
          badge: st.label === "Needs you" ? this.dot(st, 6) : null,
          actions: this.iconButton(t, "tk-setup-new", "plus", "New Claude session in Setup", (cx) => {
            localStorage.setItem("open:setup", "1");
            run("tab.new", { space: setup[0].id, argv: claudeArgv() });
            this.showWork();
            run("space.select", { id: setup[0].id });
            cx.notify();
          }) }))
        .when(setupOpen, (el) => el.child(this.sectionCard(t).gap(2).children(setup.flatMap((s) => this.setupSpace(t, s, list))))))
      .when(archived.length > 0, (el) => el
        .child(this.sectionHeader(t, "archived", "Archived", { count: archived.length, fallback: false }))
        .when(archOpen, (el) => el.child(this.sectionCard(t)
          .child(v_flex().id("tk-arch-list").max_h(8 * 28).overflow_y_scrollbar()
            .children(archived.map((rec) => this.archivedRow(t, rec))))))));
  }

  // A devbox: its status, and on hover Start or Stop and a new task on it.
  // stale: Coder didn't answer, so b is the last state read (a devbox may have stopped since).
  devboxRow(t, b, stale = false) {
    const hoverKey = `devbox:${b.name}`;
    const busy = this.devboxBusy?.[b.name];
    // Running in Coder but Herdr lost it (a dropped connection): its sessions can't be reached.
    const offline = !stale && this.devboxOffline(b);
    const color = stale ? t.dim : offline ? t.ansi1 : b.status === "running" ? t.ansi2 : ["starting", "stopping", "pending"].includes(b.status) ? t.ansi3 : b.status === "failed" ? t.ansi1 : t.dim;
    const machine = devboxMachine(b.label);
    const tasksHere = spaces().filter((s) => s.machine === machine).length;
    const hasTab = Boolean(this.devboxTab(b.label));
    // A click shows its tab; a running devbox without one gets one, with a shell in it.
    const canOpen = hasTab || b.status === "running";
    return h_flex().id(`tk-devbox-${b.name}`).h(28).px(8).gap(7).items_center().rounded(7)
      .hover((x) => x.bg(t.hover))
      .when(canOpen, (el) => el.cursor_pointer().on_click((_e, cx) => { if (!this.openDevboxTab(b.label)) this.runInDevboxTab(b.label, "ssh", cx); }))
      .on_hover((on, cx) => { this.hovered = on ? hoverKey : this.hovered === hoverKey ? null : this.hovered; cx.notify(); })
      .tooltip(offline ? `${b.name}: Herdr lost its connection; ↻ reconnects` : hasTab ? `${b.name}: click for its tab` : b.status === "running" ? `${b.name}: click for a shell on it` : b.name)
      .child(this.icon("cloud", color, 12))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(b.status === "running" ? t.foreground : t.muted).child(b.label))
      .when(tasksHere > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(plural(tasksHere, "task"))))
      .child(busy ? div().text_size(10.5).text_color(t.muted).child(`${busy}…`)
        : this.hovered === hoverKey ? h_flex().gap(2)
          .when(offline, (el) => el.child(this.iconButton(t, `tk-devbox-reconnect-${b.name}`, "refresh", "Reconnect Herdr to this devbox", (cx) => this.reconnectDevbox(b, cx))))
          .child(b.status === "running"
            ? this.iconButton(t, `tk-devbox-stop-${b.name}`, "x", "Stop this devbox (keeps its disk, stops billing)", (cx) => this.devboxCommand(b, "stop", cx))
            : this.iconButton(t, `tk-devbox-start-${b.name}`, "chevron-right", "Start this devbox", (cx) => this.devboxCommand(b, "start", cx)))
          .child(this.iconButton(t, `tk-devbox-task-${b.name}`, "plus", "New task on this devbox", (cx) => {
            this.openNewTask({ name: b.name, label: b.label });
          }))
        : div().text_size(10.5).text_color(color).child(stale ? `${b.status}?` : offline ? "offline" : b.status));
  }

  // The devbox behind a Herdr machine: { name: its Coder workspace, label }, or null.
  devboxOf(machine) {
    const ws = (shared(TASK_DEVBOXES) ?? {})[machine] ?? (shared(DEVBOXES) ?? []).find((b) => devboxMachine(b.label) === machine)?.name;
    return ws ? { name: ws, label: machine.replace(/^devbox-/, "") } : null;
  }

  devboxOffline(b) {
    const m = machines().find((x) => x.name === devboxMachine(b.label));
    return b.status === "running" && m?.layout === "unavailable";
  }

  // Herdr lost a running devbox. Coder must answer first (no VPN, nothing to do); then reachDevbox
  // gives Herdr's own retry 30 s and, failing that, adds the machine again (its terminals keep running).
  reconnectDevbox(b, cx) {
    this.devboxBusy ??= {};
    this.devboxBusy[b.name] = "reconnecting";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const box = (await this.fetchDevboxes())?.find((x) => x.name === b.name);
        if (!box) throw new Error(this.devboxError ?? `${b.name} isn't in Coder any more.`);
        if (box.status !== "running") throw new Error(`It's ${box.status} in Coder: start it first.`);
        await this.reachDevbox(devboxMachine(b.label), b.name, cx);
        notify({ title: `Devbox ${b.label} reconnected`, body: "Its sessions are back.", level: "success", timeout: 5000 });
      } catch (e) {
        notify({ title: `Couldn't reconnect devbox ${b.label}`, body: String(e?.message ?? e), level: "error", timeout: 10000 });
      } finally {
        delete this.devboxBusy[b.name];
        cx.notify();
      }
    });
  }

  // ---- the Devboxes space: one tab per devbox ----

  devboxSpace() {
    const id = shared(DEVBOX_SPACE);
    return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.named && s.name === DEVBOX_SPACE_NAME) ?? null;
  }

  devboxTab(label) {
    return this.devboxSpace()?.tabs.find((t) => t.named && t.name === label) ?? null;
  }

  // Shows a devbox's tab, as Work shows any tab.
  openDevboxTab(label) {
    const sp = this.devboxSpace(), tab = this.devboxTab(label);
    if (!sp || !tab) return false;
    this.showWork();
    run("space.select", { id: sp.id });
    run("tab.select", { id: tab.id });
    return true;
  }

  // Runs `hogli devbox:<what> <label>` in the devbox's tab: typed into its shell when the tab
  // exists, else in a new tab (its shell stays when hogli is done). The Devboxes space is made
  // on first use. Then that tab shows.
  runInDevboxTab(label, what, cx) {
    const argv = ["bin/hogli", `devbox:${what}`, ...(label === "default" ? [] : [label])];
    const sp = this.devboxSpace(), tab = this.devboxTab(label);
    if (tab) {
      const term = panes().find((x) => x.tab === tab.id && x.terminal)?.terminal;
      if (term) exec("hc", ["send", term, `cd '${POSTHOG()}' && ${argv.join(" ")}`]).catch(() => null);
    } else if (sp) {
      run("tab.new", { space: sp.id, name: label, folder: POSTHOG(), argv });
    } else {
      run("space.new", { name: DEVBOX_SPACE_NAME, tab: label, folder: POSTHOG(), argv });
    }
    cx.timer.after(600, (cx) => { this.openDevboxTab(label); cx.notify(); });
  }

  // Until coder says the devbox is in that state (up to 20 minutes); false if it failed or never got there.
  async waitForDevbox(name, want, cx) {
    for (let i = 0; i < 400; i++) {
      await new Promise((done) => cx.timer.after(3000, () => done()));
      const b = (await this.fetchDevboxes())?.find((x) => x.name === name);
      cx.notify();
      if (b?.status === want) return true;
      if (b?.status === "failed") return false;
    }
    return false;
  }

  devboxCommand(b, what, cx) {
    this.devboxBusy ??= {};
    this.devboxBusy[b.name] = what === "start" ? "starting" : "stopping";
    cx.notify();
    this.runInDevboxTab(b.label, what, cx);
    cx.spawn(async (cx) => {
      await this.waitForDevbox(b.name, what === "start" ? "running" : "stopped", cx);
      delete this.devboxBusy[b.name];
      this.syncDevboxMachines(cx);
      cx.notify();
    });
  }

  // A space that isn't a task: one row and its sessions, no PRs.
  // Setup lists its sessions only: the space that holds them isn't a task, so it has no row.
  setupSpace(t, s, list) {
    const paned = new Set(panes().map((p) => p.terminal).filter(Boolean));
    return this.sessions(s).flatMap((x) => this.sessionRows(t, s, x, list, paned, 8));
  }
}
