import { config, machineLabel } from "./config.js";
import { runOn, checkoutFor } from "./runner.js";
import { graphql, checkCounts } from "./github.js";

export class TrunkUnavailable extends Error {}

export const LISTING_CAP = 10;
const STATES = "Not Ready|Pending Failure|Tests Passed|Pending|Testing|Failed|Cancelled|Merged";
const RETRY_UNAVAILABLE_MS = 5 * 60000;

const strip = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

const TRUNK_SCRIPT = `cd "$1" 2>/dev/null || exit 90
shift
t=$(command -v trunk 2>/dev/null || ls -d .flox/run/*/bin/trunk 2>/dev/null | head -n 1)
[ -n "$t" ] || exit 91
"$t" "$@" 2>&1`;

let unavailable = null;

export const trunkRepo = () => config().trunk?.repo || null;
export const trunkMachine = () => config().trunk?.machine || null;

async function trunk(args) {
  const repo = trunkRepo();
  if (!repo) throw new TrunkUnavailable("Trunk is turned off in Settings.");
  if (unavailable && Date.now() - unavailable.at < RETRY_UNAVAILABLE_MS) throw unavailable.error;
  const machine = trunkMachine();
  const dir = await checkoutFor(repo, machine);
  const result = await runOn(machine, TRUNK_SCRIPT, [dir, ...args]);
  const out = strip(`${result.stdout}${result.stderr}`);
  let error = null;
  if (result.code === 90) error = new TrunkUnavailable(`No ${repo} checkout on ${machineLabel(machine)} (looked for ${dir}). Set its path in Settings.`);
  else if (result.code === 91) error = new TrunkUnavailable(`The Trunk CLI isn't on ${machineLabel(machine)}: not on PATH, and no flox environment in the checkout.`);
  else if (/not logged in|trunk login|unauthenticated/i.test(out)) error = new TrunkUnavailable(`Not logged in to Trunk on ${machineLabel(machine)}. Run \`trunk login\` there.`);
  if (error) {
    unavailable = { error, at: Date.now() };
    throw error;
  }
  unavailable = null;
  return { ...result, out };
}

export const resetTrunk = () => (unavailable = null);

export async function queue() {
  const result = await trunk(["merge", "status", "--no-progress"]);
  const head = result.out.match(/Trunk Merge Status \[(.+?)\] \[(.+?)\]/);
  if (!head) throw new Error(result.out.trim().split("\n").pop() || "trunk merge status failed");
  const items = [];
  const pattern = new RegExp(`(${STATES})\\s+#(\\d+)\\s+(.+?)\\s*$`);
  for (const line of result.out.split("\n")) {
    const match = line.match(pattern);
    if (match) items.push({ state: match[1], number: Number(match[2]), title: match[3] });
  }
  return { branch: head[1], running: head[2], items };
}

export async function queueItem(number) {
  const result = await trunk(["merge", "status", String(number), "--no-progress"]);
  if (/not found/i.test(result.out)) return null;
  const flat = result.out.replace(/\s+/g, " ");
  const year = new Date().getFullYear();
  const steps = [...flat.matchAll(new RegExp(`(\\d\\d)-(\\d\\d) (\\d\\d):(\\d\\d):(\\d\\d)\\S* (?:\\S )?(${STATES})`, "g"))].map((match) => ({
    state: match[6],
    at: Date.UTC(year, Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])),
  }));
  if (!steps.length) throw new Error(result.out.trim().split("\n").pop() || `trunk exited ${result.code}`);
  const testPrs = [...flat.matchAll(/on \[PR (\d+)\]/g)].map((match) => Number(match[1]));
  const last = steps.at(-1);
  return { number, state: last.state, since: last.at, testPr: last.state === "Testing" ? testPrs.at(-1) ?? null : null, steps };
}

export async function testRun(number) {
  const [owner, name] = trunkRepo().split("/");
  const data = await graphql(
    `query($o: String!, $n: String!, $pr: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $pr) { createdAt
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) { totalCount
      checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } } } } }`,
    { o: owner, n: name, pr: number },
  );
  const pr = data.repository.pullRequest;
  return { started: Date.parse(pr.createdAt), checks: checkCounts(pr) };
}

export async function enqueue(number) {
  const result = await trunk(["merge", String(number), "--no-progress"]);
  return { ok: result.code === 0, message: result.out.trim().split("\n").pop() || (result.code === 0 ? "Submitted to Trunk." : `trunk exited ${result.code}`) };
}

export async function dequeue(number) {
  const result = await trunk(["merge", "cancel", String(number), "--no-progress"]);
  return { ok: result.code === 0, message: result.out.trim().split("\n").pop() || (result.code === 0 ? "Removed from the queue." : `trunk exited ${result.code}`) };
}

export async function loadTrunk(prs) {
  const repo = trunkRepo();
  if (!repo) return { available: false, repo: null, error: "Trunk is turned off in Settings." };
  try {
    const listing = await queue();
    const mine = prs.filter((pr) => pr.repo === repo);
    const items = new Map();
    await Promise.all(
      mine.map(async (pr) => {
        try {
          const item = await queueItem(pr.number);
          if (item) items.set(pr.number, item);
        } catch {}
      }),
    );
    const runs = new Map();
    await Promise.all(
      [...items.values()].filter((item) => item.testPr).map(async (item) => {
        try {
          runs.set(item.testPr, await testRun(item.testPr));
        } catch {}
      }),
    );
    return { available: true, repo, error: null, listing, items: Object.fromEntries(items), runs: Object.fromEntries(runs) };
  } catch (error) {
    return { available: !(error instanceof TrunkUnavailable), repo, error: String(error?.message ?? error) };
  }
}
