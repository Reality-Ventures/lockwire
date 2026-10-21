export interface ChangedOptions {
    /** Ref to diff against. Defaults to GITHUB_BASE_REF in Actions, then the repo's default branch. */
    base?: string;
    /** Only what's staged for the next commit (for a pre-commit hook). */
    staged?: boolean;
}
type Git = (args: string[]) => string;
/** The ref this branch should be compared against, or throws saying how to name one. */
export declare function resolveBase(git: Git, explicit?: string, env?: NodeJS.ProcessEnv): string;
/**
 * Repo-relative posix paths of files this branch changes. Both sides of a rename are listed (`--no-renames`),
 * so an anchor on a file that was moved away is still examined and reports as orphaned.
 */
export declare function changedFiles(repoRoot: string, opts?: ChangedOptions): string[];
/**
 * Short SHA of HEAD in `repoRoot`, or null outside a git repo / before the first commit. Deliberately
 * not cached: a long-lived process (the MCP server) outlives many commits.
 */
export declare function headCommit(repoRoot: string): string | null;
/**
 * The git index, path by path (`<mode> <object> <stage>`), or null outside a git repository. A run that
 * only stages a file still changes what the next `git commit` records, so autofix compares this too.
 */
export declare function indexEntries(repoRoot: string): Map<string, string> | null;
/**
 * A file's text at `commit`, read from git, or null if git, the commit or the file isn't there.
 * `commit` comes from the lockfile, which anyone can edit, so only a plain hex object name is passed
 * to git (anything else could be read as an option); `path` must already be contained in the repo.
 */
export declare function fileAtCommit(repoRoot: string, commit: string, path: string): string | null;
/**
 * Commits that changed `path`: those after `from` (exclusive) when given and known, oldest first —
 * the stamped version is usually committed soon after — otherwise all of them, newest first (the
 * stamped version is usually recent). Capped, since each one is read and parsed.
 */
export declare function commitsTouching(repoRoot: string, path: string, from: string | null, limit?: number): string[];
export {};
//# sourceMappingURL=changed.d.ts.map