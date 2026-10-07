import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
const ALWAYS_SKIP = new Set([".git", "node_modules", ".lockwire"]);
/** Recursively lists repo-relative, posix paths, skipping `.git`/`node_modules`/`.lockwire` and anything matching `exclude`. */
export function walkFiles(repoRoot, exclude = []) {
    const out = [];
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (ALWAYS_SKIP.has(entry.name))
                continue;
            const abs = join(dir, entry.name);
            const rel = toRepoRelative(repoRoot, abs);
            if (matchesAny(rel, exclude))
                continue;
            if (entry.isDirectory())
                walk(abs);
            else
                out.push(rel);
        }
    }
    walk(repoRoot);
    return out;
}
/** Windows editors (and PowerShell's `Out-File`) prepend a UTF-8 BOM that `JSON.parse` rejects. */
export function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
/** Windows delivers hook paths with backslashes even under Git Bash. Normalize before any comparison. */
export function toPosix(p) {
    return p.replace(/\\/g, "/");
}
export function toRepoRelative(repoRoot, absPath) {
    return toPosix(relative(repoRoot, absPath));
}
/**
 * Turns a user-supplied path (`./CLAUDE.md`, `guide.md` typed from `docs/`, an absolute path) into
 * the repo-relative posix form anchors are stored and compared in. Relative inputs resolve against
 * `cwd`. A result starting with `..` means the path is outside the repo.
 */
export function toRepoPath(repoRoot, input, cwd = process.cwd()) {
    return toRepoRelative(repoRoot, resolve(cwd, input));
}
/** Walk up from `startDir` looking for `lockwire.lock` or a `.git` entry; undefined if neither exists above it. */
export function tryFindRepoRoot(startDir) {
    let dir = resolve(startDir);
    while (true) {
        if (existsSync(join(dir, "lockwire.lock")) || existsSync(join(dir, ".git")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
/** Walk up from `startDir` looking for `lockwire.lock`, falling back to a `.git` directory, falling back to `startDir`. */
export function findRepoRoot(startDir) {
    return tryFindRepoRoot(startDir) ?? resolve(startDir);
}
/**
 * A small, dependency-free glob matcher: `**` matches across path separators, `*` matches within
 * one segment. Enough for `config.docs`/`config.exclude` defaults; not a full minimatch replacement.
 */
export function globToRegExp(glob) {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
            i++;
            if (glob[i + 1] === "/") {
                out += "(?:.*/)?"; // `**/` is zero or more whole directories, never part of a segment
                i++;
            }
            else {
                out += ".*";
            }
        }
        else if (c === "*") {
            out += "[^/]*";
        }
        else if (c === "?") {
            out += "[^/]";
        }
        else if (c && ".+^${}()|[]\\".includes(c)) {
            out += `\\${c}`;
        }
        else {
            out += c;
        }
    }
    return new RegExp(`^${out}$`);
}
export function matchesAny(path, globs) {
    return globs.some((g) => globToRegExp(g).test(path));
}
/**
 * Best-effort check of whether `relPath` (repo-relative, no leading slash) would be excluded by
 * the root `.gitignore`. Root-level only -- doesn't walk nested `.gitignore` files, `.git/info/
 * exclude`, or the user's global `core.excludesFile`, since the one caller (the init-time
 * lockwire.lock warning) only ever checks a fixed repo-root filename those can't reach. Later
 * lines override earlier ones (including `!` re-includes), matching git's own precedence.
 */
export function isPathGitignored(repoRoot, relPath) {
    const gitignorePath = join(repoRoot, ".gitignore");
    if (!existsSync(gitignorePath))
        return false;
    let ignored = false;
    for (const raw of readFileSync(gitignorePath, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const negate = line.startsWith("!");
        let pattern = negate ? line.slice(1) : line;
        if (pattern.endsWith("/"))
            continue; // directory-only pattern; relPath is always a file here
        if (pattern.startsWith("/"))
            pattern = pattern.slice(1);
        if (globToRegExp(pattern).test(relPath))
            ignored = !negate;
    }
    return ignored;
}
//# sourceMappingURL=repo.js.map