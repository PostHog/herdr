export function scan(findOutput, repo) {
  const recipes = new Set();
  const layouts = new Map();
  const mods = new Map();
  const add = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const line of findOutput.split("\n")) {
    if (!line.startsWith(`${repo}/`)) continue;
    const parts = line.slice(repo.length + 1).split("/");
    if (parts.length === 2 && parts[1] === "RECIPE.md") recipes.add(parts[0]);
    if (parts.length === 3 && parts[1] === "layouts" && parts[2].endsWith(".json")) add(layouts, parts[0], parts[2].slice(0, -5));
    if (parts.length === 4 && parts[1] === "mods" && parts[3] === "mod.json") add(mods, parts[0], parts[2]);
  }
  return [...recipes].sort().map((name) => ({ name, layouts: (layouts.get(name) ?? []).sort(), mods: (mods.get(name) ?? []).sort() }));
}

// A key binding as Herdr's own hints write it: "cmd-shift-u" is ⌘⇧U on a Mac.
export function keyLabel(keys, mac = true) {
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const parts = keys.endsWith("--") ? [...keys.slice(0, -2).split("-"), "-"] : keys.split("-");
  return parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
}

// The mods a layout tree places, by name.
export function layoutMods(node, found = new Set()) {
  if (node?.content?.mod) found.add(node.content.mod);
  for (const child of node?.children ?? []) layoutMods(child, found);
  return found;
}

// Where a piece shows up for this person, so turning it on never seems to do nothing.
// `shown`: mods the current layout places, or that one of those draws into (a reference to
// `mods/<name>/` in its code). `bindings`: Herdr's `keys()`.
export function placeOf(piece, { layout, shown, bindings, mac = true }) {
  const global = bindings.filter((b) => b.section === "global");
  if (piece.layouts.includes(layout)) return { here: true, text: "Your current layout" };
  if (piece.mods.some((m) => shown.has(m))) return { here: true, text: "Shows in your layout" };
  const key = global.find((b) => piece.mods.some((m) => b.action === `mod.open:${m}` || b.action.startsWith(`${m}.`)));
  if (key) return { here: true, text: `Opens with ${keyLabel(key.keys, mac)}` };
  if (piece.layouts.length) {
    const swap = global.find((b) => b.action === "layout.switch");
    return { here: false, text: `Adds a layout. Switch to it with ${swap ? keyLabel(swap.keys, mac) : "the layout switcher"}` };
  }
  return { here: false, text: "Not in your layout. Its recipe says where to add it" };
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

export function reportOf(result, { keys = true } = {}) {
  const err = plain(result.stderr).split("\n").map((l) => l.trim()).filter(Boolean);
  if (result.code !== 0) {
    const moved = err.slice(0, -1).filter((l) => l.startsWith("moved your "));
    return { level: "error", text: [...moved, err.at(-1) ?? `install.sh exited with ${result.code}`].join("\n") };
  }
  const notes = keys ? err : err.filter((l) => !l.includes("keys.json has key bindings"));
  const fresh = plain(result.stdout).split("\n").filter((l) => l.startsWith("New: "));
  const lines = [...notes, ...fresh];
  return lines.length ? { level: "warn", text: lines.join("\n") } : null;
}
