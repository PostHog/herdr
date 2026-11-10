import { exec, run, machines, spaces, panes, readTextFile, appHome } from "herdr";
import { config } from "./config.js";

const PATH_PRELUDE = 'export PATH="$HOME/.local/bin:$PATH";';
const CHECKOUT_PARENTS = ["workspace", "code", "dev", "src", "projects", "repos", "git", "github", "Documents", ""];

export function runnerMachine() {
  return config().runner?.machine || null;
}

export function machineAvailable(machine) {
  if (!machine) return true;
  return machines().some((entry) => entry.name === machine && entry.layout !== "unavailable");
}

export function runOn(machine, script, args = []) {
  return exec("bash", ["-lc", `${PATH_PRELUDE} ${script}`, "prs", ...args], machine ? { on: machine } : {});
}

export const onRunner = (script, args) => runOn(runnerMachine(), script, args);

const homes = new Map();

export async function homeOf(machine) {
  const key = machine ?? "";
  if (!homes.has(key)) {
    const result = await runOn(machine, 'printf %s "$HOME"');
    if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Couldn't reach ${machine ?? "this computer"}.`);
    homes.set(key, result.stdout.trim());
  }
  return homes.get(key);
}

const expandHome = async (path, machine) => (path.startsWith("~") ? path.replace(/^~/, await homeOf(machine)) : path);

const FIND_CHECKOUT = `want="$1"; shift
for d in "$@"; do
  u=$(git -C "$d" remote get-url origin 2>/dev/null) || continue
  case "$u" in *[:/]"$want"|*[:/]"$want".git) git -C "$d" rev-parse --show-toplevel; exit 0;; esac
done
exit 1`;

const checkouts = new Map();

export async function checkoutFor(repo, machine = runnerMachine()) {
  const configured = config().checkouts?.[repo];
  if (configured) return expandHome(configured, machine);
  const key = `${machine ?? ""}|${repo}`;
  if (checkouts.has(key)) return checkouts.get(key);
  const home = await homeOf(machine);
  const name = repo.split("/")[1];
  const candidates = [
    ...new Set([
      ...spaces().filter((space) => (space.machine ?? null) === machine && space.folder).map((space) => space.folder),
      ...CHECKOUT_PARENTS.map((parent) => (parent ? `${home}/${parent}/${name}` : `${home}/${name}`)),
    ]),
  ];
  const result = await runOn(machine, FIND_CHECKOUT, [repo, ...candidates]);
  const found = result.code === 0 && result.stdout.trim() ? result.stdout.trim().split("\n")[0] : `${home}/.herdr-prs/repos/${repo}`;
  checkouts.set(key, found);
  return found;
}

export const forgetCheckouts = () => checkouts.clear();

export async function runsDir(machine = runnerMachine()) {
  return `${await homeOf(machine)}/.herdr-prs/runs`;
}

const assets = new Map();

export async function asset(name) {
  if (!assets.has(name)) assets.set(name, await readTextFile(`${appHome()}/mods/prs/${name}`));
  return assets.get(name) ?? "";
}

const trimSlash = (path) => path.replace(/(.)\/+$/, "$1");

function within(path, root) {
  if (!path || !root) return false;
  const [inner, outer] = [trimSlash(path), trimSlash(root)];
  return inner === outer || inner.startsWith(outer === "/" ? "/" : `${outer}/`);
}

const inPrTree = (path, prefix) => Boolean(path && prefix) && path.startsWith(prefix) && /^\d+(\/|$)/.test(path.slice(prefix.length));

function liveFolder(space) {
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  return panes().find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder;
}

function repoSpace(machine, belongs) {
  const onMachine = spaces().filter((space) => (space.machine ?? null) === machine);
  const inRepo = (space) => belongs(space.folder) || belongs(liveFolder(space));
  return onMachine.find((space) => space.active && inRepo(space)) ?? onMachine.find(inRepo);
}

async function exists(path, machine) {
  return (await runOn(machine, '[ -d "$1" ]', [path])).code === 0;
}

