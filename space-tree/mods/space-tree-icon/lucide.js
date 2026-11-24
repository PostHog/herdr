// Lucide's icons, downloaded once from npm into Herdr's data folder instead of living in
// this repo. The tarball is pinned by version and SHA-256 and checked before it's unpacked.

import { exec, appHome, readTextFile } from "herdr";

const VERSION = "0.460.0";
const TARBALL = `https://registry.npmjs.org/lucide-static/-/lucide-static-${VERSION}.tgz`;
const SHA256 = "24ec818481591e6795c48cd5d8466d1632c02050aa317801c207f91de9747ae4";
export const LUCIDE_DIR = `data/space-tree-icon/lucide-${VERSION}`;
export const iconPath = (name) => `${LUCIDE_DIR}/icons/${name}.svg`;

// Common picks, shown before the rest of Lucide when there's no search.
export const FEATURED = [
  "rocket", "bug", "flask-conical", "test-tube", "microscope", "database", "server", "cloud", "shield", "lock", "key", "zap",
  "flame", "star", "heart", "bookmark", "flag", "target", "compass", "map", "globe", "package", "box", "layers",
  "puzzle", "wrench", "hammer", "cog", "cpu", "terminal", "code-xml", "git-branch", "git-pull-request", "git-merge", "book-open", "file-text",
  "chart-line", "chart-column", "gauge", "activity", "bell", "mail", "message-square", "users", "user", "brain", "sparkles", "wand-sparkles",
  "leaf", "sprout", "tree-pine", "sun", "moon", "coffee", "pizza", "gift", "trophy", "gem", "anchor", "feather",
  "eye", "search", "inbox", "calendar", "clock", "dollar-sign", "credit-card", "shopping-cart", "palette", "image", "music", "camera",
  "smartphone", "monitor", "truck", "plane", "ship", "bike", "house", "building-2", "graduation-cap", "briefcase", "megaphone", "lightbulb",
  "hourglass", "dice-5", "gamepad-2", "ghost", "skull", "cat", "dog", "bird", "fish", "rabbit", "snail",
];

async function sha256(file) {
  const r = await exec("shasum", ["-a", "256", file]);
  if (r.code === 0) return r.stdout.split(/\s/)[0];
  const alt = await exec("sha256sum", [file]);
  return alt.code === 0 ? alt.stdout.split(/\s/)[0] : null;
}

// Lucide's tags by icon name, downloading the package first when it isn't here yet.
export async function loadLucide() {
  const dir = `${appHome()}/${LUCIDE_DIR}`;
  let tags = await readTextFile(`${dir}/tags.json`).catch(() => null);
  if (!tags) {
    const tgz = `${dir}.tgz`;
    await exec("mkdir", ["-p", dir]);
    const got = await exec("curl", ["-fsSL", "--max-time", "60", "-o", tgz, TARBALL]);
    if (got.code !== 0) throw new Error(`Couldn't download Lucide: ${got.stderr.trim() || `curl exited ${got.code}`}`);
    if ((await sha256(tgz)) !== SHA256) {
      await exec("rm", ["-f", tgz]);
      throw new Error("The downloaded Lucide package didn't match its checksum");
    }
    const untar = await exec("tar", ["-xzf", tgz, "-C", dir, "--strip-components", "1", "package/icons", "package/LICENSE", "package/tags.json"]);
    await exec("rm", ["-f", tgz]);
    if (untar.code !== 0) throw new Error(`Couldn't unpack Lucide: ${untar.stderr.trim()}`);
    tags = await readTextFile(`${dir}/tags.json`);
  }
  return JSON.parse(tags);
}
