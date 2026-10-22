import type { AnchorClaim, Tier } from "./types.js";
export interface DocMarker {
    line: number;
    target: {
        path: string;
        symbol?: string;
    };
    tiers: Tier[] | null;
    id: string | null;
    claimLine: number;
    claimHash: string;
    claimNormHash: string;
    claimExcerpt: string;
    /** The whole claim, whitespace-collapsed: what a value anchor's number is checked against. */
    claimText: string;
    /** Why this marker can't be linked as written (an unknown tier, no claim after it), if it can't. */
    problem?: string;
}
/** Scans a markdown document's text for `<!-- lockwire <target> [tiers] [id=<id>] -->` markers. */
export declare function scanMarkers(text: string): DocMarker[];
export declare const EXCERPT_MAX = 90;
/**
 * Whether the claim sentence an anchor was stamped against is still the one in the doc. Whitespace
 * and line-wrapping changes don't count. Anchors linked before `normHash` existed fall back to the
 * raw hash, then to the stored excerpt when it holds the whole claim (it isn't truncated).
 */
export declare function claimUnchanged(stored: AnchorClaim, current: DocMarker): boolean;
/** Rewrites a marker line to carry its stamped id, preserving any tier spec already present and whatever precedes the marker (indentation, a BOM). */
export declare function stampMarkerLine(line: string, id: string): string;
/** Rewrites a marker line's target (`path#Symbol`), keeping its tiers, id and whatever precedes it. */
export declare function retargetMarkerLine(line: string, target: {
    path: string;
    symbol?: string;
}): string;
/**
 * A marker's words: split on whitespace, except that a double-quoted word keeps its spaces — a target
 * like `"results/main.csv#E1 collection S/est"`, whose CSV row key has spaces. `\"` is a literal quote.
 */
export declare function markerTokens(body: string): {
    value: string;
    raw: string;
}[];
/** A target as a marker word: quoted when it has whitespace or quotes in it. */
export declare function quoteTarget(target: string): string;
//# sourceMappingURL=markers.d.ts.map