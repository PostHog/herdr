// A repo's own picture for its space's avatar: the icon its web setup declares
// (a <link rel="icon"> or Gatsby's manifest icon), else the best favicon, touch
// icon or "<repo>-icon" file it tracks. Found files are copied under Herdr's
// home, because Herdr only draws images from there.

import { exec, appHome, readTextFile } from "herdr";

const PICTURE = /\.(svg|png|ico)$/i;
const EXT_SCORE = { svg: 30, png: 20, ico: 10 };
const WEB_ROOTS = /^(public|static|assets|app|images|img|icons)$/;
const NOT_THE_APP = /test|fixture|example|demo|^docs?$|vendor|third.?party|node_modules|stories|^__/;
const NESTED_PROJECT = /^(products|packages|plugins|apps|libs|services|common)$/;
const VARIANT = /dev|16x16|beta|staging|white|black|dark|light|mono|outline/;
const SEARCH = ["*favicon*", "*apple-touch-icon*", "*icon*.svg", "*icon*.png", "*logo.svg", "*logo.png"];
const HTML = ["index.html", "public/index.html", "src/index.html", "app/index.html", "frontend/index.html", "frontend/src/index.html", "frontend/src/layout.html"];
const GATSBY = ["gatsby-config.js", "gatsby-config.ts", "gatsby-config.mjs"];

// Higher is more likely the app's own icon. Declared names win over guesses.
export function score(path, repo, declared) {
  const parts = path.split("/");
  const name = parts.at(-1).toLowerCase();
  if (!PICTURE.test(name)) return -Infinity;
  const stem = name.replace(/\.[^.]+$/, "");
  const short = repo.toLowerCase().split(/[.\-_]/)[0];
  const dirs = parts.slice(0, -1);
  let s = EXT_SCORE[name.split(".").pop()] ?? 0;
  if (declared.has(name)) s += 40;
  if (stem.startsWith("apple-touch-icon")) s += 15;
  else if (stem.startsWith("favicon")) s += 12;
  else if ([`${repo.toLowerCase()}-icon`, `${short}-icon`, "icon", "app-icon"].includes(stem)) s += 14;
  else if (stem === "logo") s += 6;
  if (VARIANT.test(stem)) s -= 8;
  s -= 2 * dirs.length;
  if (dirs.some((d) => WEB_ROOTS.test(d))) s += 5;
  if (dirs.some((d) => NOT_THE_APP.test(d))) s -= 25;
  if (dirs.some((d) => NESTED_PROJECT.test(d))) s -= 15;
  return s;
}

// File names the repo's web setup points at as its icon.
async function declaredNames(root) {
  const names = new Set();
  const add = (href) => {
    const name = href.split(/[?#]/)[0].split("/").pop()?.toLowerCase();
    if (name && PICTURE.test(name)) names.add(name);
  };
  for (const file of GATSBY) {
    const text = await readTextFile(`${root}/${file}`);
    for (const m of text?.matchAll(/\bicon:\s*['"]([^'"]+)['"]/g) ?? []) add(m[1]);
  }
  for (const file of HTML) {
    const text = await readTextFile(`${root}/${file}`);
    for (const link of text?.match(/<link[^>]*>/gi) ?? []) {
      if (!/rel=["'](?:shortcut )?icon["']|rel=["']apple-touch-icon["']/i.test(link)) continue;
      const href = link.match(/href=["']([^"']+)["']/i)?.[1];
      if (href) add(href);
    }
  }
  return names;
}

// The best picture in the repo at `root`, as a path under Herdr's home, or null.
export async function findIcon(root) {
  const repo = root.replace(/\/+$/, "").split("/").pop();
  const declared = await declaredNames(root);
  const specs = [...SEARCH, ...[...declared].map((n) => `*${n}`)];
  const r = await exec("git", ["-C", root, "ls-files", "-z", "--", ...specs], { timeout: 10000 });
  if (r.code !== 0) return null;
  const best = r.stdout.split("\0").filter(Boolean)
    .map((path) => ({ path, s: score(path, repo, declared) }))
    .filter((c) => c.s > 0)
    .sort((a, b) => b.s - a.s || a.path.length - b.path.length)[0];
  if (!best) return null;
  return copyIn(`${root}/${best.path}`);
}

// Copies a picture into Herdr's home under a name from its content, so a changed
// icon gets a new path. An .ico becomes a PNG where macOS's sips can convert it.
async function copyIn(src) {
  const sum = await exec("shasum", ["-a", "1", src]);
  if (sum.code !== 0) return null;
  const hash = sum.stdout.slice(0, 12);
  const ext = src.split(".").pop().toLowerCase();
  const dir = "data/space-tree/icons";
  await exec("mkdir", ["-p", `${appHome()}/${dir}`]);
  if (ext === "ico") {
    const out = `${dir}/${hash}.png`;
    const c = await exec("sips", ["-s", "format", "png", src, "--out", `${appHome()}/${out}`]);
    return c.code === 0 ? out : null;
  }
  const out = `${dir}/${hash}.${ext}`;
  const c = await exec("cp", [src, `${appHome()}/${out}`]);
  return c.code === 0 ? out : null;
}
