const BOT_LOGINS = new Set([
  "allcontributors",
  "argos-ci",
  "bundlemon",
  "changeset-bot",
  "codecov",
  "codecov-commenter",
  "codspeed-hq",
  "coderabbitai",
  "copilot",
  "copilot-pull-request-reviewer",
  "deepsource-autofix",
  "dependabot",
  "devin-ai-integration",
  "ellipsis-dev",
  "github-actions",
  "github-advanced-security",
  "graphite-app",
  "greptile",
  "greptile-apps",
  "imgbot",
  "lighthouse-ci",
  "max-ai",
  "mergify",
  "netlify",
  "posthog-bot",
  "pre-commit-ci",
  "renovate",
  "semantic-release-bot",
  "sentry-io",
  "size-limit",
  "snyk-bot",
  "socket-security",
  "sonarcloud",
  "sonarqubecloud",
  "sourcery-ai",
  "stamphog",
  "trunk-io",
  "vercel",
]);

const BOT_PATTERNS = [/(^|[-_.])((ci|cd|deploy|build)-?)?bots?$/i, /^bot[-_.]/i, /(^|[-_.])(app|action|actions|ci|cd)$/i];

export const normalizeLogin = (login) => String(login ?? "").trim().replace(/^@/, "").replace(/\[bot\]$/i, "").toLowerCase();

export function isBot(author) {
  if (!author) return false;
  const raw = typeof author === "string" ? author : author.login;
  if (author.__typename === "Bot" || /\[bot\]\s*$/i.test(raw ?? "")) return true;
  const login = normalizeLogin(raw);
  return Boolean(login) && (BOT_LOGINS.has(login) || BOT_PATTERNS.some((pattern) => pattern.test(login)));
}
