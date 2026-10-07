import { type UnlinkedMarker } from "./actions.js";
import type { Actor, Anchor, LockwireConfig } from "./types.js";
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
export declare function buildAdvisoryText(anchors: Anchor[], config: LockwireConfig, unlinked?: UnlinkedMarker[]): string;
/** How long the PreToolUse hook may spend looking for unlinked claims before giving up on them. */
export declare const UNLINKED_SCAN_BUDGET_MS = 750;
/**
 * Claims in the docs about the file about to be edited that no anchor backs. Never throws and never
 * blocks the edit: the anchored claims are the hook's job, this is a courtesy on top, so any failure
 * or a blown time budget just means it's left out (and noted in `.lockwire/hook.log`).
 */
export declare function unlinkedClaimsFor(repoRoot: string, config: LockwireConfig, touchedPath: string, adapter: string, budgetMs?: number): Promise<UnlinkedMarker[]>;
export declare function claimsForPath(repoRoot: string, touchedPath: string): Promise<Anchor[]>;
/** The agent that just made the edit, for ledger attribution: the PostToolUse hook runs right after it. */
export declare function hookActor(tool: string, input: HookInput): Actor;
export declare function reportDriftFor(repoRoot: string, touchedPath: string, actor?: Actor): Promise<{
    text: string;
    anyDrift: boolean;
}>;
export declare function logHookError(repoRoot: string, adapter: string, err: unknown): Promise<void>;
//# sourceMappingURL=hook-common.d.ts.map