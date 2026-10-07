export interface WalkResult {
    files: string[];
    /** False when the walk stopped at its deadline, so `files` is only part of the tree. */
    complete: boolean;
}
/** Like {@link walkFiles}, but stops at `deadline` (a `Date.now()` timestamp) and says so. */
export declare function walkFilesWithin(repoRoot: string, exclude: readonly string[], deadline: number): WalkResult;
/** Recursively lists repo-relative, posix paths, skipping `.git`/`node_modules`/`.lockwire` and anything matching `exclude`. */
export declare function walkFiles(repoRoot: string, exclude?: readonly string[]): string[];
/** Windows editors (and PowerShell's `Out-File`) prepend a UTF-8 BOM that `JSON.parse` rejects. */
export declare function stripBom(text: string): string;
/** Windows delivers hook paths with backslashes even under Git Bash. Normalize before any comparison. */
export declare function toPosix(p: string): string;
export declare function toRepoRelative(repoRoot: string, absPath: string): string;
/**
 * Turns a user-supplied path (`./CLAUDE.md`, `guide.md` typed from `docs/`, an absolute path) into
 * the repo-relative posix form anchors are stored and compared in. Relative inputs resolve against
 * `cwd`. A result starting with `..` means the path is outside the repo.
 */
export declare function toRepoPath(repoRoot: string, input: string, cwd?: string): string;
/** Walk up from `startDir` to the nearest folder holding `lockwire.lock` or `.git` (nearest wins, so a stray lockfile in a parent can't capture a nested project); undefined if there is none. */
export declare function tryFindRepoRoot(startDir: string): string | undefined;
/** The nearest `lockwire.lock`/`.git` ancestor of `startDir`, or `startDir` itself. */
export declare function findRepoRoot(startDir: string): string;
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