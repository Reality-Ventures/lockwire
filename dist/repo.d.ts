/** Recursively lists repo-relative, posix paths, skipping `.git`/`node_modules`/`.lockwire` and anything matching `exclude`. */
export declare function walkFiles(repoRoot: string, exclude?: readonly string[]): string[];
/** Windows delivers hook paths with backslashes even under Git Bash. Normalize before any comparison. */
export declare function toPosix(p: string): string;
export declare function toRepoRelative(repoRoot: string, absPath: string): string;
/** Walk up from `startDir` looking for `lockwire.lock`, falling back to a `.git` directory, falling back to cwd. */
export declare function findRepoRoot(startDir: string): string;
/**
 * A small, dependency-free glob matcher: `**` matches across path separators, `*` matches within
 * one segment. Enough for `config.docs`/`config.exclude` defaults; not a full minimatch replacement.
 */
export declare function globToRegExp(glob: string): RegExp;
export declare function matchesAny(path: string, globs: readonly string[]): boolean;
//# sourceMappingURL=repo.d.ts.map