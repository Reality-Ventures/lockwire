import type { LockwireConfig } from "./types.js";
/** Timestamp granularity we guard against: HFS+ is 1 s, FAT 2 s. */
export declare const RACY_MS = 2000;
/** Rebuild from scratch at least this often, in case a filesystem didn't keep its mtimes honest. */
export declare const MAX_AGE_MS: number;
export declare const indexPath: (repoRoot: string) => string;
/** What the rest of lockwire needs to know about a marker: enough to classify it and show its claim. */
export interface IndexedMarker {
    line: number;
    target: {
        path: string;
        symbol?: string;
    };
    id: string | null;
    claimExcerpt: string;
}
export interface IndexStats {
    dirsStatted: number;
    dirsRescanned: number;
    docsStatted: number;
    docsRead: number;
    /** Built from scratch (no usable index) rather than refreshed. */
    rebuilt: boolean;
    wrote: boolean;
}
export interface DocIndex {
    /** Every doc the config selects, sorted. Only complete when `complete` is true. */
    docs: string[];
    markersOf(doc: string): IndexedMarker[] | undefined;
    /** False when the time budget ran out: `docs`/`markersOf` are then only what was reached. */
    complete: boolean;
    stats: IndexStats;
}
export interface LoadOptions {
    /** Stop and report `complete: false` after this long. Default: no limit. */
    budgetMs?: number;
    /** Write the refreshed index back. Default true; read-only callers pass false. */
    persist?: boolean;
    /** Ignore any existing index. */
    rebuild?: boolean;
    /** Clock, for tests. */
    now?: () => number;
}
/** Keeps the cache (and hook.log) out of git: `.lockwire/` itself is committed. Never overwrites the user's. */
export declare function ensureLockwireGitignore(repoRoot: string): Promise<void>;
/** Reads (and, unless told not to, refreshes) the doc index for `repoRoot`. Never throws. */
export declare function loadDocIndex(repoRoot: string, config: LockwireConfig, opts?: LoadOptions): Promise<DocIndex>;
//# sourceMappingURL=docindex.d.ts.map