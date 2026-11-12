// PRs opened by your PostHog cloud tasks (self-driving / inbox runs). A bot opens them, so GitHub can't
// tie them to you; PostHog's tasks API can. Uses the key `posthog-cli login` saves in
// ~/.posthog/credentials.json. Without that file this quietly returns nothing.
import { exec } from "herdr";

// The token never appears in any process's arguments: the shell's printf builtin writes the header to
// curl's standard input, and `-H @-` reads it from there.
const CALL = 'f="$HOME/.posthog/credentials.json"; [ -f "$f" ] || exit 3; '
  + 'host=$(sed -n \'s/.*"host"[^"]*"\\([^"]*\\)".*/\\1/p\' "$f"); '
  + 'printf "Authorization: Bearer %s\\n" "$(sed -n \'s/.*"token"[^"]*"\\([^"]*\\)".*/\\1/p\' "$f")" '
  + '| curl -sf -H @- "${host:-https://us.posthog.com}$1"';

async function api(path) {
  const r = await exec("/bin/sh", ["-c", CALL, "sh", path], { timeout: 30000 }).catch(() => null);
  if (r?.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// [{ url, task, taskUrl }] for your tasks whose latest run has an open or draft PR.
export async function cloudTaskPrs(projectId = 2) {
  const me = await api("/api/users/@me/");
  if (!me?.id) return [];
  const out = [];
  for (const state of ["open", "draft"]) {
    const list = await api(`/api/projects/${projectId}/tasks/?created_by=${me.id}&pr_state=${state}&basic=true&limit=50&archived=all`);
    for (const task of list?.results ?? []) {
      if (!task.latest_run?.id) continue;
      const run = await api(`/api/projects/${projectId}/tasks/${task.id}/runs/${task.latest_run.id}/`);
      for (const url of run?.output?.pr_urls ?? (run?.output?.pr_url ? [run.output.pr_url] : []))
        out.push({ url, task: task.task_number, taskUrl: `https://us.posthog.com/project/${projectId}/tasks/${task.id}` });
    }
  }
  return out;
}
