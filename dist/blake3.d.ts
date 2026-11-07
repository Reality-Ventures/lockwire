/**
 * BLAKE3, the unkeyed hash, written out so lockwire needs no hashing dependency (Node's crypto has no
 * BLAKE3). Lockfiles written by earlier versions hold BLAKE3 fingerprints, so the hash has to stay
 * the same one; the tests check this against the reference implementation (`@noble/hashes`, a
 * development dependency) over every input length around the chunk and tree boundaries.
 */
/** The first `length` bytes (at most 32) of the BLAKE3 hash of `input`, as lowercase hex. */
export declare function blake3Hex(input: Uint8Array, length?: number): string;
//# sourceMappingURL=blake3.d.ts.map