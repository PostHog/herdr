import { appHome, readTextFile, writeTextFile, setShared } from "herdr";

const EMPTY = {
  version: 1,
  watched: [],
  hiddenReviews: [],
  filters: [],
  workflows: [],
  loops: [],
  runs: {},
  findings: {},
  lastPrs: {},
  loopState: {},
  workflowLog: [],
};

let cache = null;
let raw = null;

const file = () => `${appHome()}/data/prs-state.json`;

function parse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function loadStore() {
  raw = await readTextFile(file());
  cache = { ...JSON.parse(JSON.stringify(EMPTY)), ...parse(raw) };
  return cache;
}

export function store() {
  return cache ?? EMPTY;
}

export async function updateStore(edit) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await loadStore();
    const next = JSON.parse(JSON.stringify(cache));
    edit(next);
    const text = JSON.stringify(next, null, 2) + "\n";
    try {
      await writeTextFile(file(), text, raw);
      cache = next;
      raw = text;
      setShared("prs.store", Date.now());
      return next;
    } catch {}
  }
  throw new Error("Couldn't save the PR sidebar state; another window kept changing it.");
}

export const prKey = (repo, number) => `${repo}#${number}`;

export function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
