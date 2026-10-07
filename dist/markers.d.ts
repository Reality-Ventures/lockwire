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
}
/** Scans a markdown document's text for `<!-- lockwire <target> [tiers] [id=<id>] -->` markers. */
export declare function scanMarkers(text: string): DocMarker[];
/**
 * Whether the claim sentence an anchor was stamped against is still the one in the doc. Whitespace
 * and line-wrapping changes don't count. Anchors linked before `normHash` existed fall back to the
 * raw hash, then to the stored excerpt when it holds the whole claim (it isn't truncated).
 */
export declare function claimUnchanged(stored: AnchorClaim, current: DocMarker): boolean;
/** Rewrites a marker line to carry its stamped id, preserving any tier spec already present and whatever precedes the marker (indentation, a BOM). */
export declare function stampMarkerLine(line: string, id: string): string;
//# sourceMappingURL=markers.d.ts.map