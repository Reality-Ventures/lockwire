/** Recursively lists repo-relative, posix paths, skipping `.git`/`node_modules`/`.lockwire` and anything matching `exclude`. */
export declare function walkFiles(repoRoot: string, exclude?: readonly string[]): string[];
/** Windows delivers hook paths with backslashes even under Git Bash. Normalize before any comparison. */
export declare function toPosix(p: string): string;
export declare function toRepoRelative(repoRoot: string, absPath: string): string;
/** Walk up from `startDir` looking for `lockwire.lock` or a `.git` entry; undefined if neither exists above it. */
export declare function tryFindRepoRoot(startDir: string): string | undefined;
/** Walk up from `startDir` looking for `lockwire.lock`, falling back to a `.git` directory, falling back to `startDir`. */
export declare function findRepoRoot(startDir: string): string;
/**
 * A small, dependency-free glob matcher: `**` matches across path separators, `*` matches within
 * one segment. Enough for `config.docs`/`config.exclude` defaults; not a full minimatch replacement.
 */
export declare function globToRegExp(glob: string): RegExp;
export declare function matchesAny(path: string, globs: readonly string[]): boolean;
/**
 * Best-effort check of whether `relPath` (repo-relative, no leading slash) would be excluded by
 * the root `.gitignore`. Root-level only -- doesn't walk nested `.gitignore` files, `.git/info/
 * exclude`, or the user's global `core.excludesFile`, since the one caller (the init-time
 * lockwire.lock warning) only ever checks a fixed repo-root filename those can't reach. Later
 * lines override earlier ones (including `!` re-includes), matching git's own precedence.
 */
export declare function isPathGitignored(repoRoot: string, relPath: string): boolean;
//# sourceMappingURL=repo.d.ts.map