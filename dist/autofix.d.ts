import { type Task } from "./tasks.js";
import type { LedgerRecord } from "./types.js";
export type AgentKind = "claude-code" | "codex";
export interface AutofixOptions {
    /** A built-in agent launcher. */
    agent?: AgentKind;
    /** Or any shell command; it gets LOCKWIRE_PROMPT_FILE, LOCKWIRE_MCP_CONFIG and LOCKWIRE_REPO. */
    agentCommand?: string;
    /** Limit the work to these paths (as `lockwire tasks <paths>`). */
    scope?: string[];
    /** Turn budget for the agent. */
    maxTurns?: number;
    /** Stop the agent after this long. */
    timeoutMs?: number;
    /** Print what would run, and run nothing. */
    dryRun?: boolean;
    /** How the agent should start lockwire's MCP server. Default: this lockwire (`node <cli.js> mcp`). */
    lockwireCommand?: {
        command: string;
        args: string[];
    };
    /** Show the agent's output (default true); tests turn it off. */
    showAgentOutput?: boolean;
    env?: NodeJS.ProcessEnv;
}
export interface AutofixResolution {
    event: LedgerRecord["event"];
    anchor: string;
    doc: string | null;
    target: string;
    claim: string | null;
    note: string | null;
    by: string;
}
export interface AutofixReport {
    /**
     * nothing-to-do: no task, no agent started. fixed: every task is gone. partial: some remain.
     * refused: the agent changed files that aren't documentation, or couldn't be run — don't ship it.
     */
    status: "nothing-to-do" | "fixed" | "partial" | "refused";
    before: Task[];
    after: Task[];
    /** How many of `before` are gone from `after` (new problems the run caused don't offset it). */
    fixed: number;
    /** Why a run was refused, besides out-of-bounds files: the agent committed, edited lockwire's state by hand, ... */
    problems: string[];
    resolutions: AutofixResolution[];
    /** Every file the run changed (repo-relative). */
    changedFiles: string[];
    /** Changed files that are neither docs nor lockwire's own (code, data, config): why a run is refused. */
    outOfBounds: string[];
    agent?: {
        command: string;
        exitCode: number | null;
        error?: string;
    };
    /** A pull-request body: what was fixed, what's left, and anything refused. */
    markdown: string;
}
/** The argv that starts a built-in agent on `prompt`. Exported so the exact flags are tested. */
export declare function agentArgv(agent: AgentKind, prompt: string, files: {
    mcpConfig: string;
}, opts?: {
    maxTurns?: number;
    bare?: boolean;
}): {
    command: string;
    args: string[];
};
/** Claude Code's `--mcp-config` file: lockwire's MCP server, started the way this lockwire runs. */
export declare function mcpConfigJson(lockwire: {
    command: string;
    args: string[];
}): string;
/** Codex's config.toml: lockwire's MCP server, required, its tools approved without prompting. */
export declare function codexConfigToml(lockwire: {
    command: string;
    args: string[];
}): string;
/** How many of the tasks before a run are gone after it. New problems don't offset fixed ones. */
export declare function fixedCount(before: readonly Task[], after: readonly Task[]): number;
export declare function autofix(repoRoot: string, opts?: AutofixOptions): Promise<AutofixReport>;
/** A pull-request body for an autofix run. */
export declare function summaryMarkdown(r: AutofixReport): string;
//# sourceMappingURL=autofix.d.ts.map