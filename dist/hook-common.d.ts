import type { Anchor, LockwireConfig } from "./types.js";
export interface HookInput {
    tool_name?: string;
    tool_input?: {
        file_path?: string;
        old_string?: string;
        content?: string;
        command?: string;
    };
    session_id?: string;
    cwd?: string;
}
export declare function readStdinJson(): Promise<HookInput>;
/**
 * Hooks run with the session's cwd, which may be a folder *above* the repo (e.g. a workspace holding
 * several projects). The edited file is the better signal: walk up from it, then from the hook's
 * reported cwd, and only then fall back to the root derived from the process cwd.
 */
export declare function absoluteHookPath(input: HookInput, filePath: string): string;
export declare function resolveHookRoot(fallbackRoot: string, input: HookInput, absPath: string): string;
/** Windows delivers `C:\project\src\index.ts`; hooks compare against posix, repo-relative anchor targets. */
export declare function normalizeTouchedPath(repoRoot: string, filePath: string): string;
export declare function buildAdvisoryText(anchors: Anchor[], config: LockwireConfig): string;
export declare function claimsForPath(repoRoot: string, touchedPath: string): Promise<Anchor[]>;
export declare function reportDriftFor(repoRoot: string, touchedPath: string): Promise<{
    text: string;
    anyDrift: boolean;
}>;
export declare function logHookError(repoRoot: string, adapter: string, err: unknown): Promise<void>;
//# sourceMappingURL=hook-common.d.ts.map