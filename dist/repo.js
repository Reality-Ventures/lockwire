import { existsSync, readdirSync } from "node:fs";
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
/** Windows delivers hook paths with backslashes even under Git Bash. Normalize before any comparison. */
export function toPosix(p) {
    return p.replace(/\\/g, "/");
}
export function toRepoRelative(repoRoot, absPath) {
    return toPosix(relative(repoRoot, absPath));
}
/** Walk up from `startDir` looking for `lockwire.lock`, falling back to a `.git` directory, falling back to cwd. */
export function findRepoRoot(startDir) {
    let dir = resolve(startDir);
    while (true) {
        if (existsSync(join(dir, "lockwire.lock")) || existsSync(join(dir, ".git")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return resolve(startDir);
        dir = parent;
    }
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
            out += ".*";
            i++;
            if (glob[i + 1] === "/")
                i++;
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
//# sourceMappingURL=repo.js.map