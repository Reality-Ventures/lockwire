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
export {};
//# sourceMappingURL=changed.d.ts.map