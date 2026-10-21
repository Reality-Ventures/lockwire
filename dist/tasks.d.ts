import type { Actor, LedgerRecord, LockwireConfig, Tier } from "./types.js";
export type TaskKind = 
/** The code a claim is bound to changed in a tier the claim depends on. */
"code-changed"
/** A value anchor whose sentence no longer states the value. */
 | "value-wrong"
/** A value anchor whose value moved and whose sentence states no number to check. */
 | "value-changed"
/** The claim sentence was edited since it was stamped; the code didn't move. */
 | "claim-edited"
/** The bound symbol, key or file is gone (or outside the repository). */
 | "target-missing"
/** The marker was deleted from the doc. */
 | "marker-removed"
/** A marker no anchor backs: the claim under it isn't being checked at all. */
 | "unlinked";
export interface Task {
    /**
     * An anchor id, or `unlinked:<doc>:<marker line>:<key>` for a marker with no anchor, where `key`
     * is a short hash of the marker's target and claim: a stale id can't land on a different marker.
     */
    id: string;
    kind: TaskKind;
    doc: string | null;
    /** The line of the claim sentence in `doc` (its marker is above it). */
    line: number | null;
    claim: string | null;
    target: string;
    /** One line: what is wrong. */
    summary: string;
    /** What to do, most likely first. */
    resolutions: string[];
}
/**
 * Everything that needs attention, as tasks, in doc order. A dry run: nothing is written. `paths`
 * scopes it the way `check <paths>` does: anchors whose target or doc is one of them, or is inside a
 * listed directory.
 */
export declare function listTasks(repoRoot: string, config: LockwireConfig, paths?: readonly string[]): Promise<Task[]>;
/** A side of the comparison: the bound code (or value) at one point in time. */
export interface TargetSnapshot {
    /** The commit it was read from, for the stamped side. */
    commit?: string | null;
    /** The declaration as written (a symbol), the file (a whole-file anchor), or the value. */
    source: string | null;
    /** True when the code at that commit fingerprints exactly as stamped, so this is what the claim was checked against. */
    exact?: boolean;
    truncated?: boolean;
    /** Why `source` is null, or why it is only approximate. */
    note?: string;
}
export interface TaskContext {
    task: Task;
    /** The whole claim sentence (the task carries an excerpt). */
    claimText: string | null;
    tiers: Tier[];
    /** As stamped. Absent for an unlinked marker, which was never stamped. */
    stamped?: TargetSnapshot;
    now: TargetSnapshot;
    /** This claim's ledger history: how often it broke, and how it was resolved. */
    history: LedgerRecord[];
}
export declare function taskContext(repoRoot: string, config: LockwireConfig, id: string): Promise<TaskContext>;
export interface ResolveOutcome {
    id: string;
    /**
     * resolved: the claim was re-stamped and checks clean. already-fresh: there was nothing to do.
     * refused: nothing was changed; see reason.
     */
    status: "resolved" | "already-fresh" | "refused";
    reason?: string;
    /** For an unlinked marker that was linked: the id it got. */
    anchorId?: string;
    /** What's still open on the same doc after this, so the agent can carry on. */
    remaining: Task[];
}
/**
 * Re-stamp one claim after the agent has fixed it — only that claim, never the rest of its doc. This
 * is the reviewed path (an explicit "I checked this"), recorded in the ledger with the agent's note;
 * a value anchor is still checked against its value and refused if the sentence disagrees. A refusal
 * changes nothing. Runs under the repository lock, so parallel resolves can't lose each other's writes.
 */
export declare function resolveTask(repoRoot: string, config: LockwireConfig, id: string, actor: Actor, note?: string): Promise<ResolveOutcome>;
/**
 * The instructions for an agent working the queue — served as the `fix-docs` MCP prompt and passed
 * to headless agents by `lockwire autofix`, so the two can't drift apart. `scope` is user input and is
 * embedded as a JSON array of strings, never as instructions.
 */
export declare function fixDocsPrompt(scope?: string | readonly string[]): string;
//# sourceMappingURL=tasks.d.ts.map