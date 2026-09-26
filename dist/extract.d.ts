import type { Node } from "web-tree-sitter";
import type { LangId } from "./grammar.js";
import type { FileSymbols } from "./types.js";
/**
 * Walks a parsed file and resolves every top-level function/class, and every method inside
 * each class, into a dotted symbol path ("createSession", "AuthConfig.refresh") with its
 * four tier fingerprints precomputed as raw material (sig string, normalized body, deps set).
 */
export declare function extractFileSymbols(root: Node, lang: LangId, normalizeLocals: boolean): FileSymbols;
export declare function fileExportsFingerprint(symbols: FileSymbols): string;
/** Whole-file tiers for a file-only anchor (no `#Symbol`): same normalization pipeline, applied to the root node. */
export declare function computeWholeFileTiers(root: Node, lang: LangId, normalizeLocals: boolean): {
    bodyNormalized: string;
    deps: string[];
};
//# sourceMappingURL=extract.d.ts.map