export async function launchTab(name, argv, machine = runnerMachine(), { checkout = null, treePrefix = null } = {}) {
  const cloned = checkout && (await exists(checkout, machine));
  const folder = cloned ? checkout : await homeOf(machine);
  const belongs = (path) => within(path, checkout) || inPrTree(path, treePrefix);
  const space = cloned ? repoSpace(machine, belongs) : spaces().find((candidate) => (candidate.machine ?? null) === machine);
  if (space) run("tab.new", { name, space: space.id, folder, argv });
  else run("space.new", { tab: name, machine: machine ?? "", folder, argv });
}

const PR_WORKTREE_SCRIPT = `set -e
checkout="$1"; repo="$2"; number="$3"; tree="$4"; shift 4
give_up() { echo "$1"; read -r -p "Press Enter to close. " _ || true; exit 1; }
discard() { cd "$checkout"; git worktree remove --force "$tree" || true; git worktree prune; }
marker() { printf '%s/herdr-pr-checked-out' "$(git -C "$tree" rev-parse --absolute-git-dir)"; }
[ -d "$checkout/.git" ] || [ -f "$checkout/.git" ] || gh repo clone "$repo" "$checkout" -- --filter=blob:none
if [ -d "$tree" ] && [ ! -f "$(marker)" ] && ! git -C "$tree" symbolic-ref -q HEAD >/dev/null && [ -z "$(git -C "$tree" status --porcelain)" ]; then
  discard
fi
if [ ! -d "$tree" ]; then
  git -C "$checkout" fetch -q origin
  git -C "$checkout" worktree add -q --detach "$tree" "origin/HEAD"
  cd "$tree"
  gh pr checkout "$number" -R "$repo" || gh pr checkout "$number" -R "$repo" --detach || {
    discard
    give_up "Couldn't check out PR #$number, so its worktree was removed. Try again once GitHub is reachable."
  }
else
  cd "$tree"
  gh pr checkout "$number" -R "$repo" || echo "Kept the worktree as it was: its branch has local work that doesn't fast-forward to the PR head."
fi
touch "$(marker)"
exec claude "$@"`;

export async function launchClaudeOnPr(pr, claudeArgs, tabName) {
  const machine = runnerMachine();
  const home = await homeOf(machine);
  const treePrefix = `${home}/.herdr/worktrees/prs/${pr.repo.replace("/", "-")}-`;
  const tree = `${treePrefix}${pr.number}`;
  const checkout = await checkoutFor(pr.repo, machine);
  const argv = ["bash", "-lc", `${PATH_PRELUDE} ${PR_WORKTREE_SCRIPT}`, "prs", checkout, pr.repo, String(pr.number), tree, ...claudeArgs];
  await launchTab(tabName, argv, machine, { checkout, treePrefix });
  return machine;
}

export async function startHeadless(id, args, machine = runnerMachine()) {
  const runner = await asset("runner.sh");
  const where = machine ? ["--on", machine] : [];
  const result = await exec("hc", ["run", ...where, "--bg", "--json", "--no-parent", "--name", `prs-${id.slice(-8)}`, "--", "bash", "-lc", `${PATH_PRELUDE} ${runner}`, "prs", ...args]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `hc run exited ${result.code}`);
  return JSON.parse(result.stdout).address;
}

export async function readRuns(machine, ids) {
  if (!ids.length) return {};
  const dir = await runsDir(machine);
  const script = `dir="$1"; shift; for id in "$@"; do d="$dir/$id"; printf '%s\\t%s\\t' "$id" "$(cat "$d/status" 2>/dev/null || echo missing)"; tr '\\n' ' ' < "$d/summary" 2>/dev/null; printf '\\n'; done`;
  const result = await runOn(machine, script, [dir, ...ids]);
  const out = {};
  for (const line of result.stdout.split("\n")) {
    const [id, status, summary] = line.split("\t");
    if (id) out[id] = { status, summary: (summary ?? "").trim() };
  }
  return out;
}

export async function readRunFile(machine, id, name) {
  const dir = await runsDir(machine);
  const result = await runOn(machine, 'cat "$1/$2/$3" 2>/dev/null', [dir, id, name]);
  return result.stdout;
}
