import type { Node } from "web-tree-sitter";
import type { LangId } from "./grammar.js";
import type { FileSymbols } from "./types.js";
/**
 * How fingerprints are computed. Anchors record the version they were stamped with, and `check`
 * compares each one under its own version, so changing the extractor never makes an existing anchor
 * look drifted. Version 1 is this file; version 2 is extract-v2.ts.
 */
export declare const FINGERPRINT_VERSION = 2;
/**
 * Walks a parsed file and resolves every top-level function/class, and every method inside
 * each class, into a dotted symbol path ("createSession", "AuthConfig.refresh") with its
 * four tier fingerprints precomputed as raw material (sig string, normalized body, deps set).
 */
export declare function extractFileSymbols(root: Node, lang: LangId, normalizeLocals: boolean, version?: number): FileSymbols;
export declare function fileExportsFingerprint(symbols: FileSymbols): string;
/** Whole-file tiers for a file-only anchor (no `#Symbol`): same normalization pipeline, applied to the root node. */
export declare function computeWholeFileTiers(root: Node, lang: LangId, normalizeLocals: boolean, version?: number): {
    bodyNormalized: string;
    deps: string[];
};
//# sourceMappingURL=extract.d.ts.map