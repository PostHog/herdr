export function scan(findOutput, repo) {
  const recipes = new Set();
  const layouts = new Map();
  for (const line of findOutput.split("\n")) {
    if (!line.startsWith(`${repo}/`)) continue;
    const parts = line.slice(repo.length + 1).split("/");
    if (parts.length === 2 && parts[1] === "RECIPE.md") recipes.add(parts[0]);
    if (parts.length === 3 && parts[1] === "layouts" && parts[2].endsWith(".json")) {
      layouts.set(parts[0], [...(layouts.get(parts[0]) ?? []), parts[2].slice(0, -5)]);
    }
  }
  return [...recipes].sort().map((name) => ({ name, layouts: layouts.get(name) ?? [] }));
}

export function summaryOf(recipe) {
  const line = recipe.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("!["));
  return line ? line.trim().replace(/\. .*/, ".") : "";
}

export function enabledFrom(text) {
  return new Set((text ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
}

export function plain(text) {
  return (text ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
}

export function reportOf(result) {
  const err = plain(result.stderr).split("\n").filter(Boolean);
  if (result.code !== 0) return { level: "error", text: err.at(-1) ?? `install.sh exited with ${result.code}` };
  const fresh = plain(result.stdout).split("\n").filter((l) => l.startsWith("New: "));
  const lines = [...err, ...fresh];
  return lines.length ? { level: "warn", text: lines.join("\n") } : null;
}
