import type { Anchor, AnchorTarget, FileSymbols, LockwireConfig } from "./types.js";
export interface MoveHint {
    /** The one place the code as stamped lives now, when there is exactly one. */
    to?: AnchorTarget;
    /** Every place it was found (more than one means lockwire can't tell which is the claim's). */
    candidates: AnchorTarget[];
}
/**
 * A signature's fingerprints with the `export` modifier as written, removed and added: moving a
 * private helper into a module of its own usually means exporting it, and that is part of the move,
 * not a change to the contract a claim describes.
 */
export declare function sigFingerprints(sig: string): Set<string>;
export type SymbolsOf = (path: string, content: string, version: number) => Promise<FileSymbols | null>;
/**
 * The repository's source files for one run: read once into an index of the identifiers each one
 * contains (not their text, which in a big repository is more than is worth holding), and parsed on
 * demand, only where the name being looked for appears.
 */
export declare class SourceIndex {
    private readonly repoRoot;
    private readonly config;
    private readonly symbolsOf;
    /** A `Date.now()` timestamp to stop at. */
    private readonly deadline;
    private byName;
    private complete;
    private readonly parsed;
    constructor(repoRoot: string, config: LockwireConfig, symbolsOf: SymbolsOf, 
    /** A `Date.now()` timestamp to stop at. */
    deadline?: number);
    private load;
    private read;
    private symbolsIn;
    /**
     * Where `anchor`'s symbol, as stamped, lives now outside `anchor.target.path`, or null when nowhere
     * (or when the search ran out of time before it could be sure).
     */
    findMove(anchor: Anchor, version: number): Promise<MoveHint | null>;
}
//# sourceMappingURL=moves.d.ts.map