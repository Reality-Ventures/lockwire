import { type DocMarker } from "./markers.js";
import type { Actor, Anchor, FileSymbols, Fingerprints, Lockfile, LockwireConfig, Tier } from "./types.js";
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
    /** The claim sentence in the doc was edited (or its marker removed) since the anchor was stamped. */
    claimChanged?: boolean;
    /** Outside the scope of a path-limited run: reported with its stored status, not re-examined. */
    skipped?: boolean;
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
    /** Markers in the scanned docs that no anchor backs: those claims aren't being checked. */
    unlinked: number;
    noise: {
        singleHashWouldFlag: number;
        tieredFlagged: number;
        reductionPercent: number;
    };
}
/** A marker in a doc that isn't backed by an anchor, so the claim under it is not being checked. */
export interface UnlinkedMarker {
    doc: string;
    line: number;
    target: string;
    reason: string;
    /** The claim sentence under the marker, so a reader can see what is being asserted. */
    excerpt: string;
}
export interface CheckResult {
    summary: CheckSummary;
    results: AnchorCheckResult[];
    unlinked: UnlinkedMarker[];
}
/** Whether `path` is a doc the config selects for scanning (`docs`, minus `exclude`, never vendored dirs). */
export declare function isScannedDoc(path: string, config: LockwireConfig): boolean;
/** A cached reader of a doc's markers, or null when the doc doesn't exist. */
export declare function markerReader(repoRoot: string): (doc: string) => Promise<DocMarker[] | null>;
/**
 * Markers in `docs` that no anchor in `lockfile` backs: no `id=` yet, an id that matches no anchor, an
 * id that belongs to the marker in another doc (a copy-paste), or one used twice in a doc. Until
 * `lockwire link` runs, such a claim isn't being checked at all.
 */
export declare function findUnlinkedMarkers(lockfile: Lockfile, docs: readonly string[], readMarkers: (doc: string) => Promise<DocMarker[] | null>): Promise<UnlinkedMarker[]>;
/** Claims written in the docs about this file (or symbol) that no anchor backs. */
export declare function unlinkedFor(repoRoot: string, config: LockwireConfig, path: string, symbol?: string): Promise<UnlinkedMarker[]>;
export declare function check(repoRoot: string, config: LockwireConfig, onlyPaths?: readonly string[], opts?: {
    write?: boolean;
    actor?: Actor;
}): Promise<CheckResult>;
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