/**
 * A lockwire fingerprint: `b3:` + 32 lowercase hex chars — the first 16 bytes
 * (128 bits) of a BLAKE3 digest. 128 bits is far past the collision risk that
 * matters here (we're comparing a few thousand anchors, not defending against
 * an adversary who controls the input), and it keeps `lockwire.lock` compact.
 */
export declare function fingerprint(input: string): string;
/** Hash a sorted-unique string set as a single fingerprint (used for the `deps` tier and the ledger root). */
export declare function fingerprintSet(items: readonly string[]): string;
/** Canonical JSON: sorted keys, no whitespace. Used so ledger event hashes are reproducible across platforms. */
export declare function canonicalJson(value: unknown): string;
//# sourceMappingURL=hash.d.ts.map