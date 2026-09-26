import type { Tier } from "./types.js";
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
    claimExcerpt: string;
}
/** Scans a markdown document's text for `<!-- lockwire <target> [tiers] [id=<id>] -->` markers. */
export declare function scanMarkers(text: string): DocMarker[];
/** Rewrites a marker line to carry its stamped id, preserving any tier spec already present. */
export declare function stampMarkerLine(line: string, id: string): string;
//# sourceMappingURL=markers.d.ts.map