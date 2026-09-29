import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The version a push should publish: `base` (package.json's version) if npm doesn't have it yet,
 * otherwise the next patch above the highest published version on the same major.minor line.
 * Prereleases and other lines are ignored. Run in CI only -- the result is never committed back.
 */
export function nextVersion(base, published) {
  const match = SEMVER.exec(base);
  if (!match) throw new Error(`package.json version "${base}" must be plain x.y.z`);
  if (!published.includes(base)) return base;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const patches = published
    .map((v) => SEMVER.exec(v))
    .filter((m) => m && Number(m[1]) === major && Number(m[2]) === minor)
    .map((m) => Number(m[3]));
  return `${major}.${minor}.${Math.max(...patches) + 1}`;
}

async function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const res = await fetch(`https://registry.npmjs.org/${pkg.name}`, {
    headers: { accept: "application/vnd.npm.install-v1+json", "cache-control": "no-cache" },
  });
  if (res.status !== 404 && !res.ok) throw new Error(`npm registry returned ${res.status}`);
  const published = res.ok ? Object.keys((await res.json()).versions ?? {}) : [];
  console.log(nextVersion(pkg.version, published));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
