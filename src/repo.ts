import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { LockwireConfig } from "./types.js";

const ALWAYS_SKIP = new Set([".git", "node_modules", ".lockwire"]);

/** Whether a directory entry is skipped by every tree walk: vendored/internal dirs, and anything `exclude` matches. */
export function isSkippedEntry(name: string, rel: string, exclude: readonly string[]): boolean {
  return ALWAYS_SKIP.has(name) || matchesAny(rel, exclude);
}

/** Whether `path` is a doc the config selects for scanning (`docs`, minus `exclude`, never vendored dirs). */
export function isScannedDoc(path: string, config: LockwireConfig): boolean {
  return (
    matchesAny(path, config.docs) &&
    !matchesAny(path, config.exclude) &&
    !path.split("/").some((seg) => ALWAYS_SKIP.has(seg))
  );
}

export interface WalkResult {
  files: string[];
  /** False when the walk stopped at its deadline, so `files` is only part of the tree. */
  complete: boolean;
}

/** Like {@link walkFiles}, but stops at `deadline` (a `Date.now()` timestamp) and says so. */
export function walkFilesWithin(
  repoRoot: string,
  exclude: readonly string[],
  deadline: number,
): WalkResult {
  const files: string[] = [];
  let complete = true;
  function walk(dir: string) {
    if (!complete) return;
    if (Date.now() > deadline) {
      complete = false;
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = toRepoRelative(repoRoot, abs);
      if (isSkippedEntry(entry.name, rel, exclude)) continue;
      if (entry.isDirectory()) walk(abs);
      else files.push(rel);
    }
  }
  walk(repoRoot);
  return { files, complete };
}

/** Recursively lists repo-relative, posix paths, skipping `.git`/`node_modules`/`.lockwire` and anything matching `exclude`. */
export function walkFiles(repoRoot: string, exclude: readonly string[] = []): string[] {
  return walkFilesWithin(repoRoot, exclude, Number.POSITIVE_INFINITY).files;
}

/** Windows editors (and PowerShell's `Out-File`) prepend a UTF-8 BOM that `JSON.parse` rejects. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Windows delivers hook paths with backslashes even under Git Bash. Normalize before any comparison. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function toRepoRelative(repoRoot: string, absPath: string): string {
  return toPosix(relative(repoRoot, absPath));
}

/**
 * Turns a user-supplied path (`./CLAUDE.md`, `guide.md` typed from `docs/`, an absolute path) into
 * the repo-relative posix form anchors are stored and compared in. Relative inputs resolve against
 * `cwd`. A result starting with `..` means the path is outside the repo.
 */
export function toRepoPath(repoRoot: string, input: string, cwd: string = process.cwd()): string {
  return toRepoRelative(repoRoot, resolve(cwd, input));
}

/** Walk up from `startDir` to the nearest folder holding `lockwire.lock` or `.git` (nearest wins, so a stray lockfile in a parent can't capture a nested project); undefined if there is none. */
export function tryFindRepoRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, "lockwire.lock")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The nearest `lockwire.lock`/`.git` ancestor of `startDir`, or `startDir` itself. */
export function findRepoRoot(startDir: string): string {
  return tryFindRepoRoot(startDir) ?? resolve(startDir);
}

/**
 * A small, dependency-free glob matcher: `**` matches across path separators, `*` matches within
 * one segment. Enough for `config.docs`/`config.exclude` defaults; not a full minimatch replacement.
 */
function compileGlob(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        out += "(?:.*/)?"; // `**/` is zero or more whole directories, never part of a segment
        i++;
      } else {
        out += ".*";
      }
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c && ".+^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

const compiledGlobs = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = compiledGlobs.get(glob);
  if (!re) {
    re = compileGlob(glob);
    compiledGlobs.set(glob, re);
  }
  return re;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Best-effort check of whether `relPath` (repo-relative, no leading slash) would be excluded by
 * the root `.gitignore`. Root-level only -- doesn't walk nested `.gitignore` files, `.git/info/
 * exclude`, or the user's global `core.excludesFile`, since the one caller (the init-time
 * lockwire.lock warning) only ever checks a fixed repo-root filename those can't reach. Later
 * lines override earlier ones (including `!` re-includes), matching git's own precedence.
 */
export function isPathGitignored(repoRoot: string, relPath: string): boolean {
  const gitignorePath = join(repoRoot, ".gitignore");
  if (!existsSync(gitignorePath)) return false;
  let ignored = false;
  for (const raw of readFileSync(gitignorePath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    let pattern = negate ? line.slice(1) : line;
    if (pattern.endsWith("/")) continue; // directory-only pattern; relPath is always a file here
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (globToRegExp(pattern).test(relPath)) ignored = !negate;
  }
  return ignored;
}
