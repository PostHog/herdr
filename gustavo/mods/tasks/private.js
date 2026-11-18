// Settings that name PostHog's internal places (the support project and view, the support hero
// schedule, Slack channels and app, your Slack user, your GitHub team), kept out of the repo: data/gustavo/private.json
// in Herdr's folder. loadPrivate() reads it until it has it; PRIVATE holds it after (and `error`
// when it couldn't be read). The parts that need it say so when it's missing.
//
//   { "support": { "project": url, "view": id, "heroSchedule": id, "slackUser": id },
//     "slack": { "app": id, "alerts": { "id", "name" }, "team": { "id", "name" } },
//     "github": { "team": "org/team" } }

import { appHome, readTextFile } from "herdr";

export const PRIVATE_FILE = "data/gustavo/private.json";
export const PRIVATE = {};
let loaded = false;

export async function loadPrivate() {
  if (loaded) return PRIVATE;
  try {
    Object.assign(PRIVATE, JSON.parse((await readTextFile(`${appHome()}/${PRIVATE_FILE}`)) ?? "{}"));
    delete PRIVATE.error;
    loaded = true;
  } catch (e) {
    PRIVATE.error = `Couldn't read ${PRIVATE_FILE}: ${e?.message ?? e}`;
  }
  return PRIVATE;
}
