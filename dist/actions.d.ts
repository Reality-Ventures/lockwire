import type { Actor, Anchor, FileSymbols, Fingerprints, LockwireConfig, Tier } from "./types.js";
export interface TargetResolution {
    found: boolean;
    fingerprints: Fingerprints;
    symbols?: FileSymbols;
}
/** Recomputes all four tier fingerprints for a target, or reports it unresolved (file/symbol not found). */
export declare function resolveTarget(repoRoot: string, target: {
    path: string;
    symbol?: string;
}, config: LockwireConfig): Promise<TargetResolution | null>;
/**
 * Same-file rename detection: if a symbol vanished but exactly one other symbol in the file has the
 * same signature apart from its name, relink to it. `sig` fingerprints include the symbol's name,
 * so each candidate is re-rendered under the missing symbol's old name before comparing -- that
 * keeps stored fingerprints valid. Symbols already bound by another anchor are skipped, so an
 * unrelated neighbour with the same shape isn't mistaken for the rename target. Cross-file
 * relocation (the symbol moved to a different file) is not attempted in P0 — see docs/concepts.md limitations.
 */
export declare function findRelocationCandidate(symbols: FileSymbols, missingSigFp: string, oldName: string, taken?: ReadonlySet<string>): string | null;
export interface LinkResult {
    created: number;
    refreshed: number;
    skipped: {
        reason: string;
        target: string;
    }[];
}
/** Scans a markdown doc for `<!-- lockwire ... -->` markers and creates/refreshes their anchors. */
export declare function linkDoc(repoRoot: string, docPath: string, config: LockwireConfig, actor: Actor, opts?: {
    reviewed?: boolean;
    commit?: string | null;
}): Promise<LinkResult>;
/** `lockwire link <doc> <target>` — a lockfile-only anchor with no inline marker, for whole-doc-to-file bindings. */
export declare function linkLockfileOnly(repoRoot: string, docPath: string, target: {
    path: string;
    symbol?: string;
}, tiers: Tier[], config: LockwireConfig, actor: Actor): Promise<Anchor>;
export interface AnchorCheckResult {
    anchor: Anchor;
    status: Anchor["status"];
    driftedTiers: Tier[];
    singleHashWouldFlag: boolean;
}
export interface CheckSummary {
    anchors: number;
    fresh: number;
    drifted: number;
    relocated: number;
    orphaned: number;
    waived: number;
    superseded: number;
    noise: {
        singleHashWouldFlag: number;
        tieredFlagged: number;
        reductionPercent: number;
    };
}
export interface CheckResult {
    summary: CheckSummary;
    results: AnchorCheckResult[];
}
export declare function check(repoRoot: string, config: LockwireConfig, onlyPaths?: readonly string[]): Promise<CheckResult>;
export declare function discoverDocs(repoRoot: string, config: LockwireConfig): Promise<string[]>;
export declare function ack(repoRoot: string, anchorId: string, resolution: "updated" | "superseded" | "false-positive", note: string | undefined, actor: Actor, config: LockwireConfig): Promise<Anchor>;
export declare function waive(repoRoot: string, anchorId: string, reason: string, expires: string, actor: Actor): Promise<Anchor>;
export declare function unlink(repoRoot: string, anchorId: string): Promise<void>;
export declare function refs(repoRoot: string, path: string, symbol?: string): Promise<Anchor[]>;
export declare function status(repoRoot: string, scope?: string): Promise<Anchor[]>;
export declare function history(repoRoot: string, ref: string): Promise<{
    anchors: Anchor[];
    events: import("./types.js").LedgerRecord[];
}>;
//# sourceMappingURL=actions.d.ts.